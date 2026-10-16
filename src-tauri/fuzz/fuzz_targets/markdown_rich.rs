#![no_main]

use libfuzzer_sys::fuzz_target;
use omnidoc_lib::formats::richtext::markdown;

fuzz_target!(|data: &[u8]| {
    if let Ok(doc) = markdown::parse(data) {
        let _ = markdown::serialize(&doc);
    }
});
