/**
 * AcApSaveDwgCmd: source routing + explicit failure codes (plan P7).
 *
 * The viewer / element-plus / locale graphs are mocked; the save barrel is
 * requireActual so `RouteBError` keeps its identity for instanceof checks.
 */
import { AcDbDatabaseConverterManager } from '@mlightcad/data-model'
import { ElMessage } from 'element-plus'

import { AcApSaveDwgCmd, isSaveShortcut } from '../../src/command/AcApSaveDwgCmd'
import { getDwgSaveJournal, RouteBError, runRouteBSave } from '../../src/save'

const mockConvert = jest.fn()
const mockDocManager = {
  curDocument: undefined as
    | { database: object; fileName?: string; docTitle?: string }
    | undefined,
  disableExport: false,
  sendStringToExecute: jest.fn()
}

jest.mock('@mlightcad/cad-simple-viewer', () => ({
  AcApDocManager: {
    // Lazy: the factory runs during hoisted imports, before the consts below.
    get instance() {
      return mockDocManager
    },
    tryGetInstance: () => mockDocManager
  },
  AcApDxfConvertor: jest.fn(() => ({ convert: mockConvert })),
  AcApI18n: { t: (key: string) => key },
  AcEdCommand: class {
    async withBusyIndicator(work: () => unknown) {
      return work()
    }
  }
}))
jest.mock('element-plus', () => ({ ElMessage: jest.fn() }))
jest.mock('../../src/locale', () => ({
  i18n: {
    global: {
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    }
  }
}))
jest.mock('../../src/save', () => ({
  ...jest.requireActual('../../src/save'),
  getDwgSaveJournal: jest.fn(),
  runRouteBSave: jest.fn()
}))

const mockGetJournal = getDwgSaveJournal as jest.Mock
const mockRunSave = runRouteBSave as jest.Mock
const mockMessage = ElMessage as unknown as jest.Mock

const fakeConverter = { patchSave: jest.fn(), patchAudit: jest.fn() }
const fakeJournal = { originalBytes: new ArrayBuffer(8) }
const okAudit = {
  byte_exact: 3,
  reencoded_equal: 0,
  semantic_mismatch: 0
}

// Minimal DOM for the download path (jest testEnvironment is node).
const anchor = { href: '', download: '', click: jest.fn() }
const savedDocument = (global as { document?: unknown }).document
const savedUrl = (global as { URL?: unknown }).URL
beforeAll(() => {
  ;(global as { document: unknown }).document = {
    createElement: () => anchor,
    body: { appendChild: jest.fn(), removeChild: jest.fn() }
  }
  ;(global as { URL: unknown }).URL = {
    createObjectURL: jest.fn(() => 'blob:mock'),
    revokeObjectURL: jest.fn()
  }
})
afterAll(() => {
  ;(global as { document: unknown }).document = savedDocument
  ;(global as { URL: unknown }).URL = savedUrl
})

beforeEach(() => {
  jest.clearAllMocks()
  mockDocManager.curDocument = undefined
  mockDocManager.disableExport = false
  mockGetJournal.mockReturnValue(undefined)
  jest
    .spyOn(AcDbDatabaseConverterManager.instance, 'get')
    .mockReturnValue(fakeConverter as never)
})

function messages(): string[] {
  return mockMessage.mock.calls.map(call => String(call[0].message))
}

describe('isSaveShortcut', () => {
  const base = {
    key: 's',
    code: 'KeyS',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false
  }
  it('matches Ctrl+S and Cmd+S', () => {
    expect(isSaveShortcut({ ...base, ctrlKey: true })).toBe(true)
    expect(isSaveShortcut({ ...base, metaKey: true })).toBe(true)
  })
  it('matches by code when key is masked (IME)', () => {
    expect(
      isSaveShortcut({ ...base, key: 'Process', ctrlKey: true })
    ).toBe(true)
  })
  it('rejects plain S, Shift/Alt combos', () => {
    expect(isSaveShortcut(base)).toBe(false)
    expect(isSaveShortcut({ ...base, ctrlKey: true, shiftKey: true })).toBe(
      false
    )
    expect(isSaveShortcut({ ...base, ctrlKey: true, altKey: true })).toBe(false)
  })
})

