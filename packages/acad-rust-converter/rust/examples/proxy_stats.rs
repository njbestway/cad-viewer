//! Temporary native probe: report whether unknown (proxy) entities in a DWG
//! carry a non-empty proxy-graphics stream.

use acadrust::{CadDocument, DwgReader, EntityType};
use std::collections::BTreeMap;
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: proxy_stats <dwg>");
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;
    println!(
        "version={:?} PROXYGRAPHICS={} entities={} model={}",
        doc.dwg_source_version,
        doc.header.proxy_graphics,
        doc.entity_count(),
        doc.model_space_entities().count()
    );

    let mut unknown_total = 0usize;
    let mut with_data = 0usize;
    let mut empty_stream = 0usize;
    let mut records_total = 0u64;
    let mut size_hist: BTreeMap<usize, usize> = BTreeMap::new();
    let mut per_name: BTreeMap<String, usize> = BTreeMap::new();

    for entity in doc.entities() {
        let EntityType::Unknown(unknown) = entity else {
            continue;
        };
        unknown_total += 1;
        *per_name.entry(unknown.dxf_name.clone()).or_default() += 1;
        let Some(bytes) = unknown.common.graphic_data.as_deref() else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        with_data += 1;
        *size_hist.entry(bytes.len()).or_default() += 1;
        if bytes.len() >= 8 {
            let total = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
            let records = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
            records_total += records as u64;
            if records == 0 {
                empty_stream += 1;
            }
            if total != bytes.len() && size_hist.len() < 20 {
                println!(
                    "size-mismatch {}: len={} total={} records={}",
                    unknown.dxf_name,
                    bytes.len(),
                    total,
                    records
                );
            }
        }
    }

    println!(
        "unknown={unknown_total} with_graphic_data={with_data} empty_streams={empty_stream} records_total={records_total}"
    );
    println!("size histogram: {size_hist:?}");
    println!("--- per dxf_name ---");
    for (name, count) in &per_name {
        println!("{count:>7} {name}");
    }
    Ok(())
}
