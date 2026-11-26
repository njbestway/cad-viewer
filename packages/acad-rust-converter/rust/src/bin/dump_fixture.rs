//! Offline native fixture dumper (not part of the wasm build).
//!
//! This binary reads a real DWG with `acadrust`'s native (std/fs-enabled)
//! reader and writes each document section, the meta summary, and a bounded
//! first page of model-space entities to separate JSON files. It exists to
//! generate the committed `__tests__/fixtures/*.json` inputs for the
//! `AcDbAcadRustNativeConverter` parity tests (§7 of the Phase 4 plan): the
//! worker/wasm path itself cannot run under jest (node cannot load the
//! `--target web` glue), so tests consume these pre-generated files instead.
//!
//! The section-kind dispatch table below is a mirror of
//! `acad_rust_converter::dwg_section_json`'s `match` in `lib.rs` - the same
//! field accesses, just writing to files instead of returning strings across
//! the wasm boundary. `SECTION_KINDS` (exported from the lib crate, which is
//! built as an `rlib` alongside the `cdylib` for exactly this reason) is
//! asserted against at startup so the two tables cannot silently drift.
//!
//! Usage:
//!   cargo run --bin dump_fixture -- <input.dwg> <output-dir>

use acadrust::{CadDocument, DwgReader, DxfWriter};
use acad_rust_converter::SECTION_KINDS;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// Serialize one section the same way `dwg_section_json` does, to a JSON
/// string. Kept exhaustive over `SECTION_KINDS` via a `match` on the kind
/// string, mirroring `lib.rs` so a new Rust section only needs adding once
/// here and once in `dwg_section_json`, and the `debug_assert` below catches
/// the two lists drifting.
fn section_json(doc: &CadDocument, kind: &str) -> anyhow::Result<String> {
    let serialized = match kind {
        "header" => serde_json::to_string(&doc.header)?,
        "summary-info" => serde_json::to_string(&doc.summary_info)?,
        "classes" => serde_json::to_string(&doc.classes)?,
        "tables-layer" => serde_json::to_string(&doc.layers)?,
        "tables-ltype" => serde_json::to_string(&doc.line_types)?,
        "tables-style" => serde_json::to_string(&doc.text_styles)?,
        "tables-blockrecord" => serde_json::to_string(&doc.block_records)?,
        "tables-dimstyle" => serde_json::to_string(&doc.dim_styles)?,
        "tables-appid" => serde_json::to_string(&doc.app_ids)?,
        "tables-view" => serde_json::to_string(&doc.views)?,
        "tables-vport" => serde_json::to_string(&doc.vports)?,
        "tables-ucs" => serde_json::to_string(&doc.ucss)?,
        "tables-vx" => serde_json::to_string(&doc.vx_table)?,
        "objects" => serde_json::to_string(&doc.objects)?,
        other => anyhow::bail!("Unknown section kind: {other}"),
    };
    debug_assert!(
        SECTION_KINDS.contains(&kind),
        "dump_fixture handles '{kind}' but it is missing from SECTION_KINDS"
    );
    Ok(serialized)
}

/// Same JSON shape as the wasm `dwg_meta` entry point, computed natively.
fn meta_json(doc: &CadDocument) -> anyhow::Result<String> {
    let value = serde_json::json!({
        "version": doc.version,
        "dwgSourceVersion": doc.dwg_source_version,
        "entityCount": doc.entity_count(),
        "modelSpaceEntityCount": doc.model_space_entities().count(),
        "blockRecordCount": doc.block_records.len(),
        "layerCount": doc.layers.len(),
        "lineTypeCount": doc.line_types.len(),
        "textStyleCount": doc.text_styles.len(),
        "dimStyleCount": doc.dim_styles.len(),
        "vportCount": doc.vports.len(),
        "objectCount": doc.objects.len(),
        "classCount": doc.classes.len(),
    });
    Ok(serde_json::to_string_pretty(&value)?)
}

fn write_file(out_dir: &Path, name: &str, contents: &str) -> anyhow::Result<()> {
    let path = out_dir.join(name);
    fs::write(&path, contents)?;
    println!("wrote {}", path.display());
    Ok(())
}

/// Model-space entity page, same bounded-window semantics as the wasm
/// `dwg_entity_page` entry point, for a caller-chosen page size.
fn entity_page_json(doc: &CadDocument, offset: usize, limit: usize) -> anyhow::Result<String> {
    let page: Vec<_> = doc
        .model_space_entities()
        .skip(offset)
        .take(limit)
        .collect();
    Ok(serde_json::to_string(&page)?)
}

fn run(input: &Path, out_dir: &Path, entity_page_limit: usize) -> anyhow::Result<()> {
    // Native-only guard: every entry point above assumes the same serde
    // schema as the wasm build; fail loudly if this binary is ever compiled
    // for wasm32 by accident instead of silently producing unusable fixtures.
    if cfg!(target_arch = "wasm32") {
        anyhow::bail!("dump_fixture is a native tool and must not target wasm32");
    }

    fs::create_dir_all(out_dir)?;

    let mut reader = DwgReader::from_file(input)?;
    let doc = reader.read()?;

    // Baseline for the parity test: the exact same `CadDocument` Architecture
    // A would produce, written out as ASCII DXF so jest can feed it to the
    // untouched, MIT-licensed `AcDbNativeDxfConverter` (which runs fine under
    // node, unlike the wasm glue) and get a reference `AcDbDatabase` to diff
    // the native mapping's output against.
    let dxf_path = out_dir.join("baseline.dxf");
    DxfWriter::new(&doc).write_to_file(&dxf_path)?;
    println!("wrote {}", dxf_path.display());

    write_file(out_dir, "meta.json", &meta_json(&doc)?)?;

    for kind in SECTION_KINDS {
        write_file(out_dir, &format!("{kind}.json"), &section_json(&doc, kind)?)?;
    }

    write_file(
        out_dir,
        "entity-page-0.json",
        &entity_page_json(&doc, 0, entity_page_limit)?,
    )?;

    // Entity page for EVERY non-space block that owns entities. The converter
    // pulls each block with its own `dwg_block_entity_page` round-trip, so a
    // corpus replay needs all of them - not just the first block - to exercise
    // INSERT-heavy drawings (definitions included) end to end.
    for block in doc.block_records.iter() {
        if block.name == "*Model_Space" || block.name.starts_with("*Paper_Space") {
            continue;
        }
        let page: Vec<_> = doc.entities_in_block(&block.name).take(entity_page_limit).collect();
        if page.is_empty() {
            continue;
        }
        let safe_name: String = block
            .name
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        write_file(
            out_dir,
            &format!("block-entity-page-{safe_name}.json"),
            &serde_json::to_string(&page)?,
        )?;
    }

    Ok(())
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(input) = args.next() else {
        eprintln!("usage: dump_fixture <input.dwg> <output-dir> [entity-page-limit]");
        std::process::exit(2);
    };
    let Some(out_dir) = args.next() else {
        eprintln!("usage: dump_fixture <input.dwg> <output-dir> [entity-page-limit]");
        std::process::exit(2);
    };
    let entity_page_limit: usize = args
        .next()
        .map(|s| s.parse().unwrap_or(100))
        .unwrap_or(100);

    let stderr = io::stderr();
    if let Err(err) = run(Path::new(&input), Path::new(&out_dir), entity_page_limit) {
        let mut lock = stderr.lock();
        let _ = writeln!(lock, "dump_fixture failed: {err}");
        std::process::exit(1);
    }
}
