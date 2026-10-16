#![no_main]

use libfuzzer_sys::fuzz_target;

const EXTS: &[&str] = &["png", "jpg", "gif", "bmp", "webp", "tiff", "ico"];

// Le premier octet choisit l'extension (le reste est le contenu du fichier).
fuzz_target!(|data: &[u8]| {
    let Some((first, rest)) = data.split_first() else {
        return;
    };
    omnidoc_fuzz::open_with("image", EXTS[*first as usize % EXTS.len()], rest);
});
