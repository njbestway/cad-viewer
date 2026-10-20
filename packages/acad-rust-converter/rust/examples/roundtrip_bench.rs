//! Native cost probe for the operations an editing / version-control service
//! would run on every save: parse, mutate, write DXF, write DWG, re-parse.
//!
//! Two questions this answers that documentation cannot:
//!   1. Is `DwgWriter` deterministic (same document -> byte-identical output)?
//!      A version-control backend cannot store byte deltas otherwise.
//!   2. How much does a save cost relative to a parse, per file size?
//!
//! Usage:
//!   cargo run --release --example roundtrip_bench -- <file.dwg> [<file.dwg> ...]

use acadrust::{Color, DwgReader, DwgWriter, DxfReader, DxfVersion, DxfWriter, EntityType};
use std::io::Cursor;
use std::time::Instant;

fn mb(bytes: usize) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

/// How much of a saved file changes when one entity is edited: differing byte
/// count, number of contiguous change runs, and first/last differing offset.
/// This is what decides whether a VCS can store byte-level deltas at all.
fn diff_stats(a: &[u8], b: &[u8]) -> (usize, usize, usize, usize) {
    let common = a.len().min(b.len());
    let mut differing = a.len().abs_diff(b.len());
    let mut runs = 0;
    let mut first = common;
    let mut last = 0;
    let mut in_run = false;
    for index in 0..common {
        if a[index] != b[index] {
            differing += 1;
            first = first.min(index);
            last = index;
            if !in_run {
                runs += 1;
                in_run = true;
            }
        } else {
            in_run = false;
        }
    }
    (differing, runs, first, last)
}

