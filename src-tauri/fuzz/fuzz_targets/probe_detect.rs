#![no_main]

use libfuzzer_sys::fuzz_target;
use omnidoc_lib::core::probe::FileProbe;
use omnidoc_lib::core::registry::Registry;

const NAMES: &[&str] = &[
    "f.bin", "f.txt", "f.md", "f.docx", "f.odt", "f.rtf", "f.csv", "f.xlsx", "f.ods", "f.pdf",
    "f.png", "f.svg", "f.zip", "f.tar", "f.gz", "f.7z", "f.mp3", "f.sqlite", "f.epub", "f.ipynb",
    "f.pptx", "f.ics", "f.vcf", "noext",
];

thread_local! {
    static REGISTRY: Registry = Registry::new();
}

fuzz_target!(|data: &[u8]| {
    let Some((first, rest)) = data.split_first() else {
        return;
    };
    let name = NAMES[*first as usize % NAMES.len()];
    let probe = FileProbe::from_bytes(name, rest);
    REGISTRY.with(|r| {
        let _ = r.detect(&probe);
    });
});
