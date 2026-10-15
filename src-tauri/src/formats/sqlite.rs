//! SQLite : exploration en lecture seule (tables, vues, lignes paginées, requêtes SELECT).
//!
//! Garanties de non-écriture :
//! - ouverture `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX` + `PRAGMA query_only=ON` ;
//! - URI `mode=ro&immutable=1` par défaut : SQLite ne prend aucun verrou et ne crée jamais de
//!   `-wal`/`-shm`. Compromis : `immutable` ignore un éventuel journal WAL ; si un `-wal`
//!   non vide existe déjà à côté du fichier, on ouvre en `mode=ro` seul (WAL lu, donnée à jour) ;
//! - `db_query` : une seule instruction, `stmt.readonly()` + autorisateur SQLite qui n'accepte
//!   que SELECT/lectures/fonctions (refuse ATTACH, PRAGMA, transactions…), délai de 5 s.

use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, ErrorCode, OpenFlags};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_OPEN_BYTES;
use crate::core::model::{DbColumn, DbDoc, DbTable, DbTableKind, DocumentModel, ModelKind};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

const MAGIC: &[u8] = b"SQLite format 3\0";
const MAX_PAGE_ROWS: u32 = 1000;
const MAX_TABLES: usize = 10_000;
const COUNT_TIMEOUT: Duration = Duration::from_secs(2);
/// Budget total de comptage à l'ouverture (au-delà, les tables restantes ne sont pas comptées).
const COUNT_TOTAL_BUDGET: Duration = Duration::from_secs(10);
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const EXPORT_TIMEOUT: Duration = Duration::from_secs(120);
const READONLY_PRAGMAS: &[&str] = &[
    "table_info",
    "table_xinfo",
    "table_list",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "database_list",
    "function_list",
    "collation_list",
    "module_list",
    "pragma_list",
    "compile_options",
];
/// Plus grande valeur entière exactement représentable en JS (2^53 - 1).
const JS_SAFE_INT: i64 = 9_007_199_254_740_991;

/// Entier SQLite : nombre si dans la plage sûre JS, sinon chaîne décimale.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum DbInt {
    Num(f64),
    Str(String),
}

