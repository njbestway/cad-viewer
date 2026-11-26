//! Route-B incremental DWG patch engine, shared by the native PoC/regression
//! binary (`src/bin/patch_fixture.rs`), the permanent round-trip regression
//! (`tests/patch_roundtrip.rs`) and the wasm bridge (`src/lib.rs`).
//!
//! Keeping one implementation is the point: the byte-fidelity classification
//! the P0 matrix validated must be the exact code the browser runs, so a
//! native-only fix can never silently diverge from the wasm path (plan R5).
//!
//! Mechanism (acadrust 0.6.8 + the route-b-fidelity fork fix): reading a DWG
//! retains every unedited entity's verbatim record bytes in
//! `EntityCommon::raw_record`; `DwgWriter` re-frames those bytes untouched and
//! only re-serializes records whose `raw_record` was cleared. `get_entity_mut`,
//! `add_entity` and `remove_entity` clear it, so "unedited => byte-exact,
//! edited => re-encoded" needs no exclusion list. [`apply_changes`] drives
//! exactly those mutators from an RFC6902 change-set; [`audit_bytes`] writes the
//! result, reads it back and classifies every record against the source.
//!
//! Nothing here touches the filesystem: entry points take `&[u8]` and use
//! `Cursor`, so the module compiles unchanged for wasm32-unknown-unknown.

