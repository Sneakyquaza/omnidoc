#![no_main]

use libfuzzer_sys::fuzz_target;
use omnidoc_lib::formats::pdf;

fuzz_target!(|data: &[u8]| {
    omnidoc_fuzz::open_with("pdf", "pdf", data);
    let path = omnidoc_fuzz::write_temp("pdf", data);
    let _ = pdf::list_annotations(&path);
});
