//! Measure the size of the Architecture-B JSON wire: serialize the whole
//! model space the same way `dwg_entity_page` does (500 entities per page),
//! and compare it with the DXF wire that Architecture A ships.
//!
//! Usage:
//!   cargo run --release --example json_wire_size -- <file.dwg>

use acadrust::DwgReader;
use std::io::Cursor;
use std::time::Instant;

const PAGE: usize = 500;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: json_wire_size <file.dwg>");
    let raw = std::fs::read(&path)?;
    let src = raw.len();
    let doc = DwgReader::from_stream(Cursor::new(&raw)).read()?;
    let entities: Vec<_> = doc.entities().collect();
    println!(
        "source DWG: {:.2} MB  all entities: {}  model-space: {}  blocks: {}",
        src as f64 / 1048576.0,
        entities.len(),
        doc.model_space_entities().count(),
        doc.block_records.len()
    );

    // One-shot: upper bound on a single `dwg_to_json`-style payload.
    let t = Instant::now();
    let one = serde_json::to_vec(&entities)?;
    println!(
        "one-shot JSON: {:.1} MB  {:.0} ms  ({:.0} B/entity)",
        one.len() as f64 / 1048576.0,
        t.elapsed().as_secs_f64() * 1000.0,
        one.len() as f64 / entities.len() as f64
    );
    std::fs::write("target/entities_all.json", &one)?;
    drop(one);

    // Paged: exactly what the sectioned protocol pays, page by page.
    let t = Instant::now();
    let mut bytes = 0usize;
    let mut pages = 0usize;
    let mut worst = 0usize;
    for chunk in entities.chunks(PAGE) {
        let s = serde_json::to_vec(chunk)?;
        worst = worst.max(s.len());
        bytes += s.len();
        pages += 1;
    }
    let paged_ms = t.elapsed().as_secs_f64() * 1000.0;
    println!(
        "paged JSON ({}): {} pages, {:.1} MB total, {:.0} ms, worst page {:.2} MB",
        PAGE,
        pages,
        bytes as f64 / 1048576.0,
        paged_ms,
        worst as f64 / 1048576.0
    );

    // A 4x-larger page: how much of the cost is per-page fixed overhead?
    const BIG: usize = 2000;
    let t = Instant::now();
    let mut bytes_big = 0usize;
    let mut pages_big = 0usize;
    for chunk in entities.chunks(BIG) {
        bytes_big += serde_json::to_vec(chunk)?.len();
        pages_big += 1;
    }
    println!(
        "paged JSON ({}): {} pages, {:.1} MB total, {:.0} ms",
        BIG,
        pages_big,
        bytes_big as f64 / 1048576.0,
        t.elapsed().as_secs_f64() * 1000.0
    );

    Ok(())
}
