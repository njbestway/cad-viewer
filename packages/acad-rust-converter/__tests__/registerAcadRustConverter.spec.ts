import { AcDbDatabaseConverterManager, AcDbFileType } from '@mlightcad/data-model'

import {
  createAcadRustConverter,
  registerAcadRustConverter
} from '../src/registerAcadRustConverter'

// Replace the converter with a lightweight stub so the factory wiring can be
// exercised without constructing the native DXF converter or loading WASM. The
// stub records the config it was built with.
jest.mock('../src/AcDbAcadRustConverter', () => ({
  AcDbAcadRustConverter: class {
    constructor(public readonly config?: unknown) {}
  }
}))

interface StubInstance {
  readonly config?: unknown
}

describe('acad-rust converter factory', () => {
  it('createAcadRustConverter returns an instance (threading config) without registering', () => {
    const spy = jest
      .spyOn(AcDbDatabaseConverterManager.instance, 'register')
      .mockImplementation(() => {})
    try {
      const config = { assetBaseUrl: './workers/' }
      const converter = createAcadRustConverter(config)
      expect(converter).toBeInstanceOf(Object)
      expect((converter as unknown as StubInstance).config).toBe(config)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('registerAcadRustConverter builds the converter and registers it for DWG', () => {
    const spy = jest
      .spyOn(AcDbDatabaseConverterManager.instance, 'register')
      .mockImplementation(() => {})
    try {
      const config = { assetBaseUrl: './workers/', useWorker: false }
      const converter = registerAcadRustConverter(config)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(AcDbFileType.DWG, converter)
      expect((converter as unknown as StubInstance).config).toBe(config)
    } finally {
      spy.mockRestore()
    }
  })
})