/// Valeur de cellule : `{type: "null"|"int"|"real"|"text"|"blob", value}`.
/// Blob : `"<blob N octets> <64 premiers octets en hexa>"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "value", rename_all = "lowercase")]
pub enum DbValue {
    Null,
    Int(DbInt),
    Real(f64),
    Text(String),
    Blob(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<DbValue>>,
    /// Nombre total de lignes si connu (comptage dans le délai imparti).
    pub total: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbSchemaEntry {
    pub name: String,
    pub sql: String,
}

fn db_err(e: rusqlite::Error) -> AppError {
    match e {
        rusqlite::Error::SqliteFailure(f, msg) => match f.code {
            ErrorCode::OperationInterrupted => AppError::Limit("délai dépassé".into()),
            ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt => {
                AppError::Corrupt(msg.unwrap_or_else(|| f.to_string()))
            }
            ErrorCode::AuthorizationForStatementDenied => AppError::Unsupported,
            _ => AppError::External(msg.unwrap_or_else(|| f.to_string())),
        },
        rusqlite::Error::MultipleStatement => AppError::Unsupported,
        other => AppError::External(other.to_string()),
    }
}

fn uri_encode(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn file_uri(path: &Path, query: &str) -> String {
    let mut s = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        s = s.replace('\\', "/");
        if s.as_bytes().get(1) == Some(&b':') {
            s.insert(0, '/');
        }
    }
    format!("file:{}?{query}", uri_encode(&s))
}

fn has_wal(path: &Path) -> bool {
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    std::fs::metadata(wal).map(|m| m.len() > 0).unwrap_or(false)
}

/// Ouvre la base en lecture seule stricte (voir l'en-tête du module).
fn open_ro(path: &Path) -> Result<Connection> {
    if !path.is_file() {
        return Err(AppError::NotFound);
    }
    let query = if has_wal(path) {
        "mode=ro"
    } else {
        "mode=ro&immutable=1"
    };
    let conn = Connection::open_with_flags(
        file_uri(path, query),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(db_err)?;
    conn.pragma_update(None, "query_only", true)
        .map_err(db_err)?;
    // Une vue/trigger malveillant ne peut pas appeler de fonctions « non sûres ».
    conn.pragma_update(None, "trusted_schema", false)
        .map_err(db_err)?;
    let _ = conn.set_limit(
        rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
        256 * 1024 * 1024,
    );
    Ok(conn)
}

fn set_deadline(conn: &Connection, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    conn.progress_handler(1000, Some(move || Instant::now() > deadline))
        .map_err(db_err)
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Vérifie que `table` existe dans sqlite_master (table ou vue) et renvoie son nom quoté.
fn checked_table(conn: &Connection, table: &str) -> Result<String> {
    let found: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
            [table],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(db_err)?;
    found.map(|n| quote_ident(&n)).ok_or(AppError::NotFound)
}

fn count_rows(conn: &Connection, quoted: &str, timeout: Duration) -> Option<u64> {
    set_deadline(conn, timeout).ok()?;
    let n = conn
        .query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |r| {
            r.get::<_, i64>(0)
        })
        .ok();
    let _ = conn.progress_handler(0, None::<fn() -> bool>);
    n.and_then(|n| u64::try_from(n).ok())
}

fn convert(v: ValueRef<'_>) -> DbValue {
    match v {
        ValueRef::Null => DbValue::Null,
        ValueRef::Integer(i) => {
            if (-JS_SAFE_INT..=JS_SAFE_INT).contains(&i) {
                DbValue::Int(DbInt::Num(i as f64))
            } else {
                DbValue::Int(DbInt::Str(i.to_string()))
            }
        }
        ValueRef::Real(f) => {
            if f.is_finite() {
                DbValue::Real(f)
            } else {
                DbValue::Text(f.to_string())
            }
        }
        ValueRef::Text(t) => DbValue::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => {
            let hex: String = b.iter().take(64).map(|x| format!("{x:02x}")).collect();
            DbValue::Blob(format!("<blob {} octets> {hex}", b.len()))
        }
    }
}

fn collect(
    stmt: &mut rusqlite::Statement<'_>,
    params: impl rusqlite::Params,
    limit: usize,
) -> Result<DbResult> {
    let columns: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let n = columns.len();
    let mut rows_out = Vec::new();
    let mut rows = stmt.query(params).map_err(db_err)?;
    while rows_out.len() < limit {
        let Some(row) = rows.next().map_err(db_err)? else {
            break;
        };
        let mut r = Vec::with_capacity(n);
        for i in 0..n {
            r.push(convert(row.get_ref(i).map_err(db_err)?));
        }
        rows_out.push(r);
    }
    Ok(DbResult {
        columns,
        rows: rows_out,
        total: None,
    })
}

fn list_tables(conn: &Connection) -> Result<DbDoc> {
    let mut stmt = conn
        .prepare(
            "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
        )
        .map_err(db_err)?;
    let names: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(db_err)?
        .take(MAX_TABLES)
        .collect::<std::result::Result<_, _>>()
        .map_err(db_err)?;
    let started = Instant::now();
    let mut tables = Vec::with_capacity(names.len());
    for (name, kind) in names {
        let quoted = quote_ident(&name);
        let columns = columns_of(conn, &quoted);
        let count = if started.elapsed() < COUNT_TOTAL_BUDGET {
            count_rows(conn, &quoted, COUNT_TIMEOUT)
        } else {
            None
        };
        tables.push(DbTable {
            name,
            kind: if kind == "view" {
                DbTableKind::View
            } else {
                DbTableKind::Table
            },
            columns,
            row_count: count.unwrap_or(0),
            row_count_exact: count.is_some(),
        });
    }
    Ok(DbDoc { tables })
}

fn columns_of(conn: &Connection, quoted: &str) -> Vec<DbColumn> {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_xinfo({quoted})")) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(6)?,
        ))
    });
    match rows {
        Ok(it) => it
            .flatten()
            .filter(|(_, _, hidden)| *hidden != 1)
            .map(|(name, col_type, _)| DbColumn { name, col_type })
            .collect(),
        Err(_) => Vec::new(),
    }
}

pub struct SqliteHandler;

impl FormatHandler for SqliteHandler {
    fn id(&self) -> &'static str {
        "sqlite"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Database
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["sqlite", "sqlite3", "db", "db3"]
    }

    fn label_key(&self) -> &'static str {
        "formats.sqlite"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        // Les extensions (.db…) sont trop ambiguës : seule la signature compte.
        probe.head.starts_with(MAGIC).then_some(Confidence(95))
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: false,
            export_to: vec![],
            fidelity: Fidelity::ReadOnly,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        let conn = open_ro(path)?;
        Ok(DocumentModel::Database(list_tables(&conn)?))
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::External(e.to_string()))?
}

fn rows_impl(path: &str, table: &str, offset: u32, limit: u32) -> Result<DbResult> {
    let conn = open_ro(Path::new(path))?;
    let quoted = checked_table(&conn, table)?;
    let total = count_rows(&conn, &quoted, COUNT_TIMEOUT);
    set_deadline(&conn, QUERY_TIMEOUT)?;
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {quoted} LIMIT ?1 OFFSET ?2"))
        .map_err(db_err)?;
    let limit = limit.clamp(1, MAX_PAGE_ROWS);
    let mut res = collect(
        &mut stmt,
        [i64::from(limit), i64::from(offset)],
        limit as usize,
    )?;
    res.total = total;
    Ok(res)
}

