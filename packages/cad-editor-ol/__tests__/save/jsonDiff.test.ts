/**
 * Route-B covered-key RFC6902 diff — unit tests (pure, no data-model).
 */
import {
  coveredEqual,
  diffCovered,
  diffJson,
  jsonEqual,
  numEqual
} from '../../src/save/jsonDiff'

describe('numEqual', () => {
  it('accepts OCS round-trip noise within the relative epsilon', () => {
    expect(numEqual(1, 1 + 1e-12)).toBe(true)
    expect(numEqual(0, 6.1e-17)).toBe(true)
    expect(numEqual(1e6, 1e6 + 1e-4)).toBe(true)
  })
  it('rejects real edits and non-finite values', () => {
    expect(numEqual(1, 1.001)).toBe(false)
    expect(numEqual(NaN, NaN)).toBe(false)
    expect(numEqual(Infinity, Infinity)).toBe(true) // === fast path
  })
})

describe('diffJson (covered-key semantics)', () => {
  it('replaces a changed scalar leaf at its JSON pointer', () => {
    const ops = diffJson({ Line: { end: { x: 1, y: 2 } } }, { Line: { end: { x: 9, y: 2 } } })
    expect(ops).toEqual([{ op: 'replace', path: '/Line/end/x', value: 9 }])
  })

  it('never removes base-only provenance keys', () => {
    const base = { common: { handle: 5, reactors: [1, 2], extended_data: { records: [] } }, value: 'a' }
    const current = { common: { handle: 5 }, value: 'b' }
    const ops = diffJson(base, current)
    expect(ops).toEqual([{ op: 'replace', path: '/value', value: 'b' }])
  })

  it('adds keys absent from the base', () => {
    const ops = diffJson({ a: 1 }, { a: 1, b: { c: 2 } })
    expect(ops).toEqual([{ op: 'add', path: '/b', value: { c: 2 } }])
  })

  it('replaces arrays wholesale when they differ', () => {
    const ops = diffJson({ v: [1, 2, 3] }, { v: [1, 5, 3] })
    expect(ops).toEqual([{ op: 'replace', path: '/v', value: [1, 5, 3] }])
  })

  it('leaves epsilon-equal arrays alone', () => {
    expect(diffJson({ v: [1, 2] }, { v: [1 + 1e-12, 2] })).toEqual([])
  })

  it('escapes ~ and / in pointer tokens', () => {
    const ops = diffJson({ 'a/b~c': 1 }, { 'a/b~c': 2 })
    expect(ops).toEqual([{ op: 'replace', path: '/a~1b~0c', value: 2 }])
  })

  it('skips undefined current values entirely', () => {
    const ops: ReturnType<typeof diffJson> = []
    diffCovered({ a: 1 }, { a: undefined }, '', ops)
    expect(ops).toEqual([])
  })
})

describe('coveredEqual / jsonEqual', () => {
  it('coveredEqual ignores base-only keys but catches covered edits', () => {
    expect(coveredEqual({ a: 1, provenance: 'x' }, { a: 1 })).toBe(true)
    expect(coveredEqual({ a: 1 }, { a: 2 })).toBe(false)
  })
  it('jsonEqual requires exact key sets (unlike coveredEqual)', () => {
    expect(jsonEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false)
    expect(jsonEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(jsonEqual([1, [2, 3]], [1, [2, 3]])).toBe(true)
    expect(jsonEqual(null, null)).toBe(true)
    expect(jsonEqual(null, {})).toBe(false)
  })
})