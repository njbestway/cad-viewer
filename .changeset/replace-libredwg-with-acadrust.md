---
'@mlightcad/acad-rust-converter': minor
'@mlightcad/cad-simple-viewer': minor
'@mlightcad/cad-simple-viewer-cli': minor
'@mlightcad/three-renderer': minor
---

Replace the GPL-3.0 `@mlightcad/libredwg-converter` DWG parser with
`@mlightcad/acad-rust-converter`, a copyleft-free DWG→DXF converter built on
acadrust (Rust/WASM, MPL-2.0).

- New package `@mlightcad/acad-rust-converter` (Rust crate + worker +
  `AcDbAcadRustConverter`) is published in lockstep with the viewer release line.
- Examples and the headless CLI now register the acadrust converter instead of
  libredwg.
- Fix TEXT/MTEXT rendering for tilted extrusion normals: world orientation is
  applied to the renderer's placement root (rotating about the anchor) instead
  of the `MText` wrapper, eliminating the rigid-offset displacement and restoring
  reliable hit-testing.
