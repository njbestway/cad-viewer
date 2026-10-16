/**
 * Opt into the experimental acad-ts DWG parser (MIT, pure TypeScript) for this
 * example app. Registered after LibreDWG + acad-rust, so it takes the DWG slot
 * (last writer wins) when enabled via the `?acadts=1` query flag.
 */
import { registerAcadTsConverter } from '@mlightcad/acad-ts-converter'

export function isAcadTsEnabled(): boolean {
  if (typeof location === 'undefined') {
    return false
  }
  return new URLSearchParams(location.search).get('acadts') === '1'
}

export { registerAcadTsConverter }
