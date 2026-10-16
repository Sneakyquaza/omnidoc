#![no_main]

use libfuzzer_sys::fuzz_target;
use omnidoc_lib::core::model::RecordsKind;
use omnidoc_lib::formats::records;

fuzz_target!(|data: &[u8]| {
    for kind in [RecordsKind::Ics, RecordsKind::Vcf] {
        if let Ok(doc) = records::parse(data, kind) {
            let _ = records::serialize(&doc);
        }
    }
});
