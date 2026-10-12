// WASM bridge for the @mlightcad/acad-rust-converter npm package.
//
// Two entry points are exposed to JavaScript:
//   * `dwg_to_dxf`  — Architecture A (MVP): read DWG bytes, emit ASCII DXF
//     bytes. The TypeScript converter then hands those bytes to the MIT
//     `AcDbNativeDxfConverter`, so no GPL code is involved.
//   * `dwg_to_json` — Architecture B (incremental): read DWG bytes, emit the
//     parsed document as serde JSON for future native `process*()` mapping.
//
// Both borrow the caller's in-memory byte slice directly (`DwgReader::from_stream`
// over a `Cursor<&[u8]>`) because browsers only hand us an `ArrayBuffer`; there
// is no filesystem in wasm32-unknown-unknown. Wrapping the slice in a `Cursor`
// without `to_vec` avoids copying the whole DWG once more inside wasm memory on
// top of the wasm-bindgen array handoff.
use acadrust::{DwgReader, DxfWriter};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

/// Convert a Rust error into a `JsValue` string so JS callers get a usable
/// diagnostic instead of an opaque abort.
fn to_js<E: std::fmt::Display>(context: &str) -> impl Fn(E) -> JsValue + '_ {
    move |err| JsValue::from_str(&format!("{context}: {err}"))
}

/// Architecture A: read DWG bytes and return ASCII DXF bytes.
#[wasm_bindgen]
pub fn dwg_to_dxf(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut reader = DwgReader::from_stream(Cursor::new(data));
    let doc = reader.read().map_err(to_js("acadrust DWG read failed"))?;
    DxfWriter::new(&doc)
        .write_to_vec()
        .map_err(to_js("acadrust DXF write failed"))
}

/// Architecture B: read DWG bytes and return the document as JSON (serde).
#[wasm_bindgen]
pub fn dwg_to_json(data: &[u8]) -> Result<String, JsValue> {
    let mut reader = DwgReader::from_stream(Cursor::new(data));
    let doc = reader.read().map_err(to_js("acadrust DWG read failed"))?;
    serde_json::to_string(&doc).map_err(to_js("acadrust JSON serialize failed"))
}
