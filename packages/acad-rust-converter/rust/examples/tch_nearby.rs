//! Calibrate the promoted TCH_TEXT height against real geometry.
//!
//! CADSee reports 265.8228 for `L+S+F+Z+XD` while the record slot at
//! `x_bit + 134` holds 3.5, and native `AcDbText` in the same drawing sits at
//! 150..350. The screen shot shows a leader line under the text whose length
//! tracks the string width, so measuring nearby lines gives an independent
//! estimate of the drawn height.

use acadrust::{CadDocument, DwgReader, EntityType};
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: tch_nearby <dwg> <x> <y> [radius]");
    let cx: f64 = std::env::args().nth(2).expect("x").parse()?;
    let cy: f64 = std::env::args().nth(3).expect("y").parse()?;
    let radius: f64 = std::env::args()
        .nth(4)
        .unwrap_or_else(|| "8000".to_string())
        .parse()?;
    let doc: CadDocument = DwgReader::from_file(Path::new(&path))?.read()?;

    let near = |x: f64, y: f64| (x - cx).abs() <= radius && (y - cy).abs() <= radius;
    let mut hits: Vec<String> = Vec::new();
    let mut counts = std::collections::BTreeMap::new();

    for entity in doc.entities() {
        match entity {
            EntityType::Line(line) => {
                let (x0, y0) = (line.start.x, line.start.y);
                let (x1, y1) = (line.end.x, line.end.y);
                if !(near(x0, y0) || near(x1, y1)) {
                    continue;
                }
                let length = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
                hits.push(format!(
                    "LINE layer={} len={:.3} from=({:.3}, {:.3}) to=({:.3}, {:.3})",
                    line.common.layer, length, x0, y0, x1, y1
                ));
                *counts.entry("LINE").or_insert(0) += 1;
            }
            EntityType::Polyline(polyline) => {
                let vertices = &polyline.vertices;
                if vertices.is_empty() {
                    continue;
                }
                let inside = vertices.iter().any(|v| near(v.location.x, v.location.y));
                if !inside {
                    continue;
                }
                let xs: Vec<f64> = vertices.iter().map(|v| v.location.x).collect();
                let ys: Vec<f64> = vertices.iter().map(|v| v.location.y).collect();
                hit_summary(&mut hits, &mut counts, "LWPOLYLINE", &polyline.common.layer, &xs, &ys);
            }
            EntityType::Text(text) => {
                if !near(text.insertion_point.x, text.insertion_point.y) {
                    continue;
                }
                hits.push(format!(
                    "TEXT layer={} h={:.3} at=({:.3}, {:.3}) value={:?}",
                    text.common.layer,
                    text.height,
                    text.insertion_point.x,
                    text.insertion_point.y,
                    text.value
                ));
                *counts.entry("TEXT").or_insert(0) += 1;
            }
            other => {
                let label = other_type_name(&other);
                if let Some((x, y)) = entity_point(&other) {
                    if near(x, y) {
                        hits.push(format!("{label} at=({x:.3}, {y:.3})"));
                        *counts.entry(label).or_insert(0) += 1;
                    }
                }
            }
        }
    }

    println!("entities within {radius} of ({cx:.3}, {cy:.3}): {counts:?}");
    for line in &hits {
        println!("{line}");
    }
    Ok(())
}

fn hit_summary(
    hits: &mut Vec<String>,
    counts: &mut std::collections::BTreeMap<&'static str, i32>,
    label: &'static str,
    layer: &str,
    xs: &[f64],
    ys: &[f64],
) {
    let min_x = xs.iter().cloned().fold(f64::MAX, f64::min);
    let max_x = xs.iter().cloned().fold(f64::MIN, f64::max);
    let min_y = ys.iter().cloned().fold(f64::MAX, f64::min);
    let max_y = ys.iter().cloned().fold(f64::MIN, f64::max);
    hits.push(format!(
        "{label} layer={layer} bbox=({min_x:.3}, {min_y:.3})-({max_x:.3}, {max_y:.3}) w={:.3} h={:.3}",
        max_x - min_x,
        max_y - min_y
    ));
    *counts.entry(label).or_insert(0) += 1;
}

fn other_type_name(entity: &EntityType) -> &'static str {
    match entity {
        EntityType::Circle(_) => "CIRCLE",
        EntityType::Arc(_) => "ARC",
        EntityType::Insert(_) => "INSERT",
        EntityType::MText(_) => "MTEXT",
        EntityType::Hatch(_) => "HATCH",
        EntityType::Point(_) => "POINT",
        _ => "OTHER",
    }
}

fn entity_point(entity: &EntityType) -> Option<(f64, f64)> {
    match entity {
        EntityType::Circle(circle) => Some((circle.center.x, circle.center.y)),
        EntityType::Arc(arc) => Some((arc.center.x, arc.center.y)),
        EntityType::Insert(insert) => Some((insert.insert_point.x, insert.insert_point.y)),
        EntityType::MText(text) => Some((text.insertion_point.x, text.insertion_point.y)),
        EntityType::Point(point) => Some((point.location.x, point.location.y)),
        _ => None,
    }
}
