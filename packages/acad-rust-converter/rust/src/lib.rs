// WASM bridge for the @mlightcad/acad-rust-converter npm package.
//
// Architecture A (`dwg_to_dxf`, MVP): read DWG bytes, emit ASCII DXF bytes. The
// TypeScript converter then hands those bytes to the MIT `AcDbNativeDxfConverter`,
// so no GPL code is involved. This stays the default and the fallback path.
//
// Architecture B (Phase 4, in progress): read a DWG once into a `CadDocument`
// that lives inside wasm linear memory for the duration of one conversion
// (`dwg_open` -> ... -> `dwg_close`), and expose it as *sections* / *entity
// pages* of serde JSON instead of one giant document dump. This is what avoids
// the whole-document OOM footgun that `dwg_to_json` (kept below for offline
// fixture generation only, never wired into the production worker protocol)
// would otherwise hit on large drawings.
//
// Both A and B borrow the caller's in-memory byte slice directly
// (`DwgReader::from_stream` over a `Cursor<&[u8]>`) because browsers only hand
// us an `ArrayBuffer`; there is no filesystem in wasm32-unknown-unknown.
// Wrapping the slice in a `Cursor` without `to_vec` avoids copying the whole
// DWG once more inside wasm memory on top of the wasm-bindgen array handoff.
//
// Slice 0 spike findings (checked against the vendored acadrust 0.6.3 source,
// not guessed from docs) that made the sectioned approach viable without any
// wrapper crate or fork:
//   * `CadDocument` derives `Serialize` under the (already enabled) `serde`
//     feature, so every non-`#[serde(skip)]` field type implements `Serialize`
//     individually - including `HeaderVariables`, every `Table<T>`, and
//     `DxfClassCollection`.
//   * Those section fields (`header`, `layers`, `line_types`, `text_styles`,
//     `block_records`, `dim_styles`, `app_ids`, `views`, `vports`, `ucss`,
//     `vx_table`, `classes`, `objects`, `summary_info`) are `pub` and reachable
//     directly from this crate.
//   * The flat entity store itself (`entities: Vec<Arc<EntityType>>`) is
//     `pub(crate)` - NOT field-accessible here - but the public iterator
//     methods `entities()`, `model_space_entities()` and
//     `entities_in_block(name)` expose the same data as `&EntityType`, which is
//     what gets paged below.
//   * `Handle` serializes as a plain `u64` number; `DxfVersion` as its variant
//     name string (e.g. "AC1032"); `EntityType` is an externally-tagged serde
//     enum, i.e. one JSON object whose single key is the variant name
//     (e.g. `{"Line": {...}}`) - the TypeScript model mirrors exactly that.
use acadrust::{CadDocument, DwgReader, DxfReader, DxfWriter};
use std::cell::RefCell;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

/// Convert a Rust error into a `JsValue` string so JS callers get a usable
/// diagnostic instead of an opaque abort.
fn to_js<E: std::fmt::Display>(context: &str) -> impl Fn(E) -> JsValue + '_ {
    move |err| JsValue::from_str(&format!("{context}: {err}"))
}

/// Serialize any (sub)section value to a JSON string, tagged with a
/// human-readable context prefix for the same diagnostic quality as `to_js`.
fn to_json<T: serde::Serialize>(context: &str, value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(to_js(context))
}

// ---------------------------------------------------------------------------
// Architecture A: single-shot DWG -> DXF.
// ---------------------------------------------------------------------------

/// Architecture A: read DWG bytes and return ASCII DXF bytes.
#[wasm_bindgen]
pub fn dwg_to_dxf(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut reader = DwgReader::from_stream(Cursor::new(data));
    let doc = reader.read().map_err(to_js("acadrust DWG read failed"))?;
    DxfWriter::new(&doc)
        .write_to_vec()
        .map_err(to_js("acadrust DXF write failed"))
}

/// Architecture A, DXF-input variant (benchmark only): read DXF bytes into a
/// `CadDocument` and re-emit ASCII DXF bytes. Analogous to [`dwg_to_dxf`] but
/// with [`DxfReader`] as the front end, so a `.dxf` can be pushed through the
/// acadrust pipeline (DXF -> CadDocument -> DXF -> the MIT TS DXF converter)
/// for A/B timing against the built-in DXF reader. `DxfReader::from_reader`
/// needs an owned `Read + Seek + 'static` source, hence the `to_vec` copy of
/// the caller's slice (browsers give us an `ArrayBuffer` view, not a file).
#[wasm_bindgen]
pub fn dxf_to_dxf(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let reader = DxfReader::from_reader(Cursor::new(data.to_vec()))
        .map_err(to_js("acadrust DXF read failed"))?;
    let doc = reader.read().map_err(to_js("acadrust DXF read failed"))?;
    DxfWriter::new(&doc)
        .write_to_vec()
        .map_err(to_js("acadrust DXF write failed"))
}

