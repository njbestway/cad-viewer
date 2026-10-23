---
'@mlightcad/cad-simple-viewer': minor
'@mlightcad/cad-simple-viewer-cli': minor
'@mlightcad/three-renderer': minor
---

Replace the GPL-3.0 `@mlightcad/libredwg-converter` DWG parser with
`@njbestway/acad-rust-converter`, a copyleft-free DWG parser built on
acadrust (Rust/WASM, MPL-2.0).

- The converter (Rust crate + worker + `AcDbAcadRustConverter`) ships as the
  independently versioned `@njbestway/acad-rust-converter` npm package.
- Examples and the headless CLI now register the acadrust converter instead of
  libredwg.
- Fix TEXT/MTEXT rendering for tilted extrusion normals: world orientation is
  applied to the renderer's placement root (rotating about the anchor) instead
  of the `MText` wrapper, eliminating the rigid-offset displacement and restoring
  reliable hit-testing.
