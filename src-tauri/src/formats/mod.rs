//! SEUL endroit qui liste les handlers.

use crate::core::handler::FormatHandler;

pub mod binary;
pub mod records;
pub mod text;

pub fn all_handlers() -> Vec<Box<dyn FormatHandler>> {
    vec![
        Box::new(binary::BinaryHandler),
        Box::new(text::TextHandler),
        Box::new(text::MarkdownHandler),
        Box::new(records::RecordsHandler::ics()),
        Box::new(records::RecordsHandler::vcf()),
    ]
}
