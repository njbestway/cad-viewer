//! Dump the drawing-wide scale variables. CADSee reports 265.8228 for a
//! `TCH_TEXT` whose stored height is 3.5, i.e. a ratio of ~75.95; if that ratio
//! lives in the header or a dimension style we can apply it instead of a magic
//! number.

use acadrust::{CadDocument, DwgReader, EntityType};
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_header <dwg>");
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let h = &doc.header;
    println!("TEXTSIZE={:.6}", h.text_height);
    println!("LTSCALE={:.6}", h.linetype_scale);
    println!("CELTSCALE={:.6}", h.current_entity_linetype_scale);
    println!("TRACEWID={:.6}", h.trace_width);
    println!("THICKNESS={:.6}", h.thickness);
    println!("PLINEWID={:.6}", h.polyline_width);
    println!("INSUNITS={}", h.insertion_units);
    println!("MEASUREMENT={}", h.linear_unit_format);

    for style in doc.dim_styles.iter() {
        println!(
            "DIMSTYLE name={} dimscale={:.6} dimlfac={:.6} dimtxt={:.6}",
            style.name, style.dimscale, style.dimlfac, style.dimtxt
        );
    }

    // Any entity carrying a ratio near 75.95 would explain the CADSee figure.
    let mut near: Vec<String> = Vec::new();
    for entity in doc.entities() {
        if let EntityType::Text(text) = entity {
            if (text.height - 75.9494).abs() < 1.0 || (text.height - 265.8228).abs() < 1.0 {
                near.push(format!(
                    "TEXT h={:.4} layer={} value={:?}",
                    text.height, text.common.layer, text.value
                ));
            }
        }
    }
    println!("texts near 75.95/265.82: {}", near.len());
    for line in near.iter().take(10) {
        println!("{line}");
    }
    Ok(())
}
