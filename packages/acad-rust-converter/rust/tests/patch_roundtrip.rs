//! Permanent Route-B regression: the incremental DWG patch save must preserve
//! verbatim bytes for every unedited record while applying edits / adds / erases
//! and table changes correctly, across all five supported version families
//! (AC1018 / AC1021 / AC1024 / AC1027 / AC1032).
//!
//! Fixtures are built programmatically (`CadDocument::with_version` +
//! `add_entity`, the same path `r12_dwg_read.rs` exercises) so the test is
//! self-contained and portable - no external drawing files. Each fixture holds
//! one LWPOLYLINE (three vertices) and two LINEs; the change-set moves a
//! polyline vertex, adds a LINE, erases a LINE and recolours layer "0".
//!
//! This drives the *shared* engine (`acad_rust_converter::patch`) that the wasm
//! bridge also calls, so a native-only fix can never diverge from the browser
//! path (plan R5). It locks in the P0 matrix verdict at unit scale: untouched
//! records stay byte-exact, touched records take the new value, erased handles
//! never revive, adds land in model space, and the version / pre-R2004 gates
//! reject invalid saves instead of silently corrupting them.

use acad_rust_converter::patch;
use acadrust::{
    CadDocument, Color, DwgReader, DwgWriter, DxfVersion, EntityType, Handle, Line, LwPolyline,
    Vector2,
};
use serde_json::json;
use std::collections::BTreeSet;
use std::io::Cursor;

fn read(bytes: &[u8]) -> CadDocument {
    DwgReader::from_stream(Cursor::new(bytes))
        .read()
        .expect("read dwg")
}

/// One LWPOLYLINE + two LINEs, written at the requested version.
fn fixture(version: DxfVersion) -> Vec<u8> {
    let mut doc = CadDocument::with_version(version);
    let lw = LwPolyline::from_points(vec![
        Vector2::new(0.0, 0.0),
        Vector2::new(10.0, 0.0),
        Vector2::new(10.0, 10.0),
    ]);
    doc.add_entity(EntityType::LwPolyline(lw)).unwrap();
    doc.add_entity(EntityType::Line(Line::from_coords(0.0, 0.0, 0.0, 5.0, 5.0, 0.0)))
        .unwrap();
    doc.add_entity(EntityType::Line(Line::from_coords(1.0, 1.0, 0.0, 6.0, 6.0, 0.0)))
        .unwrap();
    DwgWriter::write_to_vec(&doc).expect("write fixture")
}

fn version_str(v: DxfVersion) -> String {
    serde_json::to_value(v)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

/// Full edit / add / erase / table scenario for one version family.
fn run_family(version: DxfVersion) {
    let bytes = fixture(version);
    let src = read(&bytes);

    let lw_h = src
        .entities()
        .find_map(|e| match e {
            EntityType::LwPolyline(_) => Some(e.common().handle.value()),
            _ => None,
        })
        .expect("fixture LWPOLYLINE");
    let lines: Vec<u64> = src
        .entities()
        .filter_map(|e| match e {
            EntityType::Line(_) => Some(e.common().handle.value()),
            _ => None,
        })
        .collect();
    assert_eq!(lines.len(), 2, "fixture must hold two LINEs");
    let erase_h = lines[0];
    let keep_h = lines[1];

    let new_line =
        serde_json::to_value(EntityType::Line(Line::from_coords(2.0, 2.0, 0.0, 8.0, 8.0, 0.0)))
            .unwrap();
    let changes = json!({
        "version": version_str(version),
        "modified": [{
            "handle": lw_h,
            "patch": [{"op": "replace", "path": "/LwPolyline/vertices/0/location/x", "value": 2.5}]
        }],
        "added": [{"entity": new_line}],
        "erased": [erase_h],
        "tables": {"layer": [{
            "name": "0",
            "patch": [{"op": "replace", "path": "/color", "value": {"Index": 3}}]
        }]}
    });
    let parsed = patch::parse_changes(&changes.to_string()).expect("parse changes");

    // Audit: no hard errors and byte fidelity intact for untouched records.
    let report = patch::audit_bytes(&bytes, &parsed).expect("audit");
    assert!(
        report["ok"].as_bool().unwrap(),
        "{version:?} hard errors: {}",
        report["hard_errors"]
    );
    assert!(report["byte_fidelity"].as_bool().unwrap(), "{version:?}");
    let added_h = report["applied"]["added"].as_array().unwrap()[0]
        .as_u64()
        .unwrap();

    // Save and read the result back.
    let saved = patch::save_bytes(&bytes, &parsed).expect("save");
    let after = read(&saved);

    // The edited vertex took the new value.
    match after.get_entity(Handle::from(lw_h)).expect("LWPOLYLINE after") {
        EntityType::LwPolyline(p) => assert_eq!(p.vertices[0].location.x, 2.5),
        other => panic!("LWPOLYLINE became {other:?}"),
    }
    // The erased LINE never revives.
    assert!(after.get_entity(Handle::from(erase_h)).is_none());
    // The added LINE lands in model space with the allocated handle.
    assert!(after
        .model_space_entities()
        .any(|e| e.common().handle.value() == added_h));
    // LINE inventory: 2 original - 1 erased + 1 added = 2.
    let line_count = after
        .entities()
        .filter(|e| matches!(e, EntityType::Line(_)))
        .count();
    assert_eq!(line_count, 2);
    // Layer "0" recoloured.
    assert_eq!(after.layers.get("0").expect("layer 0").color, Color::Index(3));

    // No collateral damage: untouched records stay byte-exact / semantically equal.
    let before = patch::snapshot(&src);
    let mut touched = BTreeSet::new();
    touched.insert(lw_h);
    touched.insert(erase_h);
    let cmp = patch::compare(&before, &after, &touched);
    assert!(
        cmp["unexpected_reencode"].as_array().unwrap().is_empty(),
        "{version:?} unexpected re-encode: {}",
        cmp["unexpected_reencode"]
    );
    assert!(
        cmp["semantic_mismatch"].as_array().unwrap().is_empty(),
        "{version:?} semantic mismatch: {}",
        cmp["semantic_mismatch"]
    );
    // The kept LINE specifically must come back byte for byte.
    let saved_snap = patch::snapshot(&after);
    assert_eq!(
        before.entities[&keep_h].1, saved_snap.entities[&keep_h].1,
        "{version:?} kept LINE bytes changed"
    );
}

#[test]
fn route_b_ac1018() {
    run_family(DxfVersion::AC1018);
}

#[test]
fn route_b_ac1021() {
    run_family(DxfVersion::AC1021);
}

#[test]
fn route_b_ac1024() {
    run_family(DxfVersion::AC1024);
}

#[test]
fn route_b_ac1027() {
    run_family(DxfVersion::AC1027);
}

#[test]
fn route_b_ac1032() {
    run_family(DxfVersion::AC1032);
}

#[test]
fn rejects_version_mismatch() {
    let bytes = fixture(DxfVersion::AC1018);
    let changes = patch::parse_changes(&json!({"version": "AC1032"}).to_string()).unwrap();
    let err = patch::save_bytes(&bytes, &changes).unwrap_err();
    assert!(err.contains("version mismatch"), "{err}");
}

#[test]
fn rejects_pre_r2004() {
    let bytes = fixture(DxfVersion::AC1015);
    let changes = patch::parse_changes(&json!({"version": "AC1015"}).to_string()).unwrap();
    let err = patch::save_bytes(&bytes, &changes).unwrap_err();
    assert!(err.contains("AC1018"), "{err}");
}