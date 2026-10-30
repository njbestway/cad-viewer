/**
 * Drawing fixtures for the Phase 2.8 browser measurements.
 *
 * One generator, used by every spec in this phase, so the ERASE, MOVE and
 * resource-lifecycle numbers are measured on the *same* drawing: 60 % LINE /
 * 20 % LWPOLYLINE / 10 % INSERT / 10 % TEXT over three layers, cells 3×3 so a
 * pick point maps to exactly one entity.
 *
 * This is the Phase 2.6/2.7 fixture unchanged. Keeping it identical is the
 * point: a smaller or simpler drawing would make the latency numbers
 * incomparable with the phases that produced the baseline.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Box that covers every generated cell. */
export const WORLD_BOX = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }

function dxfPair(code: number, value: string | number) {
  return `${code}\n${value}\n`
}

function dxfLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  layer: string
) {
  return (
    dxfPair(0, 'LINE') +
    dxfPair(8, layer) +
    dxfPair(10, x1) +
    dxfPair(20, y1) +
    dxfPair(30, 0) +
    dxfPair(11, x2) +
    dxfPair(21, y2) +
    dxfPair(31, 0)
  )
}

function dxfPolyline(originX: number, originY: number, size: number) {
  return (
    dxfPair(0, 'LWPOLYLINE') +
    dxfPair(8, 'LINES') +
    dxfPair(90, 4) +
    dxfPair(70, 1) +
    dxfPair(10, originX) +
    dxfPair(20, originY) +
    dxfPair(10, originX + size) +
    dxfPair(20, originY) +
    dxfPair(10, originX + size) +
    dxfPair(20, originY + size) +
    dxfPair(10, originX) +
    dxfPair(20, originY + size)
  )
}

function dxfInsert(x: number, y: number, blockName: string) {
  return (
    dxfPair(0, 'INSERT') +
    dxfPair(8, 'MARKS') +
    dxfPair(2, blockName) +
    dxfPair(10, x) +
    dxfPair(20, y) +
    dxfPair(30, 0)
  )
}

function dxfText(x: number, y: number, value: string) {
  return (
    dxfPair(0, 'TEXT') +
    dxfPair(8, 'MARKS') +
    dxfPair(10, x) +
    dxfPair(20, y) +
    dxfPair(30, 0) +
    dxfPair(40, 2) +
    dxfPair(1, value)
  )
}

function dxfMText(x: number, y: number, value: string) {
  return (
    dxfPair(0, 'MTEXT') +
    dxfPair(8, 'MARKS') +
    dxfPair(10, x) +
    dxfPair(20, y) +
    dxfPair(30, 0) +
    dxfPair(40, 2) +
    dxfPair(1, value)
  )
}

/**
 * A closed five-vertex polyline with two bulges (arc segments).
 *
 * `dxfPolyline` above is a rectangle, which exercises the packed-batch path but
 * never the tessellation of a curved segment. Phase 2.13 Task G asks for a
 * "complex LWPOLYLINE" specifically, so this one has uneven edges and arcs.
 */
function dxfComplexPolyline(originX: number, originY: number) {
  const vertices: Array<[number, number, number]> = [
    [0, 0, 0],
    [4, 0, 0],
    [4, 3, 0.4142],
    [2, 5, 0],
    [0, 3, -0.4142]
  ]
  let body =
    dxfPair(0, 'LWPOLYLINE') +
    dxfPair(8, 'LINES') +
    dxfPair(90, vertices.length) +
    dxfPair(70, 1)
  for (const [dx, dy, bulge] of vertices) {
    body += dxfPair(10, originX + dx) + dxfPair(20, originY + dy)
    if (bulge !== 0) body += dxfPair(42, bulge)
  }
  return body
}

function dxfHead() {
  return (
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'HEADER') +
    dxfPair(9, '$ACADVER') +
    dxfPair(1, 'AC1015') +
    dxfPair(0, 'ENDSEC') +
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'TABLES') +
    dxfPair(0, 'TABLE') +
    dxfPair(2, 'LAYER') +
    dxfPair(70, 3) +
    dxfPair(0, 'LAYER') +
    dxfPair(2, '0') +
    dxfPair(70, 0) +
    dxfPair(62, 7) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(0, 'LAYER') +
    dxfPair(2, 'LINES') +
    dxfPair(70, 0) +
    dxfPair(62, 3) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(0, 'LAYER') +
    dxfPair(2, 'MARKS') +
    dxfPair(70, 0) +
    dxfPair(62, 5) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(0, 'ENDTAB') +
    dxfPair(0, 'ENDSEC')
  )
}