fn query_impl(path: &str, sql: &str, limit: u32) -> Result<DbResult> {
    let conn = open_ro(Path::new(path))?;
    conn.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Select
        | AuthAction::Read { .. }
        | AuthAction::Function { .. }
        | AuthAction::Recursive => Authorization::Allow,
        // Seuls les PRAGMA d'introspection (sans effet de bord) sont tolérés.
        AuthAction::Pragma { pragma_name, .. } if READONLY_PRAGMAS.contains(&pragma_name) => {
            Authorization::Allow
        }
        _ => Authorization::Deny,
    }))
    .map_err(db_err)?;
    set_deadline(&conn, QUERY_TIMEOUT)?;
    // `prepare` refuse les instructions multiples (MultipleStatement).
    let mut stmt = conn.prepare(sql).map_err(db_err)?;
    if !stmt.readonly() {
        return Err(AppError::Unsupported);
    }
    let limit = limit.clamp(1, MAX_PAGE_ROWS) as usize;
    collect(&mut stmt, [], limit)
}

fn csv_field(out: &mut Vec<u8>, s: &str) {
    if s.contains([',', '"', '\r', '\n']) {
        out.push(b'"');
        out.extend_from_slice(s.replace('"', "\"\"").as_bytes());
        out.push(b'"');
    } else {
        out.extend_from_slice(s.as_bytes());
    }
}

fn export_csv_impl(path: &str, table: &str, dest: &str) -> Result<()> {
    let conn = open_ro(Path::new(path))?;
    let quoted = checked_table(&conn, table)?;
    set_deadline(&conn, EXPORT_TIMEOUT)?;
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {quoted}"))
        .map_err(db_err)?;
    let n = stmt.column_count();
    let mut out: Vec<u8> = Vec::new();
    for (i, name) in stmt.column_names().iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        csv_field(&mut out, name);
    }
    out.extend_from_slice(b"\r\n");
    let mut rows = stmt.query([]).map_err(db_err)?;
    while let Some(row) = rows.next().map_err(db_err)? {
        for i in 0..n {
            if i > 0 {
                out.push(b',');
            }
            match row.get_ref(i).map_err(db_err)? {
                ValueRef::Null => {}
                ValueRef::Integer(v) => out.extend_from_slice(v.to_string().as_bytes()),
                ValueRef::Real(v) => out.extend_from_slice(v.to_string().as_bytes()),
                ValueRef::Text(t) => csv_field(&mut out, &String::from_utf8_lossy(t)),
                ValueRef::Blob(b) => {
                    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
                    out.extend_from_slice(hex.as_bytes());
                }
            }
        }
        out.extend_from_slice(b"\r\n");
        if out.len() as u64 > MAX_OPEN_BYTES {
            return Err(AppError::TooLarge);
        }
    }
    atomic::write(Path::new(dest), &out)
}

