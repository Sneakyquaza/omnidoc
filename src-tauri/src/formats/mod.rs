//! SEUL endroit qui liste les handlers.

use crate::core::handler::FormatHandler;

pub mod archive;
pub mod binary;
pub mod media;

pub fn all_handlers() -> Vec<Box<dyn FormatHandler>> {
    let mut handlers: Vec<Box<dyn FormatHandler>> = vec![Box::new(binary::BinaryHandler)];
    handlers.extend(archive::handlers());
    handlers.push(Box::new(media::MediaHandler));
    handlers
}
