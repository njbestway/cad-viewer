/**
 * Route-B incremental DWG save — public surface.
 *
 * Open-time capture hooks feed {@link DwgSaveJournal}; {@link wireDwgSave}
 * binds it to the document lifecycle; `getDwgSaveJournal(db)` + the converter's
 * `patchSave`/`patchAudit` (via {@link runRouteBSave}) perform the save.
 */
export {
  captureEntitySnapshot,
  captureOriginalBytes,
  captureSectionSnapshot,
  consumeDwgCapture,
  DwgSaveJournal,
  runRouteBSave,
  type DwgCapture
} from './DwgSaveJournal'
export { RouteBError, type RouteBErrorCode } from './RouteBError'
export { getDwgSaveJournal, wireDwgSave } from './wireDwgSave'