#![no_main]

use libfuzzer_sys::fuzz_target;
use omnidoc_lib::formats::richtext::rtf;

fuzz_target!(|data: &[u8]| {
    let _ = rtf::parse(data);
});
