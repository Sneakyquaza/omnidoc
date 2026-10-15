//! SEUL endroit qui liste les handlers.

use crate::core::handler::FormatHandler;

pub mod archive;
pub mod binary;
pub mod epub;
pub mod image;
pub mod media;
pub mod notebook;
pub mod pdf;
pub mod records;
pub mod sheet;
pub mod slides;
pub mod sqlite;
pub mod svg;
pub mod text;
pub mod zipxml;

pub fn all_handlers() -> Vec<Box<dyn FormatHandler>> {
    let mut handlers: Vec<Box<dyn FormatHandler>> = vec![
        Box::new(binary::BinaryHandler),
        Box::new(text::TextHandler),
        Box::new(text::MarkdownHandler),
        Box::new(records::RecordsHandler::ics()),
        Box::new(records::RecordsHandler::vcf()),
        Box::new(image::ImageHandler),
        Box::new(svg::SvgHandler),
        Box::new(pdf::PdfHandler),
        Box::new(sheet::csv::CsvHandler::csv()),
        Box::new(sheet::csv::CsvHandler::tsv()),
        Box::new(sheet::xlsx::ExcelHandler::xlsx()),
        Box::new(sheet::xlsx::ExcelHandler::xlsm()),
        Box::new(sheet::xlsx::ExcelHandler::xls()),
        Box::new(sheet::ods::OdsHandler),
        Box::new(epub::EpubHandler),
        Box::new(notebook::NotebookHandler),
        Box::new(slides::OdpHandler),
        Box::new(slides::PptxHandler),
        Box::new(sqlite::SqliteHandler),
        Box::new(media::MediaHandler),
    ];
    handlers.extend(archive::handlers());
    handlers
}
