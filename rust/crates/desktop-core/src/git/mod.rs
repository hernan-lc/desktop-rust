//! Rust port of `app/src/lib/git/**` (71 TypeScript files).
//!
//! Desktop shells out to its bundled git through dugite rather than linking
//! libgit2, so the port keeps that architecture: [`core::GitEngine`] owns the
//! process + environment, and each module reconstructs the same porcelain
//! commands and parsers.

pub mod core;
pub mod diff;
pub mod log;
pub mod operations;
pub mod refs;
pub mod status;

pub use core::{GitEngine, GitOptions, GitOutput};
pub use status::get_status;
