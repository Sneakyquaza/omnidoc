//! SEUL endroit qui liste les handlers.

use crate::core::handler::FormatHandler;

pub mod binary;
pub mod sheet;

pub fn all_handlers() -> Vec<Box<dyn FormatHandler>> {
    vec![
        Box::new(binary::BinaryHandler),
        Box::new(sheet::csv::CsvHandler::csv()),
        Box::new(sheet::csv::CsvHandler::tsv()),
        Box::new(sheet::xlsx::ExcelHandler::xlsx()),
        Box::new(sheet::xlsx::ExcelHandler::xlsm()),
        Box::new(sheet::xlsx::ExcelHandler::xls()),
        Box::new(sheet::ods::OdsHandler),
    ]
}
