//! SQLite : exploration (tables, vues, lignes paginées, requêtes SELECT) et édition à la souris.
//!
//! Lecture : ultra-stricte, le fichier original n'est jamais ouvert en écriture.
//! Écriture : à la première modification, `db_edit_begin` fait un `backup` SQLite de l'original
//! vers une copie de travail temporaire ; toutes les opérations (`db_edit`) ne touchent que cette
//! copie. `db_edit_commit` refuse si l'original a changé entre-temps (mtime/taille, `-wal`), puis
//! sauvegarde la copie vers un fichier voisin de l'original et le substitue par rename atomique
//! (`atomic::replace_with`, sauvegarde de l'original). `db_edit_discard` supprime la copie.
//! Valeurs toujours liées par paramètres ; noms d'objets vérifiés puis quotés.
//!
//! Garanties de non-écriture (lecture sur l'original) :
//! - ouverture `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX` + `PRAGMA query_only=ON` ;
//! - URI `mode=ro&immutable=1` par défaut : SQLite ne prend aucun verrou et ne crée jamais de
//!   `-wal`/`-shm`. Compromis : `immutable` ignore un éventuel journal WAL ; si un `-wal`
//!   non vide existe déjà à côté du fichier, on ouvre en `mode=ro` seul (WAL lu, donnée à jour) ;
//! - `db_query` : une seule instruction, `stmt.readonly()` + autorisateur SQLite qui n'accepte
//!   que SELECT/lectures/fonctions (refuse ATTACH, PRAGMA, transactions…), délai de 5 s.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::{Value, ValueRef};
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
    /// Rowid de chaque ligne si la table est éditable (None : vue, WITHOUT ROWID, requête).
    pub rowids: Option<Vec<DbInt>>,
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
        rowids: None,
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
        let editable = table_kind(conn, &name).is_some_and(|(ty, rowid)| ty == "table" && rowid);
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
            editable,
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

/// Type (`table`, `view`, `virtual`, `shadow`) et présence d'un rowid d'un objet du schéma `main`.
fn table_kind(conn: &Connection, name: &str) -> Option<(String, bool)> {
    conn.query_row(
        "SELECT type, wr FROM pragma_table_list WHERE schema = 'main' AND name = ?1",
        [name],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? == 0)),
    )
    .ok()
}

/// Nom d'accès au rowid (`rowid`, `_rowid_` ou `oid`) non masqué par une vraie colonne.
fn rowid_alias(conn: &Connection, quoted: &str) -> Option<&'static str> {
    let names: Vec<String> = columns_of(conn, quoted)
        .into_iter()
        .map(|c| c.name.to_ascii_lowercase())
        .collect();
    ["rowid", "_rowid_", "oid"]
        .into_iter()
        .find(|a| !names.iter().any(|n| n == a))
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
        .map_err(|_| AppError::Internal)?
}

fn rows_impl(path: &str, table: &str, offset: u32, limit: u32) -> Result<DbResult> {
    let conn = open_ro(Path::new(path))?;
    let quoted = checked_table(&conn, table)?;
    let total = count_rows(&conn, &quoted, COUNT_TIMEOUT);
    set_deadline(&conn, QUERY_TIMEOUT)?;
    let alias = match table_kind(&conn, table) {
        Some((ty, true)) if ty == "table" => rowid_alias(&conn, &quoted),
        _ => None,
    };
    let sql = match alias {
        Some(a) => format!("SELECT {a}, * FROM {quoted} ORDER BY {a} LIMIT ?1 OFFSET ?2"),
        None => format!("SELECT * FROM {quoted} LIMIT ?1 OFFSET ?2"),
    };
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let limit = limit.clamp(1, MAX_PAGE_ROWS);
    let mut res = collect(
        &mut stmt,
        [i64::from(limit), i64::from(offset)],
        limit as usize,
    )?;
    res.total = total;
    if alias.is_some() {
        res.columns.remove(0);
        let mut ids = Vec::with_capacity(res.rows.len());
        for row in &mut res.rows {
            match row.remove(0) {
                DbValue::Int(i) => ids.push(i),
                _ => return Err(AppError::Internal),
            }
        }
        res.rowids = Some(ids);
    }
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

// ---------------------------------------------------------------------------------------------
// Édition : copie de travail + opérations + commit atomique
// ---------------------------------------------------------------------------------------------

const EDIT_TIMEOUT: Duration = Duration::from_secs(30);

/// Valeur saisie : `{type: "null"|"text"|"int"|"real", value}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "value", rename_all = "lowercase")]
pub enum DbInput {
    Null,
    Text(String),
    Int(DbInt),
    Real(f64),
}

/// Colonne d'une nouvelle table.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbColumnDef {
    pub name: String,
    pub col_type: String,
    pub primary_key: bool,
    pub not_null: bool,
}

