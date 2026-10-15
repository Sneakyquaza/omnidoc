//! SEUL endroit qui liste les handlers.

use crate::core::handler::FormatHandler;

pub mod binary;
pub mod image;
pub mod pdf;
pub mod svg;

pub fn all_handlers() -> Vec<Box<dyn FormatHandler>> {
    vec![
        Box::new(binary::BinaryHandler),
        Box::new(image::ImageHandler),
        Box::new(svg::SvgHandler),
        Box::new(pdf::PdfHandler),
    ]
}