use acadrust::document::HeaderVariables;
use acadrust::objects::ObjectType;
use acadrust::{
    CadDocument, DwgReader, DwgWriter, DxfVersion, EntityType, Handle, Table, TableEntry,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

// ---------------------------------------------------------------------------
// RFC6902 over a serde_json tree (object keys and array indices).
// ---------------------------------------------------------------------------

/// Minimal RFC6902 replace/add/remove over a serde_json tree. Returns a hard
/// error string (rather than panicking) so a malformed patch surfaces to the
/// caller as a rejected save instead of an opaque abort.
pub fn apply_op(
    root: &mut Value,
    op: &str,
    path: &str,
    value: Option<Value>,
) -> Result<(), String> {
    let parts: Vec<&str> = path.split('/').skip(1).collect();
    let (last, parents) = parts
        .split_last()
        .ok_or_else(|| format!("empty RFC6902 path: {path}"))?;
    let mut node = root;
    for part in parents {
        node = match node {
            Value::Object(map) => map
                .get_mut(*part)
                .ok_or_else(|| format!("object path missing: {part}"))?,
            Value::Array(list) => {
                let idx: usize = part
                    .parse()
                    .map_err(|_| format!("array index expected: {part}"))?;
                list.get_mut(idx)
                    .ok_or_else(|| format!("array path out of range: {idx}"))?
            }
            _ => return Err(format!("scalar mid-path: {part}")),
        };
    }
    match (node, op) {
        (Value::Object(map), "remove") => {
            map.remove(*last);
        }
        (Value::Object(map), _) => {
            map.insert(
                (*last).to_string(),
                value.ok_or_else(|| "missing patch value".to_string())?,
            );
        }
        (Value::Array(list), "remove") => {
            let idx: usize = last
                .parse()
                .map_err(|_| format!("array index expected: {last}"))?;
            if idx >= list.len() {
                return Err(format!("array remove out of range: {idx}"));
            }
            list.remove(idx);
        }
        (Value::Array(list), "add") => {
            let idx: usize = last
                .parse()
                .map_err(|_| format!("array index expected: {last}"))?;
            if idx > list.len() {
                return Err(format!("array add out of range: {idx}"));
            }
            list.insert(idx, value.ok_or_else(|| "missing patch value".to_string())?);
        }
        (Value::Array(list), _) => {
            let idx: usize = last
                .parse()
                .map_err(|_| format!("array index expected: {last}"))?;
            if idx >= list.len() {
                return Err(format!("array replace out of range: {idx}"));
            }
            list[idx] = value.ok_or_else(|| "missing patch value".to_string())?;
        }
        _ => return Err(format!("scalar leaf: {last}")),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Change-set schema (the wire format the TypeScript SaveJournal produces).
// ---------------------------------------------------------------------------

/// One RFC6902 operation. `value` is absent for `remove`.
#[derive(serde::Deserialize)]
pub struct Op {
    pub op: String,
    pub path: String,
    #[serde(default)]
    pub value: Option<Value>,
}

/// An edited entity: its DWG handle plus the patch against its serde snapshot.
#[derive(serde::Deserialize)]
pub struct Modified {
    pub handle: u64,
    #[serde(default)]
    pub patch: Vec<Op>,
}

/// A new entity: full serde `EntityType` JSON plus an optional owner block
/// handle. A null/absent owner lands in model space (see `add_entity`).
#[derive(serde::Deserialize)]
pub struct Added {
    #[serde(default)]
    pub owner: Option<u64>,
    pub entity: Value,
}

/// A named table entry edit (layer colour, linetype, text style, ...).
#[derive(serde::Deserialize)]
pub struct EntryPatch {
    pub name: String,
    #[serde(default)]
    pub patch: Vec<Op>,
}

/// Per-table entry patches. Only the MVP-covered tables are wired; each maps
/// to the same-named `CadDocument` field.
#[derive(serde::Deserialize, Default)]
pub struct TablePatches {
    #[serde(default)]
    pub layer: Vec<EntryPatch>,
    #[serde(default)]
    pub ltype: Vec<EntryPatch>,
    #[serde(default)]
    pub style: Vec<EntryPatch>,
    #[serde(default)]
    pub dimstyle: Vec<EntryPatch>,
    #[serde(default)]
    pub appid: Vec<EntryPatch>,
    #[serde(default)]
    pub view: Vec<EntryPatch>,
    #[serde(default)]
    pub vport: Vec<EntryPatch>,
    #[serde(default)]
    pub ucs: Vec<EntryPatch>,
    #[serde(default)]
    pub blockrecord: Vec<EntryPatch>,
}

/// The full change-set. `version` must equal the source document's version:
/// Route-B only saves same-version (no cross-version transcode).
#[derive(serde::Deserialize)]
pub struct Changes {
    pub version: String,
    #[serde(default)]
    pub modified: Vec<Modified>,
    #[serde(default)]
    pub added: Vec<Added>,
    #[serde(default)]
    pub erased: Vec<u64>,
    #[serde(default)]
    pub header: Vec<Op>,
    #[serde(default)]
    pub tables: TablePatches,
}

/// What [`apply_changes`] touched, so the audit can exempt intentional edits
/// from the byte-exact / semantic-equality requirements.
pub struct Applied {
    /// Modified + erased + added handles (all intentional changes).
    pub touched: BTreeSet<u64>,
    /// Handles allocated for added entities, in request order.
    pub added: Vec<u64>,
}

/// Parse the change-set JSON, mapping serde errors to a hard error string.
pub fn parse_changes(json: &str) -> Result<Changes, String> {
    serde_json::from_str(json).map_err(|e| format!("changes JSON parse failed: {e}"))
}

/// Apply a change-set to a resident document through acadrust's mutators, which
/// clear `raw_record` on exactly the records being changed. Every failure is a
/// hard error (no silent skip): a patch that cannot be applied must reject the
/// save rather than drop an edit.
pub fn apply_changes(doc: &mut CadDocument, changes: &Changes) -> Result<Applied, String> {
    // Same-version gate. DxfVersion serdes as its variant name ("AC1024").
    let doc_version = serde_json::to_value(doc.version)
        .map_err(|e| format!("version serialize failed: {e}"))?;
    if doc_version.as_str() != Some(changes.version.as_str()) {
        return Err(format!(
            "version mismatch: changes={} doc={}",
            changes.version, doc_version
        ));
    }
    // Route-B passthrough requires the R2004+ object map; pre-R2004 (AC1009 /
    // AC1012 / AC1014 / AC1015) has no verbatim record layer to preserve.
    if doc.version < DxfVersion::AC1018 {
        return Err(format!(
            "Route-B save requires AC1018 (R2004) or newer; source is {}",
            doc_version
        ));
    }

    let mut touched = BTreeSet::new();
    let mut added = Vec::new();

    // modified: get_entity_mut clears raw_record, then patch the serde tree and
    // deserialize back into the same slot (the exact PoC edit mechanism).
    for m in &changes.modified {
        let handle = Handle::from(m.handle);
        let entity = doc
            .get_entity_mut(handle)
            .ok_or_else(|| format!("modified handle {} not found", m.handle))?;
        let mut value =
            serde_json::to_value(&*entity).map_err(|e| format!("entity serde failed: {e}"))?;
        for op in &m.patch {
            apply_op(&mut value, &op.op, &op.path, op.value.clone())
                .map_err(|e| format!("modified handle {} patch failed: {e}", m.handle))?;
        }
        *entity = serde_json::from_value::<EntityType>(value).map_err(|e| {
            format!("modified handle {} deserialize failed: {e}", m.handle)
        })?;
        touched.insert(m.handle);
    }

    // erased: remove_entity also drops owned sub-entities / objects.
    for h in &changes.erased {
        doc.remove_entity(Handle::from(*h))
            .ok_or_else(|| format!("erased handle {h} not found"))?;
        touched.insert(*h);
    }

    // added: deserialize a full EntityType, route it to the requested owner
    // block (or model space), let add_entity allocate a fresh handle.
    for a in &changes.added {
        let mut entity = serde_json::from_value::<EntityType>(a.entity.clone())
            .map_err(|e| format!("added entity deserialize failed: {e}"))?;
        if let Some(owner) = a.owner {
            entity.common_mut().owner_handle = Handle::from(owner);
        }
        let h = doc
            .add_entity(entity)
            .map_err(|e| format!("add_entity failed: {e}"))?;
        added.push(h.value());
        touched.insert(h.value());
    }

    // header variables: same RFC6902 mechanism over the serde tree.
    if !changes.header.is_empty() {
        let mut value = serde_json::to_value(&doc.header)
            .map_err(|e| format!("header serde failed: {e}"))?;
        for op in &changes.header {
            apply_op(&mut value, &op.op, &op.path, op.value.clone())
                .map_err(|e| format!("header patch failed: {e}"))?;
        }
        doc.header = serde_json::from_value::<HeaderVariables>(value)
            .map_err(|e| format!("header deserialize failed: {e}"))?;
    }

    // tables: per-named-entry patches.
    patch_table(&mut doc.layers, &changes.tables.layer, "layer")?;
    patch_table(&mut doc.line_types, &changes.tables.ltype, "ltype")?;
    patch_table(&mut doc.text_styles, &changes.tables.style, "style")?;
    patch_table(&mut doc.dim_styles, &changes.tables.dimstyle, "dimstyle")?;
    patch_table(&mut doc.app_ids, &changes.tables.appid, "appid")?;
    patch_table(&mut doc.views, &changes.tables.view, "view")?;
    patch_table(&mut doc.vports, &changes.tables.vport, "vport")?;
    patch_table(&mut doc.ucss, &changes.tables.ucs, "ucs")?;
    patch_table(&mut doc.block_records, &changes.tables.blockrecord, "blockrecord")?;

    Ok(Applied { touched, added })
}

/// Patch named entries of one table in place through the same RFC6902 mechanism.
fn patch_table<T>(table: &mut Table<T>, patches: &[EntryPatch], label: &str) -> Result<(), String>
where
    T: TableEntry + serde::Serialize + DeserializeOwned,
{
    for p in patches {
        let entry = table
            .get_mut(&p.name)
            .ok_or_else(|| format!("{label} table entry '{}' not found", p.name))?;
        let mut value = serde_json::to_value(&*entry)
            .map_err(|e| format!("{label} entry serde failed: {e}"))?;
        for op in &p.patch {
            apply_op(&mut value, &op.op, &op.path, op.value.clone())
                .map_err(|e| format!("{label} entry '{}' patch failed: {e}", p.name))?;
        }
        *entry = serde_json::from_value::<T>(value)
            .map_err(|e| format!("{label} entry '{}' deserialize failed: {e}", p.name))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Save / audit entry points (byte slices, wasm-compatible).
// ---------------------------------------------------------------------------

/// Read the source DWG, apply the change-set and write the result back to bytes.
/// The fast save path: no read-back audit (the caller can run [`audit_bytes`]
/// separately when it needs the fidelity report).
pub fn save_bytes(original: &[u8], changes: &Changes) -> Result<Vec<u8>, String> {
    let mut doc = DwgReader::from_stream(Cursor::new(original))
        .read()
        .map_err(|e| format!("acadrust DWG read failed: {e}"))?;
    apply_changes(&mut doc, changes)?;
    DwgWriter::write_to_vec(&doc).map_err(|e| format!("acadrust DWG write failed: {e}"))
}

/// Read the source, apply the change-set, write, read the result back and
/// classify every record against the source snapshot. Returns the classification
/// stats plus a hard-error list (byte-fidelity loss, untouched semantic damage,
/// untouched handle loss). Object-level diffs are reported as stats, not hard
/// errors: the P0 matrix accepted benign XRecord/Arch normalisation there.
pub fn audit_bytes(original: &[u8], changes: &Changes) -> Result<Value, String> {
    let mut doc = DwgReader::from_stream(Cursor::new(original))
        .read()
        .map_err(|e| format!("acadrust DWG read failed: {e}"))?;
    let before = snapshot(&doc);
    let applied = apply_changes(&mut doc, changes)?;
    let bytes =
        DwgWriter::write_to_vec(&doc).map_err(|e| format!("acadrust DWG write failed: {e}"))?;
    let saved = DwgReader::from_stream(Cursor::new(bytes))
        .read()
        .map_err(|e| format!("acadrust DWG read-back failed: {e}"))?;
    let cmp = compare(&before, &saved, &applied.touched);

    // `compare` already exempts touched handles from semantic_mismatch /
    // unexpected_reencode / object_diff, but `handles_lost` is raw: an erased
    // handle is *supposed* to disappear, so filter the intentional ones out.
    let lost_hard: Vec<u64> = cmp["handles_lost"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|h| h.as_u64())
        .filter(|h| !applied.touched.contains(h))
        .collect();

    let mut hard_errors = Vec::new();
    for e in cmp["unexpected_reencode"].as_array().unwrap() {
        hard_errors.push(json!({"kind": "unexpected_reencode", "detail": e}));
    }
    for e in cmp["semantic_mismatch"].as_array().unwrap() {
        hard_errors.push(json!({"kind": "semantic_mismatch", "detail": e}));
    }
    for h in &lost_hard {
        hard_errors.push(json!({"kind": "lost", "handle": h}));
    }

    Ok(json!({
        "version": format!("{:?}", doc.version),
        "applied": {
            "modified": changes.modified.len(),
            "erased": changes.erased.len(),
            "added": applied.added,
        },
        "byte_exact": cmp["byte_exact"],
        "reencoded_equal": cmp["reencoded_equal"].as_array().unwrap().len(),
        "unexpected_reencode": cmp["unexpected_reencode"].as_array().unwrap().len(),
        "no_source_bytes": cmp["no_source_bytes"].as_array().unwrap().len(),
        "semantic_mismatch": cmp["semantic_mismatch"].as_array().unwrap().len(),
        "object_diff": cmp["object_diff"].as_array().unwrap().len(),
        "handles_lost": lost_hard.len(),
        "handles_gained": cmp["handles_gained"].as_array().unwrap().len(),
        "byte_fidelity": cmp["unexpected_reencode"].as_array().unwrap().is_empty(),
        "hard_errors": hard_errors,
        "ok": hard_errors.is_empty(),
        "compare": cmp,
    }))
}

// ---------------------------------------------------------------------------
// Fidelity classification (extracted verbatim from the validated P0 PoC).
// ---------------------------------------------------------------------------

/// Externally-tagged serde enum key ("Line", "LwPolyline", ...).
pub fn type_key(value: &Value) -> String {
    value
        .as_object()
        .and_then(|o| o.keys().next())
        .cloned()
        .unwrap_or_else(|| "?".to_string())
}

/// Per-handle source image: kind, verbatim record bytes (if retained) and the
/// decoded serde model. Objects carry no raw payload (serde-skipped).
pub struct Snapshot {
    pub entities: BTreeMap<u64, (String, Option<Vec<u8>>, Value)>,
    pub objects: BTreeMap<u64, Value>,
    pub model_space: BTreeSet<u64>,
}

/// Render a serde leaf compactly so a diff entry stays readable.
fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.chars().count() > 100 {
        let head: String = s.chars().take(100).collect();
        format!("{}...", head)
    } else {
        s
    }
}

/// Collect up to cap differing leaf paths between two serde trees, so a
/// semantic mismatch is actionable instead of a bare handle list.
fn diff_paths(a: &Value, b: &Value, path: &str, out: &mut Vec<String>, cap: usize) {
    if out.len() >= cap {
        return;
    }
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for (k, v) in x {
                let p = format!("{}/{}", path, k);
                match y.get(k) {
                    None => out.push(format!("{} removed", p)),
                    Some(w) => diff_paths(v, w, &p, out, cap),
                }
                if out.len() >= cap {
                    return;
                }
            }
            for k in y.keys() {
                if !x.contains_key(k) {
                    out.push(format!("{}/{} added", path, k));
                }
                if out.len() >= cap {
                    return;
                }
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                out.push(format!("{} len {} -> {}", path, x.len(), y.len()));
                return;
            }
            for (i, (v, w)) in x.iter().zip(y.iter()).enumerate() {
                diff_paths(v, w, &format!("{}/{}", path, i), out, cap);
                if out.len() >= cap {
                    return;
                }
            }
        }
        _ => {
            if a != b {
                out.push(format!("{} {} -> {}", path, short(a), short(b)));
            }
        }
    }
}

/// Up to 12 differing leaf paths between two serde trees.
pub fn paths(a: &Value, b: &Value) -> Vec<String> {
    let mut out = Vec::new();
    diff_paths(a, b, "", &mut out, 12);
    out
}

/// Dictionary key that owns this handle, so an object diff can be traced back
/// to the application data it belongs to (ADVMATERIAL, ACAD_LAYOUT, ...).
fn owner_entry_name(doc: &CadDocument, handle: u64) -> Option<String> {
    for obj in doc.objects.values() {
        if let ObjectType::Dictionary(d) = obj {
            for (name, h) in &d.entries {
                if h.value() == handle {
                    return Some(name.clone());
                }
            }
        }
    }
    None
}

/// Entry-level before/after for a differing XRecord: the group code identifies
/// which payload the writer changed, a bare byte offset does not.
fn xrecord_entry_diff(a: &Value, b: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let (Some(xa), Some(xb)) = (
        a["XRecord"]["entries"].as_array(),
        b["XRecord"]["entries"].as_array(),
    ) {
        for (i, (ea, eb)) in xa.iter().zip(xb.iter()).enumerate() {
            if ea != eb {
                // XRecord payloads are key(102)/value pairs: name the key so a
                // changed flag can be traced to the property it belongs to.
                let key = if i > 0 && xa[i - 1]["code"] == json!(102) {
                    xa[i - 1]["value"].clone()
                } else {
                    Value::Null
                };
                out.push(json!({
                    "index": i,
                    "code": ea["code"],
                    "key": key,
                    "before": ea["value"],
                    "after": eb["value"],
                }));
                if out.len() >= 8 {
                    break;
                }
            }
        }
    }
    out
}

/// Capture the source image of every entity (kind + verbatim bytes + serde
/// model), every object (serde model) and the model-space handle set.
pub fn snapshot(doc: &CadDocument) -> Snapshot {
    let mut entities = BTreeMap::new();
    for e in doc.entities() {
        let value = serde_json::to_value(e).expect("entity serde");
        let raw = e.common().raw_record.as_ref().map(|r| r.data.clone());
        entities.insert(e.common().handle.value(), (type_key(&value), raw, value));
    }
    let mut objects = BTreeMap::new();
    for (h, o) in &doc.objects {
        objects.insert(h.value(), serde_json::to_value(o).expect("object serde"));
    }
    let model_space = doc
        .model_space_entities()
        .map(|e| e.common().handle.value())
        .collect();
    Snapshot {
        entities,
        objects,
        model_space,
    }
}

/// Every handle named anywhere in a serde tree - for a compound parent this
/// lists the child records the reader folded into it (VERTEX/ATTRIB/SEQEND).
pub fn owned_handles(value: &Value, out: &mut Vec<u64>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                if k == "handle" || k == "seqend_handle" {
                    if let Some(h) = v.as_u64() {
                        if !out.contains(&h) {
                            out.push(h);
                        }
                    }
                }
                owned_handles(v, out);
                if out.len() >= 16 {
                    return;
                }
            }
        }
        Value::Array(list) => {
            for v in list {
                owned_handles(v, out);
                if out.len() >= 16 {
                    return;
                }
            }
        }
        _ => {}
    }
}