/// Opération d'édition appliquée à la copie de travail (pas de champ `kind` : collision serde).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum DbEditOp {
    UpdateCell {
        table: String,
        rowid: DbInt,
        column: String,
        value: DbInput,
    },
    InsertRow {
        table: String,
        values: Vec<(String, DbInput)>,
    },
    DeleteRows {
        table: String,
        rowids: Vec<DbInt>,
    },
    AddColumn {
        table: String,
        name: String,
        #[serde(rename = "colType")]
        col_type: String,
        #[serde(rename = "notNull")]
        not_null: bool,
        default: Option<String>,
    },
    RenameColumn {
        table: String,
        from: String,
        to: String,
    },
    DropColumn {
        table: String,
        name: String,
    },
    CreateTable {
        name: String,
        columns: Vec<DbColumnDef>,
    },
    RenameTable {
        from: String,
        to: String,
    },
    DropTable {
        name: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbEditResult {
    /// Rowid de la ligne insérée (`insertRow`).
    pub rowid: Option<DbInt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbEditSession {
    pub id: String,
    /// Chemin de la copie de travail, à passer aux commandes de lecture.
    pub work_path: String,
}

struct WorkCopy {
    orig: PathBuf,
    /// Supprimée du disque à la destruction.
    work: tempfile::TempPath,
    mtime: Option<SystemTime>,
    size: u64,
}

static SESSIONS: Mutex<Option<HashMap<String, WorkCopy>>> = Mutex::new(None);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

fn with_sessions<T>(f: impl FnOnce(&mut HashMap<String, WorkCopy>) -> Result<T>) -> Result<T> {
    let mut guard = SESSIONS.lock().map_err(|_| AppError::Internal)?;
    f(guard.get_or_insert_with(HashMap::new))
}

fn stamp(path: &Path) -> Result<(Option<SystemTime>, u64)> {
    let m = std::fs::metadata(path)?;
    Ok((m.modified().ok(), m.len()))
}

fn begin_impl(path: &str) -> Result<DbEditSession> {
    let orig = PathBuf::from(path);
    let conn = open_ro(&orig)?;
    let (mtime, size) = stamp(&orig)?;
    let work = tempfile::Builder::new()
        .prefix("omnidoc-db-")
        .suffix(".sqlite")
        .tempfile()?
        .into_temp_path();
    conn.backup(rusqlite::MAIN_DB, &work, None)
        .map_err(db_err)?;
    drop(conn);
    let id = format!("dbedit-{}", NEXT_SESSION.fetch_add(1, Ordering::Relaxed));
    let work_path = work.to_string_lossy().into_owned();
    with_sessions(|m| {
        m.insert(
            id.clone(),
            WorkCopy {
                orig,
                work,
                mtime,
                size,
            },
        );
        Ok(())
    })?;
    Ok(DbEditSession { id, work_path })
}

fn work_path_of(session: &str) -> Result<PathBuf> {
    with_sessions(|m| {
        m.get(session)
            .map(|w| w.work.to_path_buf())
            .ok_or(AppError::NotFound)
    })
}

fn open_rw(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(db_err)?;
    conn.pragma_update(None, "trusted_schema", false)
        .map_err(db_err)?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(db_err)?;
    set_deadline(&conn, EDIT_TIMEOUT)?;
    Ok(conn)
}

fn int_of(v: &DbInt) -> Result<i64> {
    match v {
        DbInt::Num(f) if f.fract() == 0.0 && f.abs() <= JS_SAFE_INT as f64 => Ok(*f as i64),
        DbInt::Str(s) => s.trim().parse().map_err(|_| AppError::Invalid(s.clone())),
        DbInt::Num(f) => Err(AppError::Invalid(f.to_string())),
    }
}

fn input_value(v: &DbInput) -> Result<Value> {
    Ok(match v {
        DbInput::Null => Value::Null,
        DbInput::Text(s) => Value::Text(s.clone()),
        DbInput::Int(i) => Value::Integer(int_of(i)?),
        DbInput::Real(f) if f.is_finite() => Value::Real(*f),
        DbInput::Real(f) => return Err(AppError::Invalid(f.to_string())),
    })
}

/// Nom d'objet saisi par l'utilisateur : non vide, sans NUL, hors espace réservé `sqlite_`.
fn valid_name(name: &str) -> Result<()> {
    if name.trim().is_empty()
        || name.contains('\0')
        || name.to_ascii_lowercase().starts_with("sqlite_")
    {
        return Err(AppError::Invalid(name.to_string()));
    }
    Ok(())
}

/// Type de colonne libre : lettres, chiffres, espace, `_`, parenthèses et virgules uniquement.
fn valid_col_type(t: &str) -> Result<&str> {
    let t = t.trim();
    let mut depth = 0i32;
    for c in t.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            c if c.is_alphanumeric() || matches!(c, ' ' | '_' | ',') => {}
            _ => return Err(AppError::Invalid(t.to_string())),
        }
        if depth < 0 {
            return Err(AppError::Invalid(t.to_string()));
        }
    }
    if depth != 0 || t.len() > 64 {
        return Err(AppError::Invalid(t.to_string()));
    }
    Ok(t)
}

