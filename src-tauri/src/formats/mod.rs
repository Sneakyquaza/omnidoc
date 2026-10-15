//! SEUL endroit qui liste les handlers.

use crate::core::handler::FormatHandler;

pub mod binary;
pub mod richtext;

pub fn all_handlers() -> Vec<Box<dyn FormatHandler>> {
    vec![
        Box::new(binary::BinaryHandler),
        Box::new(richtext::docx::DocxHandler),
        Box::new(richtext::odt::OdtHandler),
        Box::new(richtext::markdown::MarkdownRichHandler),
        Box::new(richtext::html::HtmlHandler),
        Box::new(richtext::rtf::RtfHandler),
    ]
}
