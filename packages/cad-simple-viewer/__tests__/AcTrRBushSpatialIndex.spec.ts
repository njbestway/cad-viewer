import { AcTrRBushSpatialIndex } from '../src/spatialIndex/AcTrRBushSpatialIndex'

describe('AcTrRBushSpatialIndex', () => {
  test('rejects NaN bboxes so one bad insert cannot poison all searches', () => {
    const index = new AcTrRBushSpatialIndex()
    for (let i = 0; i < 50; i++) {
      index.insert({
        minX: 360000 + i,
        minY: 3535000,
        maxX: 360000 + i + 10,
        maxY: 3535010,
        id: `ok-${i}`
      })
    }

    expect(
      index.search({
        minX: 360000,
        minY: 3535000,
        maxX: 360100,
        maxY: 3535200
      }).length
    ).toBeGreaterThan(0)

    index.insert({
      minX: NaN,
      minY: NaN,
      maxX: NaN,
      maxY: NaN,
      id: 'nan-box'
    })
    index.insert({
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      id: 'empty-inf'
    })

    const hits = index.search({
      minX: 360000,
      minY: 3535000,
      maxX: 360100,
      maxY: 3535200
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(h => h.id.startsWith('ok-'))).toBe(true)
    expect(index.all().some(h => h.id === 'nan-box')).toBe(false)
  })

  test('load filters non-finite items before bulk packing', () => {
    const index = new AcTrRBushSpatialIndex()
    index.load([
      { minX: 0, minY: 0, maxX: 1, maxY: 1, id: 'a' },
      { minX: NaN, minY: 0, maxX: 1, maxY: 1, id: 'bad' },
      { minX: 10, minY: 10, maxX: 11, maxY: 11, id: 'b' }
    ])

    expect(index.all().map(item => item.id).sort()).toEqual(['a', 'b'])
    expect(
      index.search({ minX: -1, minY: -1, maxX: 12, maxY: 12 }).map(h => h.id)
    ).toEqual(expect.arrayContaining(['a', 'b']))
  })
})

/**
 * Removal is exercised against the real `rbush` package on purpose: the
 * regression below only exists in a real R-tree.
 *
 * `rbush.remove(item)` descends with `contains(node, itemBbox)`, so removing
 * with a placeholder bbox (`{0,0,0,0}`) only finds entries on the
 * root-to-origin path. With more than one entry the bbox is never found and the
 * entry stays in the tree forever (stale picks, growing memory) even though the
 * id map no longer knows about it.
 */
function box(id: string, x: number, y: number, size = 1) {
  return { id, minX: x, minY: y, maxX: x + size, maxY: y + size }
}

describe('AcTrRBushSpatialIndex removal', () => {
  test('removeById drops exactly one entry out of many', () => {
    const index = new AcTrRBushSpatialIndex()
    // Spread entries so the removed one is nowhere near the origin.
    for (let i = 0; i < 200; i++) {
      index.insert(box(`E${i}`, 1000 + i * 10, 2000 + i * 10))
    }
    expect(index.all()).toHaveLength(200)

    index.removeById('E150')

    expect(index.getById('E150')).toBeUndefined()
    expect(index.all()).toHaveLength(199)
    expect(index.all().some(entry => entry.id === 'E150')).toBe(false)
    expect(
      index.collides({ minX: 2499, minY: 3499, maxX: 2501, maxY: 3501 })
    ).toBe(false)
  })

  test('removeByIds removes a whole selection in one pass', () => {
    const index = new AcTrRBushSpatialIndex()
    const ids: string[] = []
    for (let i = 0; i < 500; i++) {
      const id = `E${i}`
      ids.push(id)
      index.insert(box(id, 10000 + i * 5, 20000 + i * 5))
    }

    const removed = ids.filter((_, i) => i % 2 === 0)
    index.removeByIds(removed)

    expect(index.all()).toHaveLength(250)
    for (const id of removed) {
      expect(index.getById(id)).toBeUndefined()
    }
    for (const id of ids.filter((_, i) => i % 2 === 1)) {
      expect(index.getById(id)).toBeDefined()
    }
  })

  test('removing an unknown or empty id is a no-op', () => {
    const index = new AcTrRBushSpatialIndex()
    index.insert(box('A', 10, 10))

    expect(() => index.removeById('MISSING')).not.toThrow()
    expect(() => index.removeById('')).not.toThrow()
    expect(() => index.removeByIds(['MISSING', '', 'A'])).not.toThrow()

    expect(index.all()).toHaveLength(0)
    expect(index.getById('A')).toBeUndefined()
  })
})