/// Littéral SQL sûr pour une valeur par défaut : nombre tel quel, sinon chaîne quotée.
fn default_literal(s: &str) -> String {
    let t = s.trim();
    if let Ok(i) = t.parse::<i64>() {
        return i.to_string();
    }
    if let Ok(f) = t.parse::<f64>() {
        if f.is_finite() {
            return format!("{f:?}");
        }
    }
    format!("'{}'", s.replace('\'', "''"))
}

/// Table ordinaire éditable (pas de vue, table virtuelle ou interne) : nom quoté + présence de rowid.
fn edit_table(conn: &Connection, table: &str) -> Result<(String, bool)> {
    match table_kind(conn, table) {
        Some((ty, rowid))
            if ty == "table" && !table.to_ascii_lowercase().starts_with("sqlite_") =>
        {
            Ok((quote_ident(table), rowid))
        }
        _ => Err(AppError::NotFound),
    }
}

/// Table avec rowid : renvoie le nom quoté et l'alias de rowid utilisable.
fn rowid_table(conn: &Connection, table: &str) -> Result<(String, &'static str)> {
    let (quoted, rowid) = edit_table(conn, table)?;
    if !rowid {
        return Err(AppError::Unsupported);
    }
    let alias = rowid_alias(conn, &quoted).ok_or(AppError::Unsupported)?;
    Ok((quoted, alias))
}

fn checked_column(conn: &Connection, quoted: &str, column: &str) -> Result<String> {
    columns_of(conn, quoted)
        .iter()
        .any(|c| c.name == column)
        .then(|| quote_ident(column))
        .ok_or(AppError::NotFound)
}