fn unknowns(doc: &acadrust::CadDocument) -> usize {
    doc.entities()
        .filter(|e| matches!(e, EntityType::Unknown(_)))
        .count()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("usage: roundtrip_bench <file.dwg> [<file.dwg> ...]");
        return Ok(());
    }

    println!(
        "sizes: EntityType={} B  CadDocument={} B",
        std::mem::size_of::<EntityType>(),
        std::mem::size_of::<acadrust::CadDocument>()
    );

    for path in files {
        println!("\n=== {path} ===");
        let raw = std::fs::read(&path)?;
        let src_mb = mb(raw.len());
        let is_dxf = path.to_ascii_lowercase().ends_with(".dxf");

        let t = Instant::now();
        let (mut doc, read_ms) = if is_dxf {
            let doc = DxfReader::from_reader(Cursor::new(raw.clone()))?.read()?;
            (doc, t.elapsed().as_secs_f64() * 1000.0)
        } else {
            let doc = DwgReader::from_stream(Cursor::new(&raw)).read()?;
            (doc, t.elapsed().as_secs_f64() * 1000.0)
        };
        drop(raw);

        let entity_count = doc.entities().count();
        let unknown_count = unknowns(&doc);
        println!(
            "read     : {:8.1} ms  {:.2} MB  => {:.2} MB/s  version={:?} src={:?}",
            read_ms,
            src_mb,
            src_mb / (read_ms / 1000.0),
            doc.version,
            doc.dwg_source_version
        );
        println!(
            "content  : entities={entity_count} unknown={unknown_count} objects={} blocks={}",
            doc.objects.len(),
            doc.block_records.len()
        );

        // Baseline save before any edit, for the change-size measurement below.
        let t = Instant::now();
        let mut base = Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut base, &doc)?;
        let base_dwg = base.into_inner();
        println!(
            "write dwg: {:8.1} ms  {:.2} MB  ({:.2}x source)  [baseline]",
            t.elapsed().as_secs_f64() * 1000.0,
            mb(base_dwg.len()),
            mb(base_dwg.len()) / src_mb
        );
        let base_dxf = DxfWriter::new(&doc).write_to_vec()?;
        let base_dxf2 = DxfWriter::new(&doc).write_to_vec()?;
        if base_dxf != base_dxf2 {
            let (w, r, a, z) = diff_stats(&base_dxf, &base_dxf2);
            println!(
                "dxf determinism: FALSE  {} bytes differ ({:.1}%)  runs={}  span={}..{}",
                w,
                100.0 * w as f64 / base_dxf.len() as f64,
                r,
                a,
                z
            );
        } else {
            println!("dxf determinism: true ({} bytes)", base_dxf.len());
        }

        // Edit one entity the way an interactive editor would.
        let handle = doc.model_space_entities().next().map(|e| e.common().handle);
        if let Some(handle) = handle {
            let t = Instant::now();
            if let Some(entity) = doc.get_entity_mut(handle) {
                entity.common_mut().color = Color::GREEN;
            }
            println!(
                "edit x1  : {:8.3} ms  handle={:?}",
                t.elapsed().as_secs_f64() * 1000.0,
                handle
            );
        }

        // DXF save.
        let t = Instant::now();
        let dxf = DxfWriter::new(&doc).write_to_vec()?;
        let dxf_ms = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "write dxf: {:8.1} ms  {:.2} MB  ({:.0}x source)",
            dxf_ms,
            mb(dxf.len()),
            mb(dxf.len()) / src_mb
        );

        // DWG save, twice, to test determinism.
        let t = Instant::now();
        let mut out1 = Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut out1, &doc)?;
        let dwg_ms = t.elapsed().as_secs_f64() * 1000.0;
        let bytes1 = out1.into_inner();
        println!(
            "write dwg: {:8.1} ms  {:.2} MB  ({:.2}x source)",
            dwg_ms,
            mb(bytes1.len()),
            mb(bytes1.len()) / src_mb
        );

        let t = Instant::now();
        let mut out2 = Cursor::new(Vec::new());
        DwgWriter::write_to_writer(&mut out2, &doc)?;
        let bytes2 = out2.into_inner();
        let same = bytes1 == bytes2;
        println!(
            "write dwg: {:8.1} ms  deterministic={} ({} vs {} bytes)",
            t.elapsed().as_secs_f64() * 1000.0,
            same,
            bytes1.len(),
            bytes2.len()
        );

        // Cost of one edit expressed as stored bytes.
        let (dw, dr, d0, d1) = diff_stats(&base_dwg, &bytes1);
        println!(
            "1 edit -> dwg: {} / {} bytes differ ({:.1}%)  runs={}  span={}..{}",
            dw,
            base_dwg.len(),
            100.0 * dw as f64 / base_dwg.len() as f64,
            dr,
            d0,
            d1
        );
        let (fw, fr, f0, f1) = diff_stats(&base_dxf, &dxf);
        println!(
            "1 edit -> dxf: {} / {} bytes differ ({:.1}%)  runs={}  span={}..{}",
            fw,
            base_dxf.len(),
            100.0 * fw as f64 / base_dxf.len() as f64,
            fr,
            f0,
            f1
        );
        drop(base_dxf);
        drop(dxf);

        // Round-trip read-back: does the edited document survive a save?
        let t = Instant::now();
        let reparsed = DwgReader::from_stream(Cursor::new(&bytes1)).read()?;
        println!(
            "re-read  : {:8.1} ms  entities={} (was {})  edited_handle_survives={}",
            t.elapsed().as_secs_f64() * 1000.0,
            reparsed.entities().count(),
            entity_count,
            handle.is_some_and(|h| reparsed.get_entity(h).is_some())
        );

        // Cross-version save: the writer only passes untouched unknown records
        // through when the target version equals the source version.
        let target = DxfVersion::AC1024;
        println!(
            "version lock (target {:?}): {}",
            target,
            doc.has_version_locked_data(target)
        );
        if target != doc.version && !is_dxf {
            let mut older = doc.clone();
            older.version = target;
            let mut down = Cursor::new(Vec::new());
            match DwgWriter::write_to_writer(&mut down, &older) {
                Ok(()) => {
                    let down_bytes = down.into_inner();
                    match DwgReader::from_stream(Cursor::new(&down_bytes)).read() {
                        Ok(back) => println!(
                            "save as {:?}: entities {} -> {}  unknown {} -> {}",
                            target,
                            entity_count,
                            back.entities().count(),
                            unknown_count,
                            unknowns(&back)
                        ),
                        Err(err) => println!("save as {:?}: wrote {} bytes, re-read failed: {err}", target, down_bytes.len()),
                    }
                }
                Err(err) => println!("save as {:?}: write failed: {err}", target),
            }
        }
    }

    Ok(())
}
