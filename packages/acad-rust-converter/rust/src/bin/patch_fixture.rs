//! Route-B PoC: original-DWG incremental patch round-trip matrix.
//!
//! Reads a source DWG (acadrust keeps every unedited entity's verbatim record
//! bytes in EntityCommon::raw_record), writes it back with DwgWriter, reads
//! the result and classifies each record:
//!   * byte_exact          - source raw bytes == saved raw bytes
//!   * reencoded_equal     - writer re-encoded, decoded model identical
//!   * unexpected_reencode - re-encoded although the passthrough gate allows
//!                           verbatim copying (byte-fidelity failure)
//!   * semantic_mismatch   - decoded model changed or record lost (hard failure)
//! Objects are compared semantically (their raw payloads are serde-skipped).
//! Then edit / erase / add cases run on cloned documents and assert that the
//! touched record changed as intended while every other byte-exact record
//! stayed byte-exact, erased handles never revive and adds land in model space.
//!
//! Usage: patch_fixture <input.dwg> <report.json>

use acad_rust_converter::patch::{apply_op, compare, owned_handles, snapshot, type_key, Snapshot};
use acadrust::{CadDocument, DwgReader, DwgWriter, EntityType, Handle, Line, Vector3};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::Cursor;
use std::time::Instant;

fn read_bytes(bytes: Vec<u8>) -> CadDocument {
    DwgReader::from_stream(Cursor::new(bytes))
        .read()
        .expect("read back saved dwg")
}

fn first_line(before: &Snapshot) -> Option<u64> {
    before
        .entities
        .iter()
        .find(|(_, (kind, _, _))| kind.as_str() == "Line")
        .map(|(h, _)| *h)
}