fn apply_op(conn: &mut Connection, op: &DbEditOp) -> Result<DbEditResult> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut rowid = None;
    match op {
        DbEditOp::UpdateCell {
            table,
            rowid: id,
            column,
            value,
        } => {
            let (q, alias) = rowid_table(&tx, table)?;
            let col = checked_column(&tx, &q, column)?;
            let n = tx
                .execute(
                    &format!("UPDATE {q} SET {col} = ?1 WHERE {alias} = ?2"),
                    rusqlite::params![input_value(value)?, int_of(id)?],
                )
                .map_err(db_err)?;
            if n != 1 {
                return Err(AppError::NotFound);
            }
        }
        DbEditOp::InsertRow { table, values } => {
            let (q, _) = edit_table(&tx, table)?;
            if values.is_empty() {
                tx.execute(&format!("INSERT INTO {q} DEFAULT VALUES"), [])
                    .map_err(db_err)?;
            } else {
                let mut cols = Vec::new();
                let mut params = Vec::new();
                for (i, (name, _)) in values.iter().enumerate() {
                    cols.push(checked_column(&tx, &q, name)?);
                    params.push(format!("?{}", i + 1));
                }
                let vals = values
                    .iter()
                    .map(|(_, v)| input_value(v))
                    .collect::<Result<Vec<_>>>()?;
                tx.execute(
                    &format!(
                        "INSERT INTO {q} ({}) VALUES ({})",
                        cols.join(", "),
                        params.join(", ")
                    ),
                    rusqlite::params_from_iter(vals),
                )
                .map_err(db_err)?;
            }
            rowid = Some(convert_int(tx.last_insert_rowid()));
        }
        DbEditOp::DeleteRows { table, rowids } => {
            let (q, alias) = rowid_table(&tx, table)?;
            let mut stmt = tx
                .prepare(&format!("DELETE FROM {q} WHERE {alias} = ?1"))
                .map_err(db_err)?;
            for id in rowids {
                stmt.execute([int_of(id)?]).map_err(db_err)?;
            }
        }
        DbEditOp::AddColumn {
            table,
            name,
            col_type,
            not_null,
            default,
        } => {
            valid_name(name)?;
            let (q, _) = edit_table(&tx, table)?;
            let mut sql = format!(
                "ALTER TABLE {q} ADD COLUMN {} {}",
                quote_ident(name),
                valid_col_type(col_type)?
            );
            if *not_null {
                sql.push_str(" NOT NULL");
            }
            if let Some(d) = default.as_deref().filter(|d| !d.is_empty()) {
                sql.push_str(&format!(" DEFAULT {}", default_literal(d)));
            }
            tx.execute(&sql, []).map_err(db_err)?;
        }
        DbEditOp::RenameColumn { table, from, to } => {
            valid_name(to)?;
            let (q, _) = edit_table(&tx, table)?;
            let from = checked_column(&tx, &q, from)?;
            tx.execute(
                &format!(
                    "ALTER TABLE {q} RENAME COLUMN {from} TO {}",
                    quote_ident(to)
                ),
                [],
            )
            .map_err(db_err)?;
        }
        DbEditOp::DropColumn { table, name } => {
            let (q, _) = edit_table(&tx, table)?;
            let col = checked_column(&tx, &q, name)?;
            tx.execute(&format!("ALTER TABLE {q} DROP COLUMN {col}"), [])
                .map_err(db_err)?;
        }
        DbEditOp::CreateTable { name, columns } => {
            valid_name(name)?;
            if columns.is_empty() {
                return Err(AppError::Invalid(name.clone()));
            }
            let pk_count = columns.iter().filter(|c| c.primary_key).count();
            let mut defs = Vec::new();
            for c in columns {
                valid_name(&c.name)?;
                let mut d = quote_ident(&c.name);
                let ty = valid_col_type(&c.col_type)?;
                if !ty.is_empty() {
                    d.push(' ');
                    d.push_str(ty);
                }
                if c.primary_key && pk_count == 1 {
                    d.push_str(" PRIMARY KEY");
                }
                if c.not_null {
                    d.push_str(" NOT NULL");
                }
                defs.push(d);
            }
            if pk_count > 1 {
                let pks: Vec<String> = columns
                    .iter()
                    .filter(|c| c.primary_key)
                    .map(|c| quote_ident(&c.name))
                    .collect();
                defs.push(format!("PRIMARY KEY ({})", pks.join(", ")));
            }
            tx.execute(
                &format!("CREATE TABLE {} ({})", quote_ident(name), defs.join(", ")),
                [],
            )
            .map_err(db_err)?;
        }
        DbEditOp::RenameTable { from, to } => {
            valid_name(to)?;
            let (q, _) = edit_table(&tx, from)?;
            tx.execute(
                &format!("ALTER TABLE {q} RENAME TO {}", quote_ident(to)),
                [],
            )
            .map_err(db_err)?;
        }
        DbEditOp::DropTable { name } => {
            let (q, _) = edit_table(&tx, name)?;
            tx.execute(&format!("DROP TABLE {q}"), []).map_err(db_err)?;
        }
    }
    tx.commit().map_err(db_err)?;
    Ok(DbEditResult { rowid })
}

fn convert_int(i: i64) -> DbInt {
    if (-JS_SAFE_INT..=JS_SAFE_INT).contains(&i) {
        DbInt::Num(i as f64)
    } else {
        DbInt::Str(i.to_string())
    }
}

