#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    omnidoc_fuzz::open_with("vcf", "vcf", data);
});