/// Root-cause probe for records the writer re-encoded despite holding verbatim
/// bytes. For a Table this exposes whether prepare_database_references fired a
/// block-record repair (null BLOCK/ENDBLK markers or a name/handle desync) that
/// rewrote the owning Table to an identical value, clearing its raw_record.
fn unexpected_detail(doc: &CadDocument, roundtrip: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for e in roundtrip["unexpected_reencode"].as_array().unwrap() {
        let h = e["handle"].as_u64().unwrap_or(0);
        let kind = e["type"].as_str().unwrap_or("").to_string();
        let mut d = json!({"handle": h, "type": kind});
        if kind == "Table" {
            if let Some(entity) = doc.get_entity(Handle::from(h)) {
                let v = serde_json::to_value(entity).unwrap_or(Value::Null);
                let t = &v["Table"];
                let brh = t["block_record_handle"].as_u64();
                let rec = brh.and_then(|bh| {
                    doc.block_records.iter().find(|r| r.handle.value() == bh)
                });
                d["table"] = json!({
                    "table_style_handle": t["table_style_handle"],
                    "block_record_handle": t["block_record_handle"],
                    "block_name": t["block_name"],
                    "record_found": rec.is_some(),
                    "record_handle": rec.map(|r| r.handle.value()),
                    "record_name": rec.map(|r| r.name.clone()),
                    "block_entity_null": rec.map(|r| r.block_entity_handle.is_null()),
                    "block_end_null": rec.map(|r| r.block_end_handle.is_null()),
                });
            }
        }
        out.push(d);
        if out.len() >= 6 {
            break;
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: patch_fixture <input.dwg> <report.json>");
        std::process::exit(2);
    }
    let started = Instant::now();
    let doc = DwgReader::from_file(&args[1])
        .expect("open source")
        .read()
        .expect("read source");
    let read_ms = started.elapsed().as_millis();
    let before = snapshot(&doc);

    // Attribute the writer's repair pass before blaming it: an associative
    // hatch whose boundary handles are absent or unresolvable gets "repaired"
    // on every save (associativity dropped, boundary reactors synthesized), so
    // count those in the source to tell a reader gap from genuinely stale data.
    let (mut assoc, mut no_boundary, mut unresolved) = (0usize, 0usize, 0usize);
    let mut unresolved_examples: Vec<Value> = Vec::new();
    for e in doc.entities() {
        if let EntityType::Hatch(h) = e {
            if !h.is_associative {
                continue;
            }
            assoc += 1;
            let boundaries: Vec<Handle> = h
                .paths
                .iter()
                .flat_map(|p| p.boundary_handles.iter().copied())
                .collect();
            if boundaries.is_empty() {
                no_boundary += 1;
            } else if boundaries.iter().any(|b| doc.get_entity(*b).is_none()) {
                unresolved += 1;
                if unresolved_examples.len() < 5 {
                    // A boundary handle that resolves to neither an entity nor an
                    // object dangles in the source (or was dropped by the reader).
                    let missing: Vec<Value> = boundaries
                        .iter()
                        .filter(|b| doc.get_entity(**b).is_none())
                        .take(3)
                        .map(|b| {
                            // Neighbouring handles show whether the boundary was folded
                            // into a compound parent (VERTEX/ATTRIB children) or is
                            // simply absent from the source model.
                            let neighbors: Vec<Value> = (b.value().saturating_sub(3)..=b.value() + 3)
                                .filter(|h| *h != b.value())
                                .filter_map(|h| {
                                    doc.get_entity(Handle::from(h)).map(|e| {
                                        let value = serde_json::to_value(e).expect("serde");
                                        let mut owns = Vec::new();
                                        owned_handles(&value, &mut owns);
                                        json!({
                                            "handle": h,
                                            "type": type_key(&value),
                                            "owns": owns,
                                        })
                                    })
                                })
                                .collect();
                            json!({
                                "handle": b.value(),
                                "in_objects": doc.objects.contains_key(b),
                                "neighbors": neighbors,
                            })
                        })
                        .collect();
                    unresolved_examples.push(json!({
                        "hatch": h.common.handle,
                        "missing": missing,
                    }));
                }
            }
        }
    }
    let source_audit = json!({
        "associative_hatches": assoc,
        "hatches_without_boundaries": no_boundary,
        "hatches_with_unresolved_boundaries": unresolved,
        "unresolved_examples": unresolved_examples,
        "reader_notifications": doc.notifications.len(),
        "notifications": serde_json::to_value(&doc.notifications).expect("notifications serde"),
    });

    let write_started = Instant::now();
    let saved_bytes = DwgWriter::write_to_vec(&doc).expect("write roundtrip");
    let write_ms = write_started.elapsed().as_millis();
    let saved = read_bytes(saved_bytes);
    let roundtrip = compare(&before, &saved, &BTreeSet::new());

    // A case is only accountable for damage it introduces itself. The writer's
    // repair pass already alters some untouched records on a plain round-trip,
    // so "others intact" means no NEW mismatch beyond that baseline.
    let baseline_bad: BTreeSet<u64> = roundtrip["semantic_mismatch"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["handle"].as_u64())
        .collect();
    let baseline_lost: BTreeSet<u64> = roundtrip["handles_lost"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|h| h.as_u64())
        .collect();
    let new_damage = |cmp: &Value, touched: &BTreeSet<u64>| -> Vec<Value> {
        let mut out = Vec::new();
        for e in cmp["semantic_mismatch"].as_array().unwrap() {
            let h = e["handle"].as_u64().unwrap_or(0);
            if !touched.contains(&h) && !baseline_bad.contains(&h) {
                out.push(e.clone());
            }
        }
        for h in cmp["handles_lost"].as_array().unwrap() {
            let h = h.as_u64().unwrap_or(0);
            if !touched.contains(&h) && !baseline_lost.contains(&h) {
                out.push(json!({"handle": h, "reason": "lost"}));
            }
        }
        out
    };

    // edit case: move one LINE endpoint through the serde-patch mechanism.
    let edit = match first_line(&before) {
        None => json!({"skipped": true}),
        Some(h) => {
            let mut edited = doc.clone();
            let entity = edited.get_entity_mut(Handle::from(h)).expect("entity");
            let mut value = serde_json::to_value(&*entity).expect("serde");
            let x = value["Line"]["start"]["x"].as_f64().expect("x") + 1.0;
            apply_op(&mut value, "replace", "/Line/start/x", Some(json!(x))).expect("apply op");
            *entity = serde_json::from_value(value.clone()).expect("deserialize");
            let bytes = DwgWriter::write_to_vec(&edited).expect("write edit");
            let after = read_bytes(bytes);
            let mut touched = BTreeSet::new();
            touched.insert(h);
            let cmp = compare(&before, &after, &touched);
            let ok_value = after
                .get_entity(Handle::from(h))
                .map(|e| serde_json::to_value(e).expect("serde") == value)
                .unwrap_or(false);
            json!({
                "handle": h,
                "semantic_ok": ok_value,
                "others_intact": new_damage(&cmp, &touched).is_empty(),
                "new_damage": new_damage(&cmp, &touched),
                "compare": cmp,
            })
        }
    };

    // erase case: remove one LINE and prove it never revives.
    let erase = match first_line(&before) {
        None => json!({"skipped": true}),
        Some(h) => {
            let mut erased = doc.clone();
            assert!(erased.remove_entity(Handle::from(h)).is_some());
            let bytes = DwgWriter::write_to_vec(&erased).expect("write erase");
            let after = read_bytes(bytes);
            let mut touched = BTreeSet::new();
            touched.insert(h);
            let cmp = compare(&before, &after, &touched);
            let gone = after.get_entity(Handle::from(h)).is_none()
                && !after.objects.contains_key(&Handle::from(h))
                && !after
                    .model_space_entities()
                    .any(|e| e.common().handle.value() == h);
            json!({
                "handle": h,
                "gone": gone,
                "others_intact": new_damage(&cmp, &touched).is_empty(),
                "new_damage": new_damage(&cmp, &touched),
                "model_space_after": cmp["model_space_after"],
            })
        }
    };

    // add case: a fresh LINE must land in model space with a new handle.
    let add = {
        let mut added = doc.clone();
        let h = added
            .add_entity(EntityType::Line(Line::from_points(
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(10.0, 10.0, 0.0),
            )))
            .expect("add entity");
        let bytes = DwgWriter::write_to_vec(&added).expect("write add");
        let after = read_bytes(bytes);
        let mut touched = BTreeSet::new();
        touched.insert(h.value());
        let cmp = compare(&before, &after, &touched);
        let present = after.get_entity(h).is_some()
            && after
                .model_space_entities()
                .any(|e| e.common().handle.value() == h.value());
        json!({
            "handle": h.value(),
            "present_in_model_space": present,
            "others_intact": new_damage(&cmp, &touched).is_empty(),
            "new_damage": new_damage(&cmp, &touched),
            "compare": cmp,
        })
    };

    // Correctness gate: nothing lost, nothing semantically altered, cases pass.
    let gate = roundtrip["semantic_mismatch"].as_array().unwrap().is_empty()
        && roundtrip["handles_lost"].as_array().unwrap().is_empty()
        && roundtrip["inventory_equal"].as_bool().unwrap()
        && edit["semantic_ok"].as_bool().unwrap_or(true)
        && edit["others_intact"].as_bool().unwrap_or(true)
        && erase["gone"].as_bool().unwrap_or(true)
        && erase["others_intact"].as_bool().unwrap_or(true)
        && add["present_in_model_space"].as_bool().unwrap()
        && add["others_intact"].as_bool().unwrap();

    // Byte-fidelity gate (the plan's 100% requirement): every record the writer
    // is allowed to copy verbatim must come back byte for byte. Re-encodes that
    // the passthrough gate rules out (compound / ACIS / Arch) are exempt.
    let byte_fidelity = roundtrip["unexpected_reencode"].as_array().unwrap().is_empty();

    let report = json!({
        "file": args[1],
        "version": format!("{:?}", doc.version),
        "entities": before.entities.len(),
        "objects": before.objects.len(),
        "read_ms": read_ms,
        "write_ms": write_ms,
        "total_ms": started.elapsed().as_millis(),
        "roundtrip": roundtrip,
        "unexpected_detail": unexpected_detail(&doc, &roundtrip),
        "source_audit": source_audit,
        "cases": {"edit": edit, "erase": erase, "add": add},
        "gate": gate,
        "byte_fidelity": byte_fidelity,
    });
    std::fs::write(&args[2], serde_json::to_string_pretty(&report).unwrap())
        .expect("write report");
    println!(
        "gate={} entities={} byte_exact={} reencoded={} unexpected={} mismatch={} object_diff={} lost={} gained={} edit={} erase={} add={} {}ms",
        gate,
        before.entities.len(),
        roundtrip["byte_exact"],
        roundtrip["reencoded_equal"].as_array().unwrap().len(),
        roundtrip["unexpected_reencode"].as_array().unwrap().len(),
        roundtrip["semantic_mismatch"].as_array().unwrap().len(),
        roundtrip["object_diff"].as_array().unwrap().len(),
        roundtrip["handles_lost"].as_array().unwrap().len(),
        roundtrip["handles_gained"].as_array().unwrap().len(),
        edit["semantic_ok"],
        erase["gone"],
        add["present_in_model_space"],
        started.elapsed().as_millis()
    );
    if !gate || !byte_fidelity {
        std::process::exit(1);
    }
}
