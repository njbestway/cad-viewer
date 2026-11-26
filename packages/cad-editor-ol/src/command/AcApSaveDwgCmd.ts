import {
  AcApContext,
  AcApDocManager,
  AcApDxfConvertor,
  AcApI18n,
  AcEdCommand
} from '@mlightcad/cad-simple-viewer'
import {
  AcDbDatabaseConverterManager,
  AcDbFileType
} from '@mlightcad/data-model'
import type { AcDbAcadRustNativeConverter } from '@njbestway/acad-rust-converter'
import { ElMessage } from 'element-plus'

import { i18n } from '../locale'
import { getDwgSaveJournal, RouteBError, runRouteBSave } from '../save'

/**
 * WASM save memory ceiling (plan): original bytes + in-flight raw records +
 * output ≈ 3× file size. Larger drawings must use the native `patch_fixture`
 * path (same Rust engine) instead of the browser.
 */
const WASM_SAVE_SIZE_LIMIT = 64 * 1024 * 1024

/**
 * Saves the current drawing (SAVEDWG / QSAVE).
 *
 * Source-routed, never silently lossy:
 * - DWG source with a Route-B journal → incremental patch of the original
 *   bytes + mandatory fidelity audit, downloaded as `.dwg`.
 * - DWG source without a journal → hard error (a DXF fallback would drop
 *   entities the MVP cannot round-trip).
 * - DXF source / new drawing → the built-in lossless DXF export.
 *
 * Every {@link RouteBError} surfaces its machine-readable code to the user.
 */
export class AcApSaveDwgCmd extends AcEdCommand {
  async execute(_context: AcApContext) {
    const t = i18n.global.t
    const docManager = AcApDocManager.instance
    const doc = docManager.curDocument
    if (!doc) return

    const journal = getDwgSaveJournal(doc.database)
    if (!journal) {
      if (/\.dwg$/i.test(doc.fileName ?? '')) {
        ElMessage({
          message: t('main.message.saveDwgFailed', {
            code: 'no-original-bytes',
            message: t('main.message.saveDwgNoCapture')
          }),
          type: 'error',
          grouping: true,
          showClose: true
        })
        return
      }
      // DXF source or untitled drawing: DXF is the lossless native format.
      if (docManager.disableExport) return
      await this.withBusyIndicator(() => {
        new AcApDxfConvertor().convert()
      }, AcApI18n.t('main.message.exportingDxf'))
      return
    }

    if (journal.originalBytes.byteLength > WASM_SAVE_SIZE_LIMIT) {
      ElMessage({
        message: t('main.message.saveDwgTooLarge'),
        type: 'error',
        grouping: true,
        showClose: true
      })
      return
    }

    // Type-only import: the converter stays a devDependency (the host fork
    // registers it), so the capability is probed structurally at runtime.
    const converter = AcDbDatabaseConverterManager.instance.get(
      AcDbFileType.DWG
    ) as AcDbAcadRustNativeConverter | undefined
    if (
      !converter ||
      typeof converter.patchSave !== 'function' ||
      typeof converter.patchAudit !== 'function'
    ) {
      ElMessage({
        message: t('main.message.saveDwgFailed', {
          code: 'no-converter',
          message: t('main.message.saveDwgNoConverter')
        }),
        type: 'error',
        grouping: true,
        showClose: true
      })
      return
    }

    const baseName =
      (doc.fileName || doc.docTitle || 'drawing').replace(/\.[^.]+$/, '') ||
      'drawing'
    try {
      const { audit } = await this.withBusyIndicator(async () => {
        const result = await runRouteBSave(converter, journal)
        downloadBytes(result.bytes, `${baseName}.dwg`)
        return result
      }, t('main.message.savingDwg'))
      ElMessage({
        message: t('main.message.saveDwgSuccess', {
          name: `${baseName}.dwg`,
          count: audit.byte_exact
        }),
        type: 'success',
        grouping: true,
        showClose: true
      })
      // Accepted semantic-fidelity classes (compound / ACIS) stay visible.
      if (audit.semantic_mismatch > 0 || audit.reencoded_equal > 0) {
        ElMessage({
          message: t('main.message.saveDwgSemanticWarning', {
            reencoded: audit.reencoded_equal,
            semantic: audit.semantic_mismatch
          }),
          type: 'warning',
          grouping: true,
          showClose: true
        })
      }
    } catch (error) {
      const code = error instanceof RouteBError ? error.code : 'unknown'
      const message = error instanceof Error ? error.message : String(error)
      ElMessage({
        message: t('main.message.saveDwgFailed', { code, message }),
        type: 'error',
        grouping: true,
        showClose: true,
        duration: 0
      })
    }
  }
}

/**
 * True when a keydown is the Save shortcut (Ctrl+S, or Cmd+S on macOS)
 * that the viewer should handle instead of the browser's "save page".
 */
export function isSaveShortcut(
  e: Pick<
    KeyboardEvent,
    'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
  >
): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false
  return e.code === 'KeyS' || e.key === 's' || e.key === 'S'
}

/** Browser download of the patched DWG bytes (same pattern as the DXF export). */
function downloadBytes(bytes: ArrayBuffer, fileName: string): void {
  const blob = new Blob([bytes], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}