/// Architecture B (whole-document, unbounded): read DWG bytes and return the
/// document as one JSON string. NOT used by the production worker protocol -
/// serializing a large drawing in one shot is an OOM footgun (see the module
/// comment above). Kept only so the offline native dumper (`src/bin/
/// dump_fixture.rs`) and local fixtures can reuse the exact same serde schema
/// as the sectioned entry points below.
#[wasm_bindgen]
pub fn dwg_to_json(data: &[u8]) -> Result<String, JsValue> {
    let mut reader = DwgReader::from_stream(Cursor::new(data));
    let doc = reader.read().map_err(to_js("acadrust DWG read failed"))?;
    to_json("acadrust JSON serialize failed", &doc)
}

// ---------------------------------------------------------------------------
// Architecture B (Phase 4): handle-based sectioned access.
//
// The parsed `CadDocument` is held in wasm linear memory for the lifetime of a
// single conversion, addressed by an opaque `u32` handle, so the TypeScript
// side can pull it apart section by section / page by page instead of ever
// materializing the whole document as one JSON string.
// ---------------------------------------------------------------------------

thread_local! {
    /// Open documents, indexed by handle. `None` marks a slot released by
    /// `dwg_close`; `dwg_open` reuses a free slot before growing the vec, so a
    /// long-lived page (opening and closing many drawings) doesn't leak slots.
    static OPEN_DOCUMENTS: RefCell<Vec<Option<CadDocument>>> = const { RefCell::new(Vec::new()) };
}

/// Run `f` against the document behind `handle`, or a `JsValue` error if the
/// handle was never opened or has already been closed.
fn with_document<T>(
    handle: u32,
    f: impl FnOnce(&CadDocument) -> Result<T, JsValue>,
) -> Result<T, JsValue> {
    OPEN_DOCUMENTS.with(|slot| {
        let docs = slot.borrow();
        match docs.get(handle as usize) {
            Some(Some(doc)) => f(doc),
            Some(None) => Err(JsValue::from_str(&format!(
                "acad-rust handle {handle} was already closed."
            ))),
            None => Err(JsValue::from_str(&format!(
                "acad-rust handle {handle} does not exist (never opened)."
            ))),
        }
    })
}

/// Store a freshly parsed document in [`OPEN_DOCUMENTS`] (reusing a freed slot
/// when possible) and return its handle. Shared by [`dwg_open`] and
/// [`dxf_open`] so the sectioned read path is entirely format-agnostic once the
/// `CadDocument` is resident.
fn register_document(doc: CadDocument) -> u32 {
    OPEN_DOCUMENTS.with(|slot| {
        let mut docs = slot.borrow_mut();
        let free = docs.iter().position(Option::is_none);
        match free {
            Some(index) => {
                docs[index] = Some(doc);
                index as u32
            }
            None => {
                docs.push(Some(doc));
                (docs.len() - 1) as u32
            }
        }
    })
}

/// Parse DWG bytes, keep the resulting `CadDocument` alive in wasm memory, and
/// return its handle for later `dwg_meta` / `dwg_section_json` /
/// `dwg_entity_page` / `dwg_block_entity_page` / `dwg_close` calls.
#[wasm_bindgen]
pub fn dwg_open(data: &[u8]) -> Result<u32, JsValue> {
    let mut reader = DwgReader::from_stream(Cursor::new(data));
    let doc = reader.read().map_err(to_js("acadrust DWG read failed"))?;
    Ok(register_document(doc))
}

/// DXF-input companion to [`dwg_open`] (benchmark only): parse DXF bytes into a
/// `CadDocument` and register it under a handle. Every downstream sectioned
/// call (`dwg_meta` / `dwg_section_json` / `dwg_entity_page` /
/// `dwg_block_entity_page` / `dwg_close`) works unchanged, since it only ever
/// sees the resident document, never its origin format. This is what lets
/// Architecture-B map a `.dxf` straight from the acadrust `CadDocument` to the
/// database (DXF -> CadDocument -> JSON -> DB) for A/B timing.
#[wasm_bindgen]
pub fn dxf_open(data: &[u8]) -> Result<u32, JsValue> {
    let reader = DxfReader::from_reader(Cursor::new(data.to_vec()))
        .map_err(to_js("acadrust DXF open failed"))?;
    let doc = reader.read().map_err(to_js("acadrust DXF read failed"))?;
    Ok(register_document(doc))
}

