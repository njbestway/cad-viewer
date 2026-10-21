//! Regression test: the pinned `acadrust` must READ an AC1009 (R12) binary DWG.
//!
//! This locks in the roadmap verdict for "File version compatibility
//! (R12–Latest)". The earlier handoff note claimed acadrust only handled
//! R13–R2018+ and rejected AC1009 DWG because "R12 has no handle model". That is
//! obsolete as of acadrust 0.6.5, which ships a dedicated pre-R13 codec
//! (`io::dwg::r12`) and dispatches `AC1009`/`AD1009` magic bytes to it before
//! the R13+ parser runs.
//!
//! We exercise the exact production entry point the wasm worker uses —
//! `DwgWriter` to emit bytes, `DwgReader::from_stream(..).read()` to parse them
//! back — so a future downgrade or upstream regression fails this test instead
//! of silently reopening the gap. It also asserts the R12 handle model is real
//! (each entity round-trips with a non-null 64-bit handle), which was the second
//! stated reason for rejecting R12 DWG.

use acadrust::{
    CadDocument, DwgReader, DwgWriter, DxfVersion, EntityType, Line, Point, Text, Vector3,
};
use std::io::Cursor;

/// Build a minimal R12 drawing with the native (pre-R13) entity set that the
/// AC1009 format actually supports: POINT, LINE, TEXT.
fn r12_document() -> CadDocument {
    let mut document = CadDocument::with_version(DxfVersion::AC1009);
    document
        .add_entity(EntityType::Point(Point::from_coords(1.0, 2.0, 0.0)))
        .unwrap();
    document
        .add_entity(EntityType::Line(Line::from_coords(
            0.0, 0.0, 0.0, 10.0, 5.0, 0.0,
        )))
        .unwrap();
    document
        .add_entity(EntityType::Text(Text::with_value(
            "R12",
            Vector3::new(0.0, 0.0, 0.0),
        )))
        .unwrap();
    document
}

#[test]
fn acadrust_reads_an_ac1009_binary_dwg() {
    let bytes = DwgWriter::write_to_vec(&r12_document()).expect("write AC1009 DWG");

    // The file really is an R12 DWG (magic header, not the R13+ AC1015+ layout).
    assert_eq!(&bytes[..6], b"AC1009", "writer did not emit an AC1009 header");

    let restored = DwgReader::from_stream(Cursor::new(bytes))
        .read()
        .expect("acadrust must read an AC1009 DWG (R12 support regression)");

    assert_eq!(restored.version, DxfVersion::AC1009);

    let mut point = 0;
    let mut line = 0;
    let mut text = 0;
    for entity in restored.entities() {
        match entity {
            EntityType::Point(_) => point += 1,
            EntityType::Line(_) => line += 1,
            EntityType::Text(_) => text += 1,
            other => panic!("unexpected non-native entity in R12 read: {other:?}"),
        }
    }
    assert_eq!((point, line, text), (1, 1, 1));
}

#[test]
fn ac1009_entities_round_trip_with_valid_handles() {
    // Second pillar of the old rejection: "R12 无 handle 模型". Prove every read
    // entity carries a non-null handle, so objectId/handle-based editing works.
    let bytes = DwgWriter::write_to_vec(&r12_document()).expect("write AC1009 DWG");
    let restored = DwgReader::from_stream(Cursor::new(bytes))
        .read()
        .expect("read AC1009 DWG");

    let handles: Vec<_> = restored
        .entities()
        .map(|entity| entity.common().handle)
        .collect();
    assert_eq!(handles.len(), 3, "expected three entities back");
    for handle in &handles {
        assert!(handle.is_valid(), "R12 entity has a null handle");
    }
    // Handles must be unique within the drawing (they key the edit path).
    let unique: std::collections::HashSet<_> = handles.iter().collect();
    assert_eq!(unique.len(), handles.len(), "duplicate handles in R12 read");
}
