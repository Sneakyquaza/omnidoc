#![no_main]

use libfuzzer_sys::fuzz_target;
use omnidoc_lib::formats::sheet::csv;

fuzz_target!(|data: &[u8]| {
    for forced in [None, Some(b';'), Some(b'\t'), Some(b',')] {
        let _ = csv::parse(data, forced, "fuzz.csv");
    }
});
