import {
  AcDbDatabase,
  AcDbLayerTableRecord,
  AcDbLine,
  AcGePoint3d
} from '@mlightcad/data-model'

import { AcApEntityService } from '../src/service/AcApEntityService'

describe('AcApEntityService', () => {
  test('copyDisplayTraits copies visual properties', () => {
    const source = {
      layer: 'A',
      color: { clone: () => ({ cloned: true }) },
      lineType: 'Continuous',
      lineWeight: 1,
      linetypeScale: 1,
      transparency: 0,
      visibility: true
    }
    const target = {
      layer: '',
      color: null as unknown,
      lineType: '',
      lineWeight: 0,
      linetypeScale: 0,
      transparency: 0,
      visibility: false
    }

    AcApEntityService.copyDisplayTraits(source as never, target as never)

    expect(target.layer).toBe('A')
    expect(target.color).toEqual({ cloned: true })
  })

  test('eraseEntities dedupes ids and erases each block table record once', () => {
    const erased = new Set<string>()
    const modelSpace = {
      removeEntity: jest.fn((ids: string[]) => {
        ids.forEach(id => erased.add(id))
        return true
      })
    }
    const paperSpace = {
      removeEntity: jest.fn((ids: string[]) => {
        ids.forEach(id => erased.add(id))
        return true
      })
    }
    const entities = new Map<string, { ownerId: string }>([
      ['a', { ownerId: 'ms' }],
      ['b', { ownerId: 'ms' }],
      ['c', { ownerId: 'ps' }]
    ])
    const db = {
      transactionManager: { hasTransaction: () => true },
      tables: {
        blockTable: {
          getEntityById: jest.fn((objectId: string) => entities.get(objectId)),
          getIdAt: jest.fn((ownerId: string) => {
            if (ownerId === 'ms') return modelSpace
            if (ownerId === 'ps') return paperSpace
            return undefined
          })
        }
      },
      openEntityForWrite: jest.fn((objectId: string) => entities.get(objectId))
    }
    const service = new AcApEntityService(db as never)

    const count = service.eraseEntities(['a', 'b', 'a', 'c', 'missing'])

    expect(count).toBe(3)
    expect(erased).toEqual(new Set(['a', 'b', 'c']))
    // One removal call per owning block table record, with the whole id batch.
    expect(modelSpace.removeEntity).toHaveBeenCalledTimes(1)
    expect(modelSpace.removeEntity).toHaveBeenCalledWith(['a', 'b'])
    expect(paperSpace.removeEntity).toHaveBeenCalledTimes(1)
    expect(paperSpace.removeEntity).toHaveBeenCalledWith(['c'])
    // Duplicates and unresolvable ids are never opened.
    expect(db.openEntityForWrite).toHaveBeenCalledTimes(3)
  })

  test('eraseEntities records an undoable database change', () => {
    const db = new AcDbDatabase()
    const line = new AcDbLine(new AcGePoint3d(0, 0, 0), new AcGePoint3d(10, 0, 0))
    db.tables.blockTable.modelSpace.appendEntity(line)
    const objectId = line.objectId
    const service = new AcApEntityService(db)

    expect(service.eraseEntities([objectId])).toBe(1)
    expect(db.tables.blockTable.getEntityById(objectId)).toBeUndefined()
    expect(db.transactionManager.canUndo()).toBe(true)

    expect(db.transactionManager.undo()).toBe(true)
    expect(db.tables.blockTable.getEntityById(objectId)).toBeDefined()

    expect(db.transactionManager.redo()).toBe(true)
    expect(db.tables.blockTable.getEntityById(objectId)).toBeUndefined()
  })

  test('eraseEntities and transformEntities skip entities on locked layers', () => {
    const db = new AcDbDatabase()
    const layer = new AcDbLayerTableRecord({ name: 'L1' })
    db.tables.layerTable.add(layer)
    layer.standardFlags = 1
    layer.isLocked = true
    expect(layer.isLocked).toBe(true)
    expect(layer.isFrozen).toBe(true)
    layer.isLocked = false
    expect(layer.isLocked).toBe(false)
    expect(layer.isFrozen).toBe(true)
    layer.isLocked = true

    const locked = new AcDbLine(
      new AcGePoint3d(0, 0, 0),
      new AcGePoint3d(1, 0, 0)
    )
    locked.layer = 'L1'
    const free = new AcDbLine(
      new AcGePoint3d(0, 1, 0),
      new AcGePoint3d(1, 1, 0)
    )
    db.tables.blockTable.modelSpace.appendEntity([locked, free])
    const service = new AcApEntityService(db)

    expect(
      service.translateEntities([locked, free], { x: 5, y: 5, z: 0 })
    ).toBe(1)
    expect(locked.startPoint.x).toBe(0)
    expect(free.startPoint.x).toBe(5)
    expect(service.eraseEntities([locked.objectId, free.objectId])).toBe(1)
    expect(db.tables.blockTable.getEntityById(locked.objectId)).toBeDefined()
    expect(db.tables.blockTable.getEntityById(free.objectId)).toBeUndefined()
  })
})