fn schema_impl(path: &str) -> Result<Vec<DbSchemaEntry>> {
    let conn = open_ro(Path::new(path))?;
    let mut stmt = conn
        .prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")
        .map_err(db_err)?;
    let v = stmt
        .query_map([], |r| {
            Ok(DbSchemaEntry {
                name: r.get(0)?,
                sql: r.get(1)?,
            })
        })
        .map_err(db_err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(v)
}

/// Lignes paginées d'une table ou vue (`limit` plafonné à 1000).
#[tauri::command]
#[specta::specta]
pub async fn db_rows(path: String, table: String, offset: u32, limit: u32) -> Result<DbResult> {
    blocking(move || rows_impl(&path, &table, offset, limit)).await
}

/// Requête SELECT unique, en lecture seule (délai 5 s, `limit` plafonné à 1000).
#[tauri::command]
#[specta::specta]
pub async fn db_query(path: String, sql: String, limit: u32) -> Result<DbResult> {
    blocking(move || query_impl(&path, &sql, limit)).await
}

/// Exporte une table ou vue en CSV (RFC 4180, CRLF), écriture atomique.
#[tauri::command]
#[specta::specta]
pub async fn db_export_csv(path: String, table: String, dest: String) -> Result<()> {
    blocking(move || export_csv_impl(&path, &table, &dest)).await
}

/// Instructions SQL de création (tables, vues, index, triggers).
#[tauri::command]
#[specta::specta]
pub async fn db_schema(path: String) -> Result<Vec<DbSchemaEntry>> {
    blocking(move || schema_impl(&path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn make_db(dir: &Path) -> PathBuf {
        let p = dir.join("t.sqlite");
        let c = Connection::open(&p).unwrap();
        c.execute_batch(
            "CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, bio BLOB, big INTEGER, score REAL);
             INSERT INTO people VALUES (1,'Ada, \"the\" first',x'00ff10',9223372036854775807,1.5);
             INSERT INTO people VALUES (2,NULL,NULL,5,NULL);
             INSERT INTO people VALUES (3,'Bob',NULL,6,2.0);
             CREATE VIEW v AS SELECT name FROM people WHERE id > 1;
             CREATE TABLE \"we\"\"ird\"(a);",
        )
        .unwrap();
        drop(c);
        p
    }

    fn hash(p: &Path) -> Vec<u8> {
        std::fs::read(p).unwrap()
    }

    #[test]
    fn detects_by_magic_only() {
        let h = SqliteHandler;
        let mut data = MAGIC.to_vec();
        data.extend_from_slice(&[0; 100]);
        assert_eq!(
            h.detect(&FileProbe::from_bytes("a.bin", &data)),
            Some(Confidence(95))
        );
        assert_eq!(h.detect(&FileProbe::from_bytes("a.db", b"hello")), None);
    }

    #[test]
    fn open_rows_query_export_and_source_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let p = make_db(dir.path());
        let before = hash(&p);
        let ps = p.to_string_lossy().into_owned();

        let doc = match SqliteHandler.open(&p).unwrap() {
            DocumentModel::Database(d) => d,
            _ => panic!("modèle inattendu"),
        };
        assert_eq!(doc.tables.len(), 3);
        let people = doc.tables.iter().find(|t| t.name == "people").unwrap();
        assert_eq!((people.row_count, people.row_count_exact), (3, true));
        assert_eq!(people.columns.len(), 5);
        assert_eq!(people.columns[1].col_type, "TEXT");
        let v = doc.tables.iter().find(|t| t.name == "v").unwrap();
        assert_eq!((v.kind, v.row_count), (DbTableKind::View, 2));

        let page = rows_impl(&ps, "people", 1, 1).unwrap();
        assert_eq!((page.rows.len(), page.total), (1, Some(3)));
        assert_eq!(page.rows[0][0], DbValue::Int(DbInt::Num(2.0)));
        let first = rows_impl(&ps, "people", 0, 10).unwrap();
        assert_eq!(
            first.rows[0][3],
            DbValue::Int(DbInt::Str("9223372036854775807".into()))
        );
        assert_eq!(
            first.rows[0][2],
            DbValue::Blob("<blob 3 octets> 00ff10".into())
        );
        assert_eq!(first.rows[0][4], DbValue::Real(1.5));
        assert_eq!(first.rows[1][1], DbValue::Null);
        assert!(rows_impl(&ps, "nope\"; DROP", 0, 10).is_err());
        assert!(rows_impl(&ps, "we\"ird", 0, 10).is_ok());

        let q = query_impl(&ps, "SELECT name FROM people WHERE id = 3;", 10).unwrap();
        assert_eq!(q.rows, vec![vec![DbValue::Text("Bob".into())]]);
        let q = query_impl(&ps, "SELECT * FROM pragma_table_info('people')", 10).unwrap();
        assert_eq!(q.rows.len(), 5);

        for bad in [
            "INSERT INTO people(id) VALUES (9)",
            "ATTACH DATABASE ':memory:' AS x",
            "PRAGMA writable_schema=1",
            "SELECT 1; SELECT 2",
            "DELETE FROM people",
            "CREATE TABLE z(a)",
            "BEGIN",
        ] {
            assert!(query_impl(&ps, bad, 10).is_err(), "{bad}");
        }

        let csv = dir.path().join("out.csv");
        export_csv_impl(&ps, "people", &csv.to_string_lossy()).unwrap();
        let text = std::fs::read_to_string(&csv).unwrap();
        assert!(text.starts_with("id,name,bio,big,score\r\n1,\"Ada, \"\"the\"\" first\",00ff10,"));
        assert!(text.contains("\r\n2,,,5,\r\n"));

        let schema = schema_impl(&ps).unwrap();
        assert!(schema
            .iter()
            .any(|e| e.name == "v" && e.sql.contains("VIEW")));

        assert_eq!(before, hash(&p));
        let mut names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["out.csv", "t.sqlite"]);
    }

    #[test]
    fn corrupt_or_missing_never_panics() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.db");
        assert!(matches!(SqliteHandler.open(&p), Err(AppError::NotFound)));
        std::fs::write(&p, b"this is not a database at all, really not").unwrap();
        assert!(SqliteHandler.open(&p).is_err());
        let good = make_db(dir.path());
        let mut bytes = std::fs::read(&good).unwrap();
        bytes.truncate(100);
        std::fs::write(&p, &bytes).unwrap();
        let _ = SqliteHandler.open(&p);
    }
}
