//! Utilitaires partagés par les cibles de fuzzing qui n'acceptent qu'un chemin.

use std::path::PathBuf;
use std::sync::OnceLock;

use omnidoc_lib::core::registry::Registry;

fn dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let d = std::env::temp_dir().join(format!("omnidoc-fuzz-{}", std::process::id()));
        std::fs::create_dir_all(&d).expect("répertoire temporaire");
        d
    })
}

thread_local! {
    static REGISTRY: Registry = Registry::new();
}

/// libfuzzer-sys installe un hook de panique qui abandonne même pour une panique rattrapée par un
/// `catch_unwind` du code testé. On le neutralise : une panique non rattrapée fait toujours échouer la
/// cible (libfuzzer-sys l'intercepte et abandonne).
fn quiet_panics() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| std::panic::set_hook(Box::new(|_| {})));
}

/// Écrit `data` dans `<tmp>/f.<ext>` et renvoie le chemin (réutilisé à chaque exécution).
pub fn write_temp(ext: &str, data: &[u8]) -> PathBuf {
    quiet_panics();
    let path = dir().join(format!("f.{ext}"));
    std::fs::write(&path, data).expect("écriture du fichier temporaire");
    path
}

/// Ouvre `data` avec le handler `id` (via un fichier temporaire d'extension `ext`).
pub fn open_with(id: &str, ext: &str, data: &[u8]) {
    let path = write_temp(ext, data);
    REGISTRY.with(|r| {
        if let Some(h) = r.get(id) {
            let _ = h.open(&path);
        }
    });
}
