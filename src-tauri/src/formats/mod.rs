//! SEUL endroit qui liste les handlers.

use crate::core::handler::FormatHandler;

pub mod binary;

pub fn all_handlers() -> Vec<Box<dyn FormatHandler>> {
    vec![Box::new(binary::BinaryHandler)]
}