/// Whether the writer re-encodes this entity even when it was never edited.
/// Mirrors the passthrough gate in object_writer/entities.rs: compound owners
/// (VERTEX/ATTRIB/SEQEND children), ACIS bodies on R2013+, Arch extensions and
/// R2018+ frame-only MText cannot be copied verbatim. Those records are held to
/// semantic equality instead of byte equality.
pub fn expected_reencode(kind: &str, value: &Value, version: DxfVersion) -> bool {
    match kind {
        "Polyline" | "Polyline2D" | "Polyline3D" | "PolyfaceMesh" | "PolygonMesh" => true,
        "Insert" => {
            value["Insert"]["attributes"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
                || !value["Insert"]["seqend_handle"].is_null()
        }
        "Solid3D" | "Region" | "Body" | "Surface" => version >= DxfVersion::AC1027,
        "MText" => {
            version >= DxfVersion::AC1032
                && value["MText"]["background_fill_flags"]
                    .as_i64()
                    .unwrap_or(0)
                    & 0x11
                    == 0x10
        }
        "Extended" => true,
        _ => false,
    }
}

/// Compare a saved document against the source snapshot. Touched handles are
/// exempt from the byte-exact requirement (they were edited on purpose).
pub fn compare(before: &Snapshot, after: &CadDocument, touched: &BTreeSet<u64>) -> Value {
    let saved = snapshot(after);
    let (mut byte_exact, mut reencoded, mut mismatch) = (0usize, Vec::new(), Vec::new());
    let mut unexpected = Vec::new();
    let mut no_source_bytes = Vec::new();
    for (h, (kind, raw, value)) in &before.entities {
        match saved.entities.get(h) {
            None => {
                // An erased record is supposed to disappear; only an unexpected
                // disappearance counts as damage.
                if !touched.contains(h) {
                    mismatch.push(json!({"handle": h, "type": kind, "reason": "lost"}));
                }
            }
            Some((kind2, raw2, value2)) => {
                if touched.contains(h) {
                    continue;
                }
                if raw.is_some() && raw.as_deref() == raw2.as_deref() {
                    byte_exact += 1;
                    continue;
                }
                // Not verbatim. The writer either re-encoded on purpose (compound
                // owner, ACIS, Arch, ...) or lost the passthrough - both are only
                // acceptable while the decoded model stays identical.
                let expected = expected_reencode(kind, value, after.version);
                let mut entry = json!({
                    "handle": h,
                    "type": kind,
                    "type_after": kind2,
                    "expected_reencode": expected,
                    "raw_before": raw.is_some(),
                    "raw_after": raw2.is_some(),
                    "semantic_equal": value == value2,
                });
                if value == value2 {
                    if !expected {
                        if raw.is_some() {
                            // The writer had verbatim bytes and chose to re-encode:
                            // a real byte-fidelity loss (repair pass, owner fixup).
                            unexpected.push(json!({"handle": h, "type": kind}));
                        } else {
                            // The reader never retained bytes for this record (it
                            // re-derived the owning block handle), so the writer had
                            // nothing to copy. Not a writer fidelity failure.
                            no_source_bytes.push(json!({"handle": h, "type": kind}));
                        }
                    }
                    reencoded.push(entry);
                } else {
                    entry["paths"] = json!(paths(value, value2));
                    mismatch.push(entry);
                }
            }
        }
    }
    let mut object_diff = Vec::new();
    for (h, value) in &before.objects {
        match saved.objects.get(h) {
            None => {
                object_diff.push(json!({"handle": h, "type": type_key(value), "reason": "lost"}))
            }
            Some(value2) => {
                if value != value2 && !touched.contains(h) {
                    let kind = type_key(value);
                    let mut entry = json!({
                        "handle": h,
                        "type": kind,
                        "reason": "semantic",
                        "owner_name": owner_entry_name(after, *h),
                        "paths": paths(value, value2),
                    });
                    if kind == "XRecord" {
                        entry["entries"] = json!(xrecord_entry_diff(value, value2));
                    }
                    object_diff.push(entry);
                }
            }
        }
    }
    let lost: Vec<u64> = before
        .entities
        .keys()
        .chain(before.objects.keys())
        .filter(|h| !saved.entities.contains_key(*h) && !saved.objects.contains_key(*h))
        .copied()
        .collect();
    let gained: Vec<u64> = saved
        .entities
        .keys()
        .chain(saved.objects.keys())
        .filter(|h| !before.entities.contains_key(*h) && !before.objects.contains_key(*h))
        .copied()
        .collect();
    let inventory_before: BTreeMap<&String, usize> = count_kinds(&before.entities);
    let inventory_after: BTreeMap<&String, usize> = count_kinds(&saved.entities);
    json!({
        "byte_exact": byte_exact,
        "reencoded_equal": reencoded,
        "unexpected_reencode": unexpected,
        "no_source_bytes": no_source_bytes,
        "semantic_mismatch": mismatch,
        "object_diff": object_diff,
        "handles_lost": lost,
        "handles_gained": gained,
        "inventory_equal": inventory_before == inventory_after,
        "model_space_before": before.model_space.len(),
        "model_space_after": saved.model_space.len(),
    })
}

fn count_kinds(map: &BTreeMap<u64, (String, Option<Vec<u8>>, Value)>) -> BTreeMap<&String, usize> {
    let mut out = BTreeMap::new();
    for (kind, _, _) in map.values() {
        *out.entry(kind).or_insert(0) += 1;
    }
    out
}