/// Release the document behind `handle`. The slot stays reserved (as `None`)
/// for a later `dwg_open` to reuse, so handles never get silently renumbered.
#[wasm_bindgen]
pub fn dwg_close(handle: u32) {
    OPEN_DOCUMENTS.with(|slot| {
        let mut docs = slot.borrow_mut();
        if let Some(Some(_)) = docs.get(handle as usize) {
            docs[handle as usize] = None;
        }
    })
}

/// Bounded summary for progress reporting and pagination math: version, key
/// table/entity counts. Built with `serde_json::json!` (a `Value`, not a
/// derived struct) so this crate needs no direct `serde` dependency beyond
/// what `acadrust`'s `serde` feature and `serde_json` already pull in.
#[wasm_bindgen]
pub fn dwg_meta(handle: u32) -> Result<String, JsValue> {
    with_document(handle, |doc| {
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
        to_json("acadrust meta serialize failed", &value)
    })
}

/// Serialize one document section as JSON. `kind` selects which field to
/// serde; see `SECTION_KINDS` for the full list, kept in sync with the
/// TypeScript worker's validation of the same string.
///
/// Deliberately no "block-content" kind: block definitions are unbounded per
/// block name, so they are paged separately via `dwg_block_entity_page`
/// instead of ever being dumped whole.
#[wasm_bindgen]
pub fn dwg_section_json(handle: u32, kind: &str) -> Result<String, JsValue> {
    with_document(handle, |doc| match kind {
        "header" => to_json("acadrust header serialize failed", &doc.header),
        "summary-info" => to_json("acadrust summary info serialize failed", &doc.summary_info),
        "classes" => to_json("acadrust classes serialize failed", &doc.classes),
        "tables-layer" => to_json("acadrust layer table serialize failed", &doc.layers),
        "tables-ltype" => to_json("acadrust linetype table serialize failed", &doc.line_types),
        "tables-style" => to_json("acadrust text style table serialize failed", &doc.text_styles),
        "tables-blockrecord" => {
            to_json("acadrust block record table serialize failed", &doc.block_records)
        }
        "tables-dimstyle" => to_json("acadrust dim style table serialize failed", &doc.dim_styles),
        "tables-appid" => to_json("acadrust app id table serialize failed", &doc.app_ids),
        "tables-view" => to_json("acadrust view table serialize failed", &doc.views),
        "tables-vport" => to_json("acadrust vport table serialize failed", &doc.vports),
        "tables-ucs" => to_json("acadrust ucs table serialize failed", &doc.ucss),
        "tables-vx" => to_json("acadrust vx table serialize failed", &doc.vx_table),
        "objects" => to_json("acadrust objects serialize failed", &doc.objects),
        other => Err(JsValue::from_str(&format!(
            "Unknown acad-rust section kind: {other}"
        ))),
    })
}

/// One page of model-space entities (the primary drawable set), as a JSON
/// array of externally-tagged `EntityType` values. `offset`/`limit` bound the
/// wasm->JS payload so a huge drawing never materializes all its entities in
/// one string; the same-handle document stays resident between calls.
#[wasm_bindgen]
pub fn dwg_entity_page(handle: u32, offset: u32, limit: u32) -> Result<String, JsValue> {
    with_document(handle, |doc| {
        let page: Vec<_> = doc
            .model_space_entities()
            .skip(offset as usize)
            .take(limit as usize)
            .collect();
        to_json("acadrust entity page serialize failed", &page)
    })
}

/// One page of a named block definition's entities (see
/// `CadDocument::entities_in_block`), for the same bounded-payload reason as
/// `dwg_entity_page` but scoped to block geometry instead of model space.
#[wasm_bindgen]
pub fn dwg_block_entity_page(
    handle: u32,
    block_name: &str,
    offset: u32,
    limit: u32,
) -> Result<String, JsValue> {
    with_document(handle, |doc| {
        let page: Vec<_> = doc
            .entities_in_block(block_name)
            .skip(offset as usize)
            .take(limit as usize)
            .collect();
        to_json("acadrust block entity page serialize failed", &page)
    })
}

/// Exported for the TypeScript side to keep its worker-side validation of
/// `dwg_section_json`'s `kind` argument in sync with what Rust actually
/// accepts (checked by `packages/acad-rust-converter/__tests__` against the
/// worker's own list).
///
/// These entry points are only exercised through a JS/wasm runtime, so they
/// have no native `#[cfg(test)]` unit tests here: `wasm_bindgen::JsValue`
/// conversions (used for every error path above) abort under a native test
/// harness, since they call into the JS host glue directly.
pub const SECTION_KINDS: &[&str] = &[
    "header",
    "summary-info",
    "classes",
    "tables-layer",
    "tables-ltype",
    "tables-style",
    "tables-blockrecord",
    "tables-dimstyle",
    "tables-appid",
    "tables-view",
    "tables-vport",
    "tables-ucs",
    "tables-vx",
    "objects",
];
