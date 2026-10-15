//! SEUL endroit qui liste les handlers.

use crate::core::handler::FormatHandler;

pub mod binary;
pub mod epub;
pub mod notebook;
pub mod slides;
pub mod sqlite;
pub mod zipxml;

pub fn all_handlers() -> Vec<Box<dyn FormatHandler>> {
    vec![
        Box::new(binary::BinaryHandler),
        Box::new(epub::EpubHandler),
        Box::new(notebook::NotebookHandler),
        Box::new(slides::OdpHandler),
        Box::new(slides::PptxHandler),
        Box::new(sqlite::SqliteHandler),
    ]
}
