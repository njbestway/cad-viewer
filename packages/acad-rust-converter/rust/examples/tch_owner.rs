//! Find which block owns handle 13946 and what scale the referencing INSERTs
//! carry. If the promoted height 3.5 sits inside a block that is inserted with a
//! large scale, the viewer already multiplies it and the "small text" is a model
//! space record; if it is model space, the slot is not a drawing-unit height.

use acadrust::{CadDocument, DwgReader, EntityType};
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_owner <dwg> <handle>");
    let wanted: u64 = std::env::args().nth(2).expect("handle").parse()?;
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let mut owners: Vec<String> = Vec::new();
    for record in doc.block_records.iter() {
        if record.entity_handles.iter().any(|h| h.value() == wanted) {
            owners.push(record.name.clone());
        }
    }
    println!("handle {wanted} owned by blocks: {owners:?}");

    for name in &owners {
        let count = doc.entities_in_block(name).count();
        println!("  block {name}: {count} entities");
    }

    let mut inserts: Vec<String> = Vec::new();
    for entity in doc.entities() {
        let EntityType::Insert(insert) = entity else {
            continue;
        };
        inserts.push(format!(
            "INSERT block={} at=({:.3}, {:.3}) scale=({:.4}, {:.4}) rotation={:.4}",
            insert.block_name,
            insert.insert_point.x,
            insert.insert_point.y,
            insert.x_scale(),
            insert.y_scale(),
            insert.rotation
        ));
    }
    inserts.sort();
    println!("inserts: {}", inserts.len());
    for line in inserts.iter() {
        println!("{line}");
    }

    // Model space bbox of the block insert references, to see whether the big
    // coordinates above come from a scaled block or from real WCS geometry.
    let mut ms = 0usize;
    for entity in doc.model_space_entities() {
        ms += 1;
        let _ = entity;
    }
    println!("model space entities: {ms}");
    Ok(())
}
