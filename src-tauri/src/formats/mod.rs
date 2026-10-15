//! SEUL endroit qui liste les handlers.

use crate::core::handler::FormatHandler;

pub mod binary;
pub mod records;
pub mod text;
pub mod image;
pub mod pdf;
pub mod svg;
pub mod sheet;

pub fn all_handlers() -> Vec<Box<dyn FormatHandler>> {
    vec![
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
    ]
}