fn edit_impl(session: &str, op: &DbEditOp) -> Result<DbEditResult> {
    let work = work_path_of(session)?;
    let mut conn = open_rw(&work)?;
    apply_op(&mut conn, op)
}

fn commit_impl(session: &str) -> Result<()> {
    with_sessions(|m| {
        let w = m.get_mut(session).ok_or(AppError::NotFound)?;
        let (mtime, size) = stamp(&w.orig)?;
        if mtime != w.mtime || size != w.size {
            return Err(AppError::Invalid("dbChanged".into()));
        }
        if has_wal(&w.orig) {
            return Err(AppError::Invalid("dbWal".into()));
        }
        let dir = w.orig.parent().unwrap_or_else(|| Path::new("."));
        let tmp = tempfile::Builder::new()
            .prefix(".omnidoc-")
            .suffix(".tmp")
            .tempfile_in(dir)?
            .into_temp_path();
        {
            let src = Connection::open_with_flags(
                &w.work,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(db_err)?;
            src.backup(rusqlite::MAIN_DB, &tmp, None).map_err(db_err)?;
        }
        std::fs::OpenOptions::new()
            .write(true)
            .open(&tmp)?
            .sync_all()?;
        let tmp_path = tmp.keep().map_err(|e| AppError::Io(e.error))?;
        atomic::replace_with(&w.orig, &tmp_path)?;
        (w.mtime, w.size) = stamp(&w.orig)?;
        Ok(())
    })
}

fn discard_impl(session: &str) -> Result<()> {
    with_sessions(|m| {
        m.remove(session);
        Ok(())
    })
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

/// Crée la copie de travail de la base (première modification) et renvoie son chemin.
#[tauri::command]
#[specta::specta]
pub async fn db_edit_begin(path: String) -> Result<DbEditSession> {
    blocking(move || begin_impl(&path)).await
}

/// Applique une opération d'édition à la copie de travail (transaction unique).
#[tauri::command]
#[specta::specta]
pub async fn db_edit(session: String, op: DbEditOp) -> Result<DbEditResult> {
    blocking(move || edit_impl(&session, &op)).await
}

/// Remplace l'original par la copie de travail (refusé si l'original a changé entre-temps).
#[tauri::command]
#[specta::specta]
pub async fn db_edit_commit(session: String) -> Result<()> {
    blocking(move || commit_impl(&session)).await
}

/// Abandonne la session et supprime la copie de travail.
#[tauri::command]
#[specta::specta]
pub async fn db_edit_discard(session: String) -> Result<()> {
    blocking(move || discard_impl(&session)).await
}

/// Liste des tables et vues (rafraîchissement après une modification de structure).
#[tauri::command]
#[specta::specta]
pub async fn db_tables(path: String) -> Result<DbDoc> {
    blocking(move || list_tables(&open_ro(Path::new(&path))?)).await
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

    fn txt(s: &str) -> DbInput {
        DbInput::Text(s.into())
    }

    fn cell(path: &str, table: &str, row: usize, col: usize) -> DbValue {
        rows_impl(path, table, 0, 100).unwrap().rows[row][col].clone()
    }

    #[test]
    fn edit_workflow_on_copy_then_commit() {
        let dir = tempfile::tempdir().unwrap();
        let p = make_db(dir.path());
        let ps = p.to_string_lossy().into_owned();
        let before = hash(&p);

        let s = begin_impl(&ps).unwrap();
        let work = s.work_path.clone();
        assert!(Path::new(&work).is_file());
        let ed = |op: DbEditOp| edit_impl(&s.id, &op).unwrap();

        // rowids exposés pour les tables, pas pour les vues
        let r = rows_impl(&work, "people", 0, 10).unwrap();
        assert_eq!(r.columns.len(), 5);
        assert_eq!(r.rowids.as_ref().unwrap().len(), 3);
        assert_eq!(rows_impl(&work, "v", 0, 10).unwrap().rowids, None);
        assert_eq!(query_impl(&work, "SELECT 1", 10).unwrap().rowids, None);

        ed(DbEditOp::UpdateCell {
            table: "people".into(),
            rowid: DbInt::Num(2.0),
            column: "name".into(),
            value: txt("Zed"),
        });
        assert_eq!(cell(&work, "people", 1, 1), DbValue::Text("Zed".into()));
        // affinité INTEGER : le texte « 42 » devient un entier
        ed(DbEditOp::UpdateCell {
            table: "people".into(),
            rowid: DbInt::Num(2.0),
            column: "big".into(),
            value: txt("42"),
        });
        assert_eq!(cell(&work, "people", 1, 3), DbValue::Int(DbInt::Num(42.0)));
        ed(DbEditOp::UpdateCell {
            table: "people".into(),
            rowid: DbInt::Num(2.0),
            column: "name".into(),
            value: DbInput::Null,
        });
        assert_eq!(cell(&work, "people", 1, 1), DbValue::Null);

        let ins = ed(DbEditOp::InsertRow {
            table: "people".into(),
            values: vec![
                ("id".into(), DbInput::Int(DbInt::Num(10.0))),
                ("name".into(), txt("New")),
            ],
        });
        assert_eq!(ins.rowid, Some(DbInt::Num(10.0)));
        let ins = ed(DbEditOp::InsertRow {
            table: "people".into(),
            values: vec![],
        });
        assert_eq!(ins.rowid, Some(DbInt::Num(11.0)));
        ed(DbEditOp::DeleteRows {
            table: "people".into(),
            rowids: vec![DbInt::Num(1.0), DbInt::Str("3".into())],
        });
        assert_eq!(rows_impl(&work, "people", 0, 10).unwrap().total, Some(3));

        ed(DbEditOp::AddColumn {
            table: "people".into(),
            name: "age".into(),
            col_type: "INTEGER".into(),
            not_null: true,
            default: Some("7".into()),
        });
        ed(DbEditOp::AddColumn {
            table: "people".into(),
            name: "note".into(),
            col_type: "TEXT".into(),
            not_null: false,
            default: Some("it's".into()),
        });
        assert_eq!(cell(&work, "people", 0, 5), DbValue::Int(DbInt::Num(7.0)));
        assert_eq!(cell(&work, "people", 0, 6), DbValue::Text("it's".into()));
        ed(DbEditOp::RenameColumn {
            table: "people".into(),
            from: "age".into(),
            to: "years".into(),
        });
        ed(DbEditOp::DropColumn {
            table: "people".into(),
            name: "note".into(),
        });
        ed(DbEditOp::CreateTable {
            name: "extra".into(),
            columns: vec![
                DbColumnDef {
                    name: "id".into(),
                    col_type: "INTEGER".into(),
                    primary_key: true,
                    not_null: false,
                },
                DbColumnDef {
                    name: "label".into(),
                    col_type: "TEXT".into(),
                    primary_key: false,
                    not_null: true,
                },
            ],
        });
        ed(DbEditOp::RenameTable {
            from: "extra".into(),
            to: "extra2".into(),
        });
        ed(DbEditOp::DropTable {
            name: "we\"ird".into(),
        });
        // erreur de contrainte lisible, cellule inchangée
        assert!(edit_impl(
            &s.id,
            &DbEditOp::InsertRow {
                table: "extra2".into(),
                values: vec![]
            }
        )
        .is_err());

        let conn = open_ro(Path::new(&work)).unwrap();
        let doc = list_tables(&conn).unwrap();
        let names: Vec<&str> = doc.tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["extra2", "people", "v"]);
        assert!(
            doc.tables
                .iter()
                .find(|t| t.name == "people")
                .unwrap()
                .editable
        );
        assert!(!doc.tables.iter().find(|t| t.name == "v").unwrap().editable);
        drop(conn);

        // l'original n'a pas bougé avant le commit
        assert_eq!(before, hash(&p));

        commit_impl(&s.id).unwrap();
        assert_ne!(before, hash(&p));
        let c = rows_impl(&ps, "people", 0, 10).unwrap();
        assert_eq!(c.rows.len(), 3);
        assert!(c.columns.contains(&"years".to_string()));
        assert!(rows_impl(&ps, "extra2", 0, 10).is_ok());
        assert!(rows_impl(&ps, "we\"ird", 0, 10).is_err());
        // session toujours valide : nouvelle modif puis nouveau commit
        edit_impl(
            &s.id,
            &DbEditOp::UpdateCell {
                table: "people".into(),
                rowid: DbInt::Num(10.0),
                column: "name".into(),
                value: txt("Again"),
            },
        )
        .unwrap();
        commit_impl(&s.id).unwrap();
        assert_eq!(
            rows_impl(&ps, "people", 0, 10)
                .unwrap()
                .rows
                .iter()
                .filter(|r| r[1] == DbValue::Text("Again".into()))
                .count(),
            1
        );

        discard_impl(&s.id).unwrap();
        assert!(!Path::new(&work).exists());
        assert!(edit_impl(&s.id, &DbEditOp::DropTable { name: "v".into() }).is_err());
        let mut names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["t.sqlite"]);
    }

    #[test]
    fn commit_refused_when_original_changed() {
        let dir = tempfile::tempdir().unwrap();
        let p = make_db(dir.path());
        let ps = p.to_string_lossy().into_owned();
        let s = begin_impl(&ps).unwrap();
        edit_impl(
            &s.id,
            &DbEditOp::UpdateCell {
                table: "people".into(),
                rowid: DbInt::Num(1.0),
                column: "name".into(),
                value: txt("x"),
            },
        )
        .unwrap();
        let c = Connection::open(&p).unwrap();
        c.execute_batch("INSERT INTO people(id) VALUES (99)")
            .unwrap();
        drop(c);
        let changed = hash(&p);
        assert!(commit_impl(&s.id).is_err());
        assert_eq!(changed, hash(&p));
        discard_impl(&s.id).unwrap();
    }

    #[test]
    fn edit_rejects_injection_views_and_without_rowid() {
        let dir = tempfile::tempdir().unwrap();
        let p = make_db(dir.path());
        let c = Connection::open(&p).unwrap();
        c.execute_batch(
            "CREATE TABLE wr(k TEXT PRIMARY KEY, v) WITHOUT ROWID; INSERT INTO wr VALUES ('a',1);",
        )
        .unwrap();
        drop(c);
        let ps = p.to_string_lossy().into_owned();
        let s = begin_impl(&ps).unwrap();
        let bad = "a\"; DROP TABLE people;--";
        for op in [
            DbEditOp::UpdateCell {
                table: bad.into(),
                rowid: DbInt::Num(1.0),
                column: "name".into(),
                value: DbInput::Null,
            },
            DbEditOp::UpdateCell {
                table: "people".into(),
                rowid: DbInt::Num(1.0),
                column: bad.into(),
                value: DbInput::Null,
            },
            DbEditOp::UpdateCell {
                table: "v".into(),
                rowid: DbInt::Num(1.0),
                column: "name".into(),
                value: DbInput::Null,
            },
            DbEditOp::UpdateCell {
                table: "wr".into(),
                rowid: DbInt::Num(1.0),
                column: "v".into(),
                value: DbInput::Null,
            },
            DbEditOp::DropTable { name: "v".into() },
            DbEditOp::DropTable {
                name: "sqlite_master".into(),
            },
            DbEditOp::AddColumn {
                table: "people".into(),
                name: "c".into(),
                col_type: "TEXT); DROP TABLE people;--".into(),
                not_null: false,
                default: None,
            },
            DbEditOp::RenameTable {
                from: "people".into(),
                to: "sqlite_x".into(),
            },
        ] {
            assert!(edit_impl(&s.id, &op).is_err(), "{op:?}");
        }
        // un nom hostile est simplement un identifiant quoté
        edit_impl(
            &s.id,
            &DbEditOp::RenameColumn {
                table: "people".into(),
                from: "name".into(),
                to: bad.into(),
            },
        )
        .unwrap();
        edit_impl(
            &s.id,
            &DbEditOp::CreateTable {
                name: bad.into(),
                columns: vec![DbColumnDef {
                    name: "a".into(),
                    col_type: "".into(),
                    primary_key: false,
                    not_null: false,
                }],
            },
        )
        .unwrap();
        let r = rows_impl(&s.work_path, "people", 0, 10).unwrap();
        assert_eq!(r.rows.len(), 3);
        assert!(r.columns.contains(&bad.to_string()));
        let wr = rows_impl(&s.work_path, "wr", 0, 10).unwrap();
        assert_eq!(wr.rowids, None);
        assert_eq!(default_literal("12"), "12");
        assert_eq!(default_literal("a'b"), "'a''b'");
        assert_eq!(default_literal("inf"), "'inf'");
        discard_impl(&s.id).unwrap();
    }
}
