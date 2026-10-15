//! Limites appliquées à tout parseur de fichier non fiable (ARCHITECTURE.md §7).

/// Taille max ouvrable en mémoire (au-delà : hexa par plages).
pub const MAX_OPEN_BYTES: u64 = 512 * 1024 * 1024;
/// Taille max d'une plage lue par `read_range`.
pub const MAX_RANGE_LEN: u32 = 1024 * 1024;
/// Profondeur max XML/JSON.
pub const MAX_DEPTH: usize = 256;
/// Nombre max d'entrées d'une archive.
pub const MAX_ARCHIVE_ENTRIES: usize = 100_000;
/// Taille décompressée totale max d'une archive.
pub const MAX_UNCOMPRESSED_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// Ratio de décompression max (zip bomb).
pub const MAX_COMPRESSION_RATIO: u64 = 1000;
/// Nombre max de cellules d'un classeur.
pub const MAX_CELLS: usize = 5_000_000;
/// Taille de l'en-tête lu pour la détection.
pub const PROBE_HEAD_BYTES: usize = 8 * 1024;
/// Texte au-delà duquel la lecture seule est proposée.
pub const TEXT_READONLY_BYTES: u64 = 20 * 1024 * 1024;
