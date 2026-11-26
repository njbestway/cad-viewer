/**
 * Route-B save wiring: binds the open-time capture session to the document
 * lifecycle. The converter hooks (`captureOriginalBytes` / `captureEntitySnapshot`
 * / `captureSectionSnapshot`) fill a module-level pending capture while `read()`
 * runs; on `documentActivated` the capture is consumed and a
 * {@link DwgSaveJournal} is attached to the document's database. Tab switches
 * re-fire `documentActivated` with no pending capture — the existing journal
 * survives. `documentToBeDestroyed` disposes it.
 *
 * DXF documents never feed the capture hooks, so they get no journal and
 * Route-B save is unavailable there by construction (plan: DXF keeps dxfOut).
 */
import {
  AcApDocManager,
  type AcDbDocumentEventArgs
} from '@mlightcad/cad-simple-viewer'
import type { AcDbDatabase } from '@mlightcad/data-model'

import { consumeDwgCapture, DwgSaveJournal } from './DwgSaveJournal'

const journals = new WeakMap<AcDbDatabase, DwgSaveJournal>()

/** The Route-B journal for a database, or undefined (DXF source / not wired). */
export function getDwgSaveJournal(
  db: AcDbDatabase
): DwgSaveJournal | undefined {
  return journals.get(db)
}

/**
 * Subscribe the document manager. Safe to call before `createInstance`
 * finishes (retries on the microtask queue, mirroring `AcApToolbarDocBind`).
 * Returns an unsubscribe function.
 */
export function wireDwgSave(): () => void {
  let stopped = false
  let bound: AcApDocManager | undefined

  const onActivated = (args: AcDbDocumentEventArgs): void => {
    const cap = consumeDwgCapture()
    // No capture => tab switch or DXF open; keep any existing journal.
    if (!cap?.originalBytes) return
    const db = args.doc.database
    journals.get(db)?.dispose()
    journals.set(db, new DwgSaveJournal(db, cap))
  }

  const onDestroyed = (args: AcDbDocumentEventArgs): void => {
    const db = args.doc.database
    journals.get(db)?.dispose()
    journals.delete(db)
  }

  const attach = (attempt: number): void => {
    if (stopped) return
    const dm = AcApDocManager.tryGetInstance()
    if (!dm) {
      if (attempt < 20) queueMicrotask(() => attach(attempt + 1))
      return
    }
    bound = dm
    dm.events.documentActivated.addEventListener(onActivated)
    dm.events.documentToBeDestroyed.addEventListener(onDestroyed)
  }
  attach(0)

  return () => {
    stopped = true
    bound?.events.documentActivated.removeEventListener(onActivated)
    bound?.events.documentToBeDestroyed.removeEventListener(onDestroyed)
    bound = undefined
  }
}