describe('AcApSaveDwgCmd routing', () => {
  const execute = () => new AcApSaveDwgCmd().execute(undefined as never)

  it('does nothing without a current document', async () => {
    await execute()
    expect(mockMessage).not.toHaveBeenCalled()
    expect(mockConvert).not.toHaveBeenCalled()
  })

  it('DWG source without a journal is a hard error, never a DXF fallback', async () => {
    mockDocManager.curDocument = { database: {}, fileName: 'plan.dwg' }
    await execute()
    expect(messages().join()).toContain('no-original-bytes')
    expect(mockConvert).not.toHaveBeenCalled()
    expect(mockRunSave).not.toHaveBeenCalled()
  })

  it('DXF source without a journal exports DXF', async () => {
    mockDocManager.curDocument = { database: {}, fileName: 'plan.dxf' }
    await execute()
    expect(mockConvert).toHaveBeenCalledTimes(1)
    expect(mockRunSave).not.toHaveBeenCalled()
  })

  it('untitled drawing exports DXF', async () => {
    mockDocManager.curDocument = { database: {}, docTitle: 'Drawing1' }
    await execute()
    expect(mockConvert).toHaveBeenCalledTimes(1)
  })

  it('respects disableExport for the DXF fallback', async () => {
    mockDocManager.curDocument = { database: {}, fileName: 'plan.dxf' }
    mockDocManager.disableExport = true
    await execute()
    expect(mockConvert).not.toHaveBeenCalled()
  })

  it('DWG source with a journal runs the Route-B save and downloads .dwg', async () => {
    mockDocManager.curDocument = { database: {}, fileName: 'plan.dwg' }
    mockGetJournal.mockReturnValue(fakeJournal)
    mockRunSave.mockResolvedValue({ bytes: new ArrayBuffer(4), audit: okAudit })
    await execute()
    expect(mockRunSave).toHaveBeenCalledWith(fakeConverter, fakeJournal)
    expect(anchor.download).toBe('plan.dwg')
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(messages().join()).toContain('saveDwgSuccess')
  })

  it('rejects a converter without patch capability', async () => {
    mockDocManager.curDocument = { database: {}, fileName: 'plan.dwg' }
    mockGetJournal.mockReturnValue(fakeJournal)
    jest
      .spyOn(AcDbDatabaseConverterManager.instance, 'get')
      .mockReturnValue({} as never)
    await execute()
    expect(messages().join()).toContain('no-converter')
    expect(mockRunSave).not.toHaveBeenCalled()
  })

  it('refuses drawings over the 64 MB wasm ceiling', async () => {
    mockDocManager.curDocument = { database: {}, fileName: 'big.dwg' }
    mockGetJournal.mockReturnValue({
      originalBytes: new ArrayBuffer(65 * 1024 * 1024)
    })
    await execute()
    expect(messages().join()).toContain('saveDwgTooLarge')
    expect(mockRunSave).not.toHaveBeenCalled()
  })

  it('surfaces the RouteBError code and keeps the toast open', async () => {
    mockDocManager.curDocument = { database: {}, fileName: 'plan.dwg' }
    mockGetJournal.mockReturnValue(fakeJournal)
    mockRunSave.mockRejectedValue(new RouteBError('audit-failed', 'boom'))
    await execute()
    const text = messages().join()
    expect(text).toContain('audit-failed')
    expect(text).toContain('boom')
    expect(mockMessage.mock.calls[0][0].duration).toBe(0)
    expect(anchor.click).not.toHaveBeenCalled()
  })

  it('warns when accepted semantic-fidelity classes were re-encoded', async () => {
    mockDocManager.curDocument = { database: {}, fileName: 'plan.dwg' }
    mockGetJournal.mockReturnValue(fakeJournal)
    mockRunSave.mockResolvedValue({
      bytes: new ArrayBuffer(4),
      audit: { ...okAudit, reencoded_equal: 2, semantic_mismatch: 1 }
    })
    await execute()
    expect(messages().join()).toContain('saveDwgSemanticWarning')
  })
})