function dxfBlocks(blockName: string) {
  return (
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'BLOCKS') +
    dxfPair(0, 'BLOCK') +
    dxfPair(8, '0') +
    dxfPair(2, blockName) +
    dxfPair(70, 0) +
    dxfPair(10, 0) +
    dxfPair(20, 0) +
    dxfPair(30, 0) +
    dxfLine(0, 0, 2, 2, 'LINES') +
    dxfPair(0, 'ENDBLK') +
    dxfPair(8, '0') +
    dxfPair(0, 'ENDSEC')
  )
}

function dxfBlock(name: string, body: string) {
  return (
    dxfPair(0, 'BLOCK') +
    dxfPair(8, '0') +
    dxfPair(2, name) +
    dxfPair(70, 0) +
    dxfPair(10, 0) +
    dxfPair(20, 0) +
    dxfPair(30, 0) +
    body +
    dxfPair(0, 'ENDBLK') +
    dxfPair(8, '0')
  )
}

/**
 * Task G fixture: multi-level INSERT fragments plus the awkward entity kinds.
 *
 * `writeMixedFixture` is deliberately a single-level block so its ERASE / MOVE
 * numbers stay comparable with Phases 2.5-2.12. Task G also has to prove the
 * new wave lifecycle on nested fragments (INSERT -> INSERT -> LINE), where one
 * `INSERT` entry owns a child index that only exists once the parent converts,
 * and on TEXT / MTEXT / curved-LWPOLYLINE, whose batches are built by different
 * builders than a LINE.
 *
 * Geometry is laid out on an 8-unit grid so a pick point for one cell cannot
 * land inside another entity's box.
 */
export function writeNestedFixture(count: number, tag = 'p213g'): string {
  const leaf = `${tag.toUpperCase()}_LEAF`
  const mid = `${tag.toUpperCase()}_MID`
  const parts: string[] = []
  for (let index = 0; index < count; index++) {
    const x = (index % 8) * 8
    const y = Math.floor(index / 8) * 8
    const kind = index % 4
    if (kind < 2) parts.push(dxfInsert(x, y, mid))
    else if (kind === 2) parts.push(dxfMText(x, y, `M${index}`))
    else parts.push(dxfComplexPolyline(x, y))
  }
  const blocks =
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'BLOCKS') +
    dxfBlock(leaf, dxfLine(0, 0, 2, 2, 'LINES')) +
    // The middle block inserts the leaf and adds a horizontal line: its box is
    // therefore 2x2, so the box centre still lies on the diagonal child.
    dxfBlock(mid, dxfInsert(0, 0, leaf) + dxfLine(0, 0, 2, 0, 'LINES')) +
    dxfPair(0, 'ENDSEC')
  const file = path.join(os.tmpdir(), `${tag}-nested-${count}.dxf`)
  fs.writeFileSync(
    file,
    dxfHead() +
      blocks +
      dxfPair(0, 'SECTION') +
      dxfPair(2, 'ENTITIES') +
      parts.join('') +
      dxfPair(0, 'ENDSEC') +
      dxfPair(0, 'EOF'),
    'utf8'
  )
  return file
}

/**
 * Writes the mixed drawing and returns its path.
 *
 * @param count - Entity count; 50 000 for the Phase 2.6/2.7 comparable runs
 * @param tag - File-name tag so parallel specs do not fight over one temp file
 */
export function writeMixedFixture(count: number, tag = 'p28'): string {
  const parts: string[] = []
  const blockName = `${tag.toUpperCase()}_BLK`
  for (let index = 0; index < count; index++) {
    const x = (index % 100) * 3
    const y = Math.floor(index / 100) * 3
    const kind = index % 10
    if (kind < 6) parts.push(dxfLine(x, y, x + 2, y + 2, 'LINES'))
    else if (kind < 8) parts.push(dxfPolyline(x, y, 2))
    else if (kind === 8) parts.push(dxfInsert(x, y, blockName))
    else parts.push(dxfText(x, y, `E${index}`))
  }
  const file = path.join(os.tmpdir(), `${tag}-mixed-${count}.dxf`)
  fs.writeFileSync(
    file,
    dxfHead() +
      dxfBlocks(blockName) +
      dxfPair(0, 'SECTION') +
      dxfPair(2, 'ENTITIES') +
      parts.join('') +
      dxfPair(0, 'ENDSEC') +
      dxfPair(0, 'EOF'),
    'utf8'
  )
  return file
}
