//! Dump MTEXT entities matching a handle or a text substring, including the
//! layout fields that decide wrapping (rectangle width, attachment, spacing).
//!
//! Usage:
//!   cargo run --release --example mtext_dump -- <file.dwg> <filter>

use acadrust::{CadDocument, DwgReader, EntityType};
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: mtext_dump <dwg> <filter>");
    let filter = std::env::args().nth(2).unwrap_or_default();
    let filter_handle = u64::from_str_radix(filter.trim_start_matches("0x"), 16).ok();
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let mut hits = 0usize;
    for entity in doc.entities() {
        let EntityType::MText(text) = entity else {
            continue;
        };
        let handle = text.common.handle.value();
        let matched = filter.is_empty()
            || filter_handle == Some(handle)
            || text.value.contains(&filter);
        if !matched {
            continue;
        }
        hits += 1;
        println!("handle=0x{handle:X} layer={}", text.common.layer);
        println!("  value={:?}", text.value);
        println!(
            "  insertion=({:.4}, {:.4}, {:.4}) height={:.4} rect_w={:.4} rect_h={:?}",
            text.insertion_point.x,
            text.insertion_point.y,
            text.insertion_point.z,
            text.height,
            text.rectangle_width,
            text.rectangle_height
        );
        println!(
            "  attachment={:?} direction={:?} rotation={:.6} spacing={:.4}/{:?}",
            text.attachment_point,
            text.drawing_direction,
            text.rotation,
            text.line_spacing_factor,
            text.line_spacing_style
        );
        println!(
            "  extents_w={:.4} extents_h={:.4} style={}",
            text.extents_width, text.extents_height, text.style
        );
        println!();
    }
    println!("matched {hits} MTEXT entities");
    Ok(())
}
