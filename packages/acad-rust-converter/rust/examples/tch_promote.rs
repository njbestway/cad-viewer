//! Temporary native probe: run the real `promote_tch_text` pass over a DWG and
//! report what the viewer will actually see (counts, the `L+S+F+Z+XD` sample,
//! and the coordinate envelope of every promoted text).

use acadrust::{CadDocument, DwgReader, EntityType};
use acad_rust_converter::tianzheng;
use std::fs;
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_promote <dwg> [out]");
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "tch-promote.txt".to_string());
    let mut doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    // Pre-pass diagnostics: the drawing already contains native `AcDbText`
    // entities (frame labels, room stamps) whose heights are in millimetres, so
    // the post-pass stats below must only look at handles this pass promoted.
    let mut tch_handles = std::collections::HashSet::new();
    for entity in doc.entities() {
        let EntityType::Unknown(unknown) = entity else {
            continue;
        };
        if unknown.dxf_name.eq_ignore_ascii_case("TCH_TEXT") {
            tch_handles.insert(unknown.common.handle.value());
        }
    }
    let pre = format!("tch_text handles: {}\n", tch_handles.len());

    // What else the reader has no schema for: those classes still render as
    // nothing, so list them to keep the remaining gap visible.
    let mut unknown: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for entity in doc.entities() {
        if let EntityType::Unknown(item) = entity {
            *unknown.entry(item.dxf_name.clone()).or_insert(0) += 1;
        }
    }
    let mut unknown_report = format!("unknown classes: {}\n", unknown.len());
    let mut unknown_totals: Vec<(String, usize)> = unknown.into_iter().collect();
    unknown_totals.sort_by(|a, b| b.1.cmp(&a.1));
    for (name, count) in unknown_totals.iter().take(25) {
        unknown_report.push_str(&format!("  {name}: {count}\n"));
    }

    // Calibration: the drawing also has native `AcDbText`, which is already in
    // drawing units. Their heights tell us what a legible height looks like in
    // this DWG, so the promoted millimetre figure can be validated against it.
    let mut native: Vec<(f64, String, String)> = Vec::new();
    for entity in doc.entities() {
        let EntityType::Text(text) = entity else {
            continue;
        };
        native.push((
            text.height,
            text.common.layer.clone(),
            text.value.chars().take(24).collect(),
        ));
    }
    native.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut native_report = format!("native text entities: {}\n", native.len());
    for (height, layer, value) in &native {
        native_report.push_str(&format!("  h={height:.3} layer={layer} value={value:?}\n"));
    }

    let started = std::time::Instant::now();
    let stats = tianzheng::promote_tch_text(&mut doc);
    let elapsed = started.elapsed();

    let mut out = String::new();
    out.push_str(&format!(
        "file: {path}\nscanned={} promoted={} elapsed={:?}\n",
        stats.scanned, stats.promoted, elapsed
    ));

    out.push_str(&pre);
    out.push_str(&unknown_report);
    out.push_str(&native_report);
    let mut min = (f64::MAX, f64::MAX);
    let mut max = (f64::MIN, f64::MIN);
    let mut heights: Vec<f64> = Vec::new();
    let mut sample: Option<String> = None;
    let mut empty = Some(0usize);
    let mut promoted_elsewhere = 0usize;
    let mut tall: Vec<String> = Vec::new();
    for entity in doc.entities() {
        let EntityType::Text(text) = entity else {
            continue;
        };
        let handle = text.common.handle.value();
        if !tch_handles.contains(&handle) {
            continue;
        }
        let empty_counter = empty.get_or_insert(0);
        if text.value.trim().is_empty() {
            *empty_counter += 1;
        }
        if text.insertion_point.x.abs() > 1.0e7 || text.insertion_point.y.abs() > 1.0e7 {
            promoted_elsewhere += 1;
        }
        min = (
            min.0.min(text.insertion_point.x),
            min.1.min(text.insertion_point.y),
        );
        max = (
            max.0.max(text.insertion_point.x),
            max.1.max(text.insertion_point.y),
        );
        if heights.len() < 400 {
            heights.push(text.height);
        }
        if !(0.05..=50.0).contains(&text.height) && tall.len() < 12 {
            tall.push(format!(
                "handle={handle} layer={} h={:.3} at=({:.3}, {:.3}) value={:?}",
                text.common.layer,
                text.height,
                text.insertion_point.x,
                text.insertion_point.y,
                text.value
            ));
        }
        if text.value.contains("L+S+F+Z+XD") || handle == 13946 {
            sample = Some(format!(
                "handle={handle} layer={} value={:?} at=({:.3}, {:.3}, {:.3}) height={:.3}",
                text.common.layer,
                text.value,
                text.insertion_point.x,
                text.insertion_point.y,
                text.insertion_point.z,
                text.height
            ));
        }
    }
    out.push_str(&format!(
        "text entities: min=({:.3}, {:.3}) max=({:.3}, {:.3}) out-of-range={promoted_elsewhere} empty={}\n",
        min.0,
        min.1,
        max.0,
        max.1,
        empty.unwrap_or(0)
    ));
    heights.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if !heights.is_empty() {
        out.push_str(&format!(
            "height: min={:.3} median={:.3} max={:.3}\n",
            heights[0],
            heights[heights.len() / 2],
            heights[heights.len() - 1]
        ));
    }
    match sample {
        Some(line) => out.push_str(&format!("sample: {line}\n")),
        None => out.push_str("sample: handle 13946 / L+S+F+Z+XD not found\n"),
    }
    for line in &tall {
        out.push_str(line);
        out.push('\n');
    }
    fs::write(&out_path, out)?;
    println!("wrote {out_path}");
    Ok(())
}
