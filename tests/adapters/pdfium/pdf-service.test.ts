import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createPdfService } from '../../../src/adapters/host/pdfium/index.ts'
import { CapabilityRegistry, pdfCapabilities } from '../../../src/modules/capabilities/index.ts'
import { NativeWorker } from '../../../src/engine/host/native-worker.ts'
import { selectionGeometryChunkSchema } from '../../../src/engine/protocol/selection.ts'
import type { PdfAgent } from '../../../src/adapters/host/dsh/index.ts'
import { memoryWorkspace, nativeFixture } from '../../native-fixture.ts'
import { classicPdf, pdfDict, pdfHex, pdfStream, plainPdf, ref } from '../../fixtures/pdf-fixture-kit.ts'
import { nativeTestSubprocess } from '../../native-test-subprocess.ts'
import { recoverableOutlineFixture } from '../../fixtures/recoverable-outline.ts'
import { acroformFixture } from '../../fixtures/acroform.ts'
import { encodePng } from '../../../src/adapters/host/pdfium/png.ts'
import { withIndexPerformance, type IndexPerformanceMetric } from '../../../src/modules/retrieval/performance.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native tests require a built helper')
const skip = !existsSync(executable)
const signal = new AbortController().signal
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function agent(sessionId: string): PdfAgent {
  return { session: { id: sessionId, header: {} } }
}

async function open(service: ReturnType<typeof createPdfService>, sessionId: string) {
  return await service.dispatch(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal) as {
    id: string; revision: number; reader: { bytesHash: string }
  }
}

test('a visible tile overtakes queued indexing text and rasters at the native handle boundary', { skip }, async t => {
  const state = memoryWorkspace(await nativeFixture()), sessionId = 'pdf-service-foreground-lease'
  const request = NativeWorker.prototype.request, hold = deferred(), active = deferred(), commands: string[] = []
  t.mock.method(NativeWorker.prototype, 'request', async function(this: NativeWorker, ...args: Parameters<NativeWorker['request']>) {
    const { command, pageIndex, annotations } = args[0] as { command: string; pageIndex?: number; annotations?: boolean }
    if (command === 'text' || command === 'render') {
      commands.push(`${command === 'render' && annotations ? 'tile' : command}:${pageIndex}`)
    }
    const reply = await request.apply(this, args)
    if (command === 'text' && pageIndex === 0) { active.resolve(); await hold.promise }
    return reply
  })
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const outstanding: Promise<unknown>[] = []
  try {
    const opened = await open(service, sessionId)
    const first = service.readPageText(sessionId, opened.id, 1, signal, { recover: false })
    outstanding.push(first)
    await active.promise

    const backgroundText = service.readPageText(sessionId, opened.id, 2, signal, { recover: false })
    const metrics: IndexPerformanceMetric[] = []
    const backgroundImage = withIndexPerformance(metric => metrics.push(metric), () =>
      service.renderOcrImage(sessionId, opened.id, 3, undefined, 512, signal, false))
    const cancelled = new AbortController()
    const obsolete = assert.rejects(service.readPageText(sessionId, opened.id, 4, cancelled.signal), { name: 'AbortError' })
    cancelled.abort()
    outstanding.push(backgroundText, backgroundImage, obsolete)
    await obsolete

    const foreground = service.native(sessionId, { action: 'tile', sessionId, id: opened.id, bytesHash: opened.reader.bytesHash,
      tile: { page: 4, rotation: 0, rasterWidth: 220, rasterHeight: 280, x: 0, y: 0, width: 220, height: 280, annotations: true },
    }, agent(sessionId), signal) as Promise<{ bytes: Uint8Array }>
    outstanding.push(foreground)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(commands, ['text:0'])
    hold.resolve()

    const [text, queuedText, rendered, tile] = await Promise.all([first, backgroundText, backgroundImage, foreground])
    assert.deepEqual(commands, ['text:0', 'tile:3', 'text:1', 'render:2'])
    assert.equal(text.content.items[0]?.str, 'Native PDF test page 1')
    assert.equal(queuedText.content.items[0]?.str, 'Native PDF test page 2')
    assert.deepEqual(tile.bytes.subarray(0, 8), rendered.png.subarray(0, 8))
    assert.deepEqual(metrics.map(metric => metric.stage), ['native-render', 'png-encode'])
    assert.equal(service.diagnostics().documents, 1)
  } finally {
    hold.resolve(); await Promise.allSettled(outstanding)
    await service.dispose(); await state.workspaces.dispose()
  }
})

test('native reads, tile cache, and explicit release share the same live PDF handle', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture())
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-native-boundaries'
  try {
    const opened = await open(service, sessionId)
    assert.equal(service.diagnostics().documents, 1)
    const common = { sessionId, id: opened.id, bytesHash: opened.reader.bytesHash }
    assert.equal(await service.native(sessionId, { ...common, action: 'outline' }, agent(sessionId), signal), null)
    const links = await service.native(sessionId, { ...common, action: 'links', page: 1 }, agent(sessionId), signal) as { url?: string }[]
    assert.equal(links[0]?.url, 'https://example.com/native')
    assert.deepEqual(await service.native(sessionId, { ...common, action: 'destination', name: 'chapter' }, agent(sessionId), signal),
      [2, { name: 'XYZ' }, 50, 300, null])
    const inspected = await service.native(sessionId, { ...common, action: 'inspect', page: 1, offset: 0, limit: 1 }, agent(sessionId), signal) as { objects: unknown[] }
    assert.equal(inspected.objects.length, 1)
    const tile = { page: 1, rotation: 0, rasterWidth: 220, rasterHeight: 280,
      x: 0, y: 0, width: 220, height: 280, annotations: true }
    const first = await service.native(sessionId, { ...common, action: 'tile', tile }, agent(sessionId), signal) as { bytes: Uint8Array }
    const second = await service.native(sessionId, { ...common, action: 'tile', tile }, agent(sessionId), signal) as { bytes: Uint8Array }
    assert.deepEqual([...first.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(second.bytes, first.bytes)
    assert.equal(service.diagnostics().tileCacheEntries, 1)
    assert.deepEqual((await service.readPageText(sessionId, opened.id, 1, signal)).content.items.map(item => item.str),
      ['Native PDF test page 1'])
    assert.equal((await service.readOutline(sessionId, opened.id, signal)).items, null)
    await service.releaseDocument(opened.id)
    assert.equal(service.diagnostics().documents, 0)
    await service.releaseDocument(opened.id)
    assert.equal((await service.readPageText(sessionId, opened.id, 1, signal)).content.items.length, 1)
    assert.equal(service.diagnostics().documents, 1)
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('reader selection delivers native glyphs and rejects a result overtaken by save', { skip }, async t => {
  const state = memoryWorkspace(await nativeFixture())
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-selection-save-race'
  const request = NativeWorker.prototype.request
  const arrived = deferred(), release = deferred()
  let hold = false, pending: Promise<unknown> | undefined
  t.mock.method(NativeWorker.prototype, 'request', async function(this: NativeWorker, ...args: Parameters<NativeWorker['request']>) {
    const reply = await request.apply(this, args)
    if (hold && args[0].command === 'selectionGeometry') { arrived.resolve(); await release.promise }
    return reply
  })
  try {
    const opened = await open(service, sessionId)
    const selection = { action: 'selectionGeometry', sessionId, id: opened.id, bytesHash: opened.reader.bytesHash, page: 1, offset: 1 }
    const chunk = selectionGeometryChunkSchema.parse(await service.native(sessionId, selection, agent(sessionId), signal))
    assert.equal(chunk.offset, 1)
    assert.equal(chunk.glyphs.map(glyph => glyph.text).join(''), 'ative PDF test page 1')
    assert.ok(chunk.glyphs.some(glyph => glyph.quad !== null))

    hold = true
    pending = assert.rejects(service.native(sessionId, selection, agent(sessionId), signal), { code: 'pdf/stale-reader' })
    await Promise.race([arrived.promise, pending.then(() => { throw new Error('Selection completed before the save race') })])
    await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id, revision: opened.revision,
      operations: [{ type: 'add', annotation: { id: 'saved-during-selection', page: 1, subtype: 'Text', rect: [20, 20, 40, 40] } }],
    }, agent(sessionId), signal)
    const edited = state.workspaces.readSnapshot(sessionId, opened.id)
    await state.workspaces.execute(sessionId, { action: 'save', sessionId, id: opened.id, revision: edited.revision, options: {} },
      agent(sessionId), signal)
    assert.notEqual(state.workspaces.bytesHash(state.current()), selection.bytesHash)
    release.resolve()
    await pending
  } finally {
    release.resolve()
    if (pending) await Promise.allSettled([pending])
    await service.dispose(); await state.workspaces.dispose()
  }
})

test('reader selection reports an older helper without native glyph geometry', { skip }, async t => {
  const state = memoryWorkspace(await nativeFixture())
  const ready = NativeWorker.prototype.ready
  t.mock.method(NativeWorker.prototype, 'ready', async function(this: NativeWorker) {
    await ready.call(this)
    this.selectionGeometry = false
  })
  const request = t.mock.method(NativeWorker.prototype, 'request')
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-selection-legacy-helper'
  try {
    const opened = await open(service, sessionId)
    await assert.rejects(service.native(sessionId, { action: 'selectionGeometry', sessionId, id: opened.id,
      bytesHash: opened.reader.bytesHash, page: 1, offset: 0 }, agent(sessionId), signal),
    { code: 'pdf/native-selection-unavailable' })
    assert.equal(request.mock.calls.some(call => call.arguments[0].command === 'selectionGeometry'), false)
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('form inspection rejects revision and content races before and after native rendering', { skip }, async () => {
  const state = memoryWorkspace(await acroformFixture())
  let mismatch: 'revision' | 'content' = 'revision', reads = 0, changedAt = 2
  const workspaces = { ...state.workspaces,
    readSnapshot(...args: Parameters<typeof state.workspaces.readSnapshot>) {
      const snapshot = state.workspaces.readSnapshot(...args)
      if (++reads !== changedAt) return snapshot
      return mismatch === 'revision' ? { ...snapshot, revision: snapshot.revision + 1 }
        : { ...snapshot, contentVersion: 'another-content' }
    },
  }
  const service = createPdfService(workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'form-preview-fence'
  try {
    const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
    assert.ok('bytes' in opened)
    for (const at of [2, 3]) for (const kind of ['revision', 'content'] as const) {
      mismatch = kind; changedAt = at; reads = 0
      await assert.rejects(service.renderFormPage(sessionId, opened.id, 1, 2048, false, signal), { code: 'pdf/stale-reader' })
      assert.ok(service.diagnostics().documents <= 1)
    }
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('tiled inspection reads base ink and draft metadata without materializing PDFs or leaking handles', { skip }, async () => {
  const state = memoryWorkspace(await acroformFixture()), sessionId = 'form-preview-reader-lease'
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  try {
    const opened = await open(service, sessionId)
    const before = await service.renderFormPage(sessionId, opened.id, 1, 2048, true, signal)
    const current = state.workspaces.readSnapshot(sessionId, opened.id)
    await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id, revision: current.revision,
      operations: [{ type: 'set-field', fieldId: current.document.formFields![0].id!, value: 'New' }] }, agent(sessionId), signal)
    const [after, reading] = await Promise.all([service.renderFormPage(sessionId, opened.id, 1, 2048, true, signal),
      service.readPageText(sessionId, opened.id, 1, signal)])
    assert.equal(after.height, 2048, 'Native tiles stay bounded while the final image is high resolution')
    assert.equal(after.formInspection.fields[0].value, 'New')
    assert.deepEqual(after.png, before.png, 'Draft values do not enter the base-page raster')
    assert.equal(service.diagnostics().documents, 1); assert.ok(reading.content.items.length > 0)
    assert.equal(state.writes(), 0)
    await service.dispose()
    await assert.rejects(service.renderFormPage(sessionId, opened.id, 1, 2048, true, signal), { code: 'pdf/unavailable' })
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('inspection never publishes a malformed native tile or a page canceled between tiles', { skip }, async t => {
  const state = memoryWorkspace(await acroformFixture()), sessionId = 'form-tile-boundaries'
  const request = NativeWorker.prototype.request
  let mode: 'dimensions' | 'bytes' | 'cancel' = 'dimensions', abort = new AbortController(), renders = 0
  t.mock.method(NativeWorker.prototype, 'request', async function(this: NativeWorker,
    ...args: Parameters<NativeWorker['request']>) {
    const reply = await request.apply(this, args)
    if ((args[0] as { command: string }).command !== 'render') return reply
    renders++
    const value = reply.value as { width: number; height: number; format: 'rgba' }
    if (mode === 'dimensions') return { ...reply, value: { ...value, width: value.width - 1 } }
    if (mode === 'bytes') return { ...reply, bytes: reply.bytes.subarray(4) }
    abort.abort(new Error('Canceled between inspection tiles'))
    return reply
  })
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  try {
    const opened = await open(service, sessionId)
    for (const fault of ['dimensions', 'bytes', 'cancel'] as const) {
      mode = fault; abort = new AbortController(); renders = 0
      await assert.rejects(service.renderFormPage(sessionId, opened.id, 1, 2048, false, abort.signal),
        fault === 'cancel' ? /Canceled between/ : { code: 'pdf/native-protocol' })
      assert.equal(renders, 1, 'A bad or canceled tile must stop the remaining tiles')
      assert.equal(service.diagnostics().documents, 1)
    }
    assert.equal(state.writes(), 0)
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('native open rejects parser disagreements before presenting an incomplete document', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture())
  try {
    for (const [name, change] of [
      ['page-count', { pageCount: 99 }],
      ['form-kind', { formKind: 'acroform' as const }],
    ] as const) {
      const workspaces = { ...state.workspaces,
        async execute(...args: Parameters<typeof state.workspaces.execute>) {
          const result = await state.workspaces.execute(...args)
          return 'bytes' in result ? { ...result, document: { ...result.document, ...change } } : result
        },
      }
      const service = createPdfService(workspaces, { executable, subprocess: nativeTestSubprocess })
      try {
        await assert.rejects(open(service, `pdf-service-mismatch-${name}`), { code: 'pdf/native-unsupported' })
        assert.equal(service.diagnostics().documents, 0)
      } finally { await service.dispose() }
    }
  } finally { await state.workspaces.dispose() }
})

test('signed PDFs can be previewed through PDFium without enabling edits', { skip }, async () => {
  const state = memoryWorkspace(classicPdf([
    '<< /Type /Catalog /Pages 2 0 R /Perms << /DocMDP << /Type /Sig /ByteRange [0 10 20 30] /Contents <616263313233> >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>',
  ]))
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-signed-preview'
  try {
    const opened = await open(service, sessionId)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).document.readOnlyReason, 'signed-document')
    const page = await service.renderPage(sessionId, opened.id, 1, 560, signal)
    assert.deepEqual([...page.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('readOutline preserves a real nested Unicode bookmark tree', { skip }, async () => {
  const state = memoryWorkspace(classicPdf([
    '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>',
    '<< /Producer (fixture) >>', pdfStream(''), pdfStream(''),
    pdfDict({ Type: '/Outlines', Count: '2', First: ref(9), Last: ref(9) }),
    pdfDict({ Title: pdfHex('Chapter 1'), Parent: ref(8), Count: '1', First: ref(10), Last: ref(10), Dest: `[${ref(3)} /Fit]` }),
    pdfDict({ Title: pdfHex('第二节'), Parent: ref(9), Dest: `[${ref(4)} /Fit]` }),
  ]))
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-outline'
  try {
    const opened = await open(service, sessionId)
    const outline = state.workspaces.readSnapshot(sessionId, opened.id).document.outline!
    assert.deepEqual((await service.readOutline(sessionId, opened.id, signal)).items, [{
      id: outline[0].id, title: 'Chapter 1', dest: [0, { name: 'Fit' }], url: undefined, items: [
        { id: outline[0].children[0].id, title: '第二节', dest: [1, { name: 'Fit' }], url: undefined, items: [] },
      ],
    }])
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('outline drafts refresh full wire metadata and native destinations across undo, redo and save', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture())
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-outline-draft'
  try {
    const opened = await open(service, sessionId)
    const changed = await service.dispatch(sessionId, { action: 'change', sessionId, id: opened.id,
      revision: opened.revision, knownRevision: opened.revision, knownBytesHash: opened.reader.bytesHash,
      operations: [{ type: 'outline-add', id: 'draft-chapter', title: '草稿目录', page: 2 }] }, agent(sessionId), signal) as {
      revision: number; document?: { outline: { title: string }[] }; annotationDelta?: unknown
    }
    assert.equal(changed.document?.outline[0].title, '草稿目录')
    assert.equal(changed.annotationDelta, undefined, 'outline edits must not be hidden in annotation-only deltas')
    const common = { sessionId, id: opened.id, bytesHash: opened.reader.bytesHash, action: 'outline' }
    assert.deepEqual(await service.native(sessionId, common, agent(sessionId), signal), [{
      id: 'draft-chapter', title: '草稿目录', dest: [1, { name: 'Fit' }], items: [],
    }])
    const undone = await service.dispatch(sessionId, { action: 'undo', sessionId, id: opened.id,
      revision: changed.revision }, agent(sessionId), signal) as { revision: number }
    assert.equal((await service.readOutline(sessionId, opened.id, signal)).items, null)
    const redone = await service.dispatch(sessionId, { action: 'redo', sessionId, id: opened.id,
      revision: undone.revision }, agent(sessionId), signal) as { revision: number }
    await service.dispatch(sessionId, { action: 'save', sessionId, id: opened.id,
      revision: redone.revision, options: {} }, agent(sessionId), signal)
    assert.equal((await service.readOutline(sessionId, opened.id, signal)).items?.[0].title, '草稿目录')
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).dirty, false)
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('recoverable imported links expose editable IDs and preserve native views through edit, undo and save', { skip }, async () => {
  const source = await recoverableOutlineFixture()
  const state = memoryWorkspace(source)
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-outline-recovery'
  try {
    const opened = await open(service, sessionId)
    const snapshot = state.workspaces.readSnapshot(sessionId, opened.id)
    assert.equal(snapshot.document.outlineReadOnlyReason, undefined)
    assert.equal(snapshot.dirty, false)
    const chapter = snapshot.document.outline![0]
    const read = () => service.readOutline(sessionId, opened.id, signal)
    const original = (await read()).items!
    assert.equal(original[0].id, chapter.id)
    assert.deepEqual(original[0].dest, [0, { name: 'XYZ' }, 40, 520, 1.25])
    assert.equal(original[0].items[0].id, chapter.children[0].id)
    assert.equal(original[1].url, 'https://example.com/reference')
    const changed = await service.dispatch(sessionId, { action: 'change', sessionId, id: opened.id, revision: opened.revision,
      operations: [{ type: 'outline-add', id: 'new-child', title: 'New child', page: 2, parentId: chapter.id }] }, agent(sessionId), signal) as { revision: number }
    const items = (await read()).items!
    assert.deepEqual(items[0].dest, original[0].dest)
    assert.deepEqual(items[0].items.map(item => item.id), [chapter.children[0].id, 'new-child'])
    assert.equal(state.writes(), 0)
    assert.deepEqual(state.current(), source)
    const undone = await service.dispatch(sessionId, { action: 'undo', sessionId, id: opened.id, revision: changed.revision }, agent(sessionId), signal) as { revision: number }
    assert.deepEqual((await read()).items, original)
    const redone = await service.dispatch(sessionId, { action: 'redo', sessionId, id: opened.id, revision: undone.revision }, agent(sessionId), signal) as { revision: number }
    await service.dispatch(sessionId, { action: 'save', sessionId, id: opened.id, revision: redone.revision, options: {} }, agent(sessionId), signal)
    assert.equal(JSON.stringify((await read()).items), JSON.stringify(items))
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).dirty, false)
    assert.equal(state.writes(), 1)
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('page and OCR rendering enforce bounds and preserve full-page crop geometry', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture())
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-render-boundaries'
  try {
    const opened = await open(service, sessionId)
    await assert.rejects(service.readPageText(sessionId, opened.id, 0, signal), { code: 'pdf/invalid-page' })
    await assert.rejects(service.renderPage(sessionId, opened.id, 5, 560, signal), { code: 'pdf/invalid-page' })
    await assert.rejects(service.renderPage(sessionId, opened.id, 1, 255, signal), { code: 'pdf/invalid-render-size' })
    const rotated = await service.renderPage(sessionId, opened.id, 2, 560, signal)
    const page = state.workspaces.readSnapshot(sessionId, opened.id).document.pages[1]!
    const cropWidth = Math.abs(page.cropBox[2] - page.cropBox[0])
    const cropHeight = Math.abs(page.cropBox[3] - page.cropBox[1])
    assert.deepEqual([rotated.width, rotated.height], [560, Math.round(560 * cropWidth / cropHeight)])
    assert.deepEqual([...rotated.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    await assert.rejects(service.renderOcrImage(sessionId, opened.id, 5, undefined, 512, signal), { code: 'pdf/invalid-page' })
    await assert.rejects(service.renderOcrImage(sessionId, opened.id, 1, undefined, 255, signal), { code: 'pdf/invalid-render-size' })
    await assert.rejects(service.renderOcrImage(sessionId, opened.id, 1, [30, 40, Number.NaN, 100], 512, signal), { code: 'pdf/invalid-region' })
    await assert.rejects(service.renderOcrImage(sessionId, opened.id, 1, [300, 300, 400, 400], 512, signal), { code: 'pdf/invalid-region' })
    const full = await service.renderOcrImage(sessionId, opened.id, 1, undefined, 512, signal)
    assert.deepEqual(full.pdfRegion, state.workspaces.readSnapshot(sessionId, opened.id).document.pages[0]!.cropBox)
    assert.ok(full.width <= 512 && full.height <= 512)
    assert.deepEqual([...full.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('OCR rejects a subpixel strip at the crop edge that rounds to an empty native tile', async () => {
  const state = memoryWorkspace(plainPdf([{ size: [13, 3000] }]))
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-ocr-subpixel-edge'
  try {
    const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
    assert.ok('bytes' in opened)
    // 13 CSS units scale to five native pixels. The x interval is nonempty in
    // PDF space, but both endpoints round to rasterWidth=5 at this density.
    await assert.rejects(service.renderOcrImage(sessionId, opened.id, 1,
      [12.999999999999998, 0, 13, 3000], 1024, signal), { code: 'pdf/invalid-region' })
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('mutation identity rejects reuse with different content and discard releases its native handle', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture())
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-mutation-identity'
  try {
    const opened = await open(service, sessionId)
    const mutationId = randomUUID()
    const change = { action: 'change', sessionId, id: opened.id, revision: opened.revision, mutationId,
      operations: [{ type: 'add', annotation: { id: 'first-note', page: 1, subtype: 'Text', rect: [80, 80, 100, 100] } }] }
    const changed = await service.dispatch(sessionId, change, agent(sessionId), signal) as { revision: number }
    assert.equal(changed.revision, opened.revision + 1)
    await assert.rejects(service.dispatch(sessionId, { ...change,
      operations: [{ type: 'add', annotation: { id: 'different-note', page: 1, subtype: 'Text', rect: [80, 80, 100, 100] } }],
    }, agent(sessionId), signal), { code: 'pdf/mutation-mismatch' })
    assert.equal(service.diagnostics().documents, 1)
    assert.deepEqual(await service.dispatch(sessionId, { action: 'discardMany', sessionId, ids: [opened.id] }, agent(sessionId), signal),
      { discarded: [opened.id] })
    assert.equal(service.diagnostics().documents, 0)
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('native handles and wire histories evict oldest documents without losing workspace state', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture())
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  try {
    const opened: { sessionId: string; id: string; revision: number; bytesHash: string }[] = []
    for (let index = 0; index < 33; index++) {
      const sessionId = `pdf-service-lru-${index}`
      const value = await open(service, sessionId)
      opened.push({ sessionId, id: value.id, revision: value.revision, bytesHash: value.reader.bytesHash })
      assert.ok(service.diagnostics().documents <= 16)
    }
    assert.equal(service.diagnostics().documents, 16)
    const first = opened[0]!
    assert.equal((await service.readPageText(first.sessionId, first.id, 1, signal)).content.items.length, 1)
    assert.equal(service.diagnostics().documents, 16)
    const restored = await service.dispatch(first.sessionId, {
      action: 'open', sessionId: first.sessionId,
      address: `dsh-resource://file/session/${first.sessionId}//fixtures/native.pdf`,
      knownRevision: first.revision, knownBytesHash: first.bytesHash,
    }, agent(first.sessionId), signal) as { document?: unknown; annotationDelta?: unknown }
    assert.ok(restored.document, 'A history older than the 32-entry wire cache receives a complete snapshot')
    assert.equal(restored.annotationDelta, undefined)
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('a changed workspace revision invalidates in-flight native page and OCR renders', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture())
  let invalidateRead = 0, reads = 0
  const workspaces = { ...state.workspaces,
    readSnapshot(sessionId: string, id: string) {
      const snapshot = state.workspaces.readSnapshot(sessionId, id)
      return invalidateRead && ++reads === invalidateRead ? { ...snapshot, revision: snapshot.revision + 1 } : snapshot
    },
  }
  const service = createPdfService(workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-render-race'
  try {
    const opened = await open(service, sessionId)
    // A page read fences both admission (second snapshot) and completed
    // rasterization (third snapshot); neither race may deliver stale pixels.
    for (const phase of [2, 3]) {
      invalidateRead = phase; reads = 0
      await assert.rejects(service.renderPage(sessionId, opened.id, 1, 512, signal), { code: 'pdf/stale-reader' })
    }
    invalidateRead = 2; reads = 0
    await assert.rejects(service.renderOcrImage(sessionId, opened.id, 1, undefined, 512, signal), { code: 'pdf/stale-reader' })
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('corrupt page geometry is rejected before a native render is requested', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture())
  let corrupt: 'unit' | 'missing' | undefined
  const workspaces = { ...state.workspaces,
    readSnapshot(sessionId: string, id: string) {
      const snapshot = state.workspaces.readSnapshot(sessionId, id)
      if (!corrupt) return snapshot
      const first = snapshot.document.pages[0]!
      return { ...snapshot, document: { ...snapshot.document,
        pages: corrupt === 'missing' ? [] : [{ ...first, userUnit: 0 }, ...snapshot.document.pages.slice(1)] } }
    },
  }
  const service = createPdfService(workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-corrupt-geometry'
  try {
    const opened = await open(service, sessionId)
    for (const fault of ['unit', 'missing'] as const) {
      corrupt = fault
      await assert.rejects(service.renderPage(sessionId, opened.id, 1, 512, signal), { code: 'pdf/invalid-page' })
      await assert.rejects(service.renderOcrImage(sessionId, opened.id, 1, undefined, 512, signal), { code: 'pdf/invalid-page' })
    }
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('slow OCR PNG compression releases the native lease for UI reads and handle reclamation', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture()), gate = deferred(), encoding = deferred()
  const metrics: IndexPerformanceMetric[] = []
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess,
    async encodeOcrPng(...args) { encoding.resolve(); await gate.promise; return encodePng(...args) },
  })
  const sessionId = 'pdf-service-compression-lease'; let deadline: ReturnType<typeof setTimeout> | undefined
  let image: ReturnType<typeof service.renderOcrImage> | undefined
  try {
    const opened = await open(service, sessionId)
    image = withIndexPerformance(metric => metrics.push(metric), () => service.renderOcrImage(sessionId, opened.id, 1, undefined, 512, signal))
    await encoding.promise
    assert.equal(metrics.filter(metric => metric.stage === 'native-render').length, 1)
    assert.equal(metrics.filter(metric => metric.stage === 'png-encode').length, 0)
    // A real native read, not a mocked scheduler, must complete while the PNG
    // encoder is deliberately stopped. PDFium itself remains FIFO serialized.
    const read = await Promise.race([service.readPageText(sessionId, opened.id, 2, signal), new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Native read was blocked by PNG compression')), 2000)
    })])
    assert.deepEqual(read.content.items.map(item => item.str), ['Native PDF test page 2'])
    await service.releaseDocument(opened.id)
    assert.equal(service.diagnostics().documents, 0)
    gate.resolve()
    const rendered = await image
    assert.deepEqual([...rendered.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(rendered.png.readUInt32BE(16), rendered.width)
    assert.equal(rendered.png.readUInt32BE(20), rendered.height)
    assert.ok(rendered.width <= 512 && rendered.height <= 512)
    assert.equal(metrics.filter(metric => metric.stage === 'png-encode').length, 1)
    assert.ok(metrics.every(metric => metric.durationMs >= 0))
  } finally {
    clearTimeout(deadline); gate.resolve(); await image?.catch(() => undefined)
    await service.dispose(); await state.workspaces.dispose()
  }
})

test('OCR pixels encoded outside the lease still fence revision, content, bytes and cancellation', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture()), sessionId = 'pdf-service-encode-fences'
  let changed: 'revision' | 'content' | 'bytes' | undefined, gate = deferred(), encoding = deferred()
  const workspaces = { ...state.workspaces, readSnapshot(...args: Parameters<typeof state.workspaces.readSnapshot>) {
    const snapshot = state.workspaces.readSnapshot(...args)
    if (changed === 'revision') return { ...snapshot, revision: snapshot.revision + 1 }
    if (changed === 'content') return { ...snapshot, contentVersion: 'changed-during-encode' }
    if (changed === 'bytes') return { ...snapshot, bytes: Uint8Array.from([...snapshot.bytes, 0]) }
    return snapshot
  } }
  const service = createPdfService(workspaces, { executable, subprocess: nativeTestSubprocess,
    async encodeOcrPng(...args) { encoding.resolve(); await gate.promise; return encodePng(...args) },
  })
  try {
    const opened = await open(service, sessionId)
    for (const fault of ['revision', 'content', 'bytes', 'cancel'] as const) {
      changed = undefined; gate = deferred(); encoding = deferred()
      const abort = new AbortController(), image = service.renderOcrImage(sessionId, opened.id, 1, undefined, 512, abort.signal)
      const rejected = assert.rejects(image, fault === 'cancel' ? /Cancelled while encoding/ : { code: 'pdf/stale-reader' })
      await encoding.promise
      if (fault === 'cancel') abort.abort(new Error('Cancelled while encoding'))
      else changed = fault
      gate.resolve(); await rejected
      assert.equal(service.diagnostics().documents, 1)
    }
  } finally { gate.resolve(); await service.dispose(); await state.workspaces.dispose() }
})

test('disposing during OCR compression closes native resources and never publishes the late image', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture()), gate = deferred(), encoding = deferred()
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess,
    async encodeOcrPng(...args) { encoding.resolve(); await gate.promise; return encodePng(...args) },
  })
  const sessionId = 'pdf-service-encode-unload'
  try {
    const opened = await open(service, sessionId)
    const image = service.renderOcrImage(sessionId, opened.id, 1, undefined, 512, signal)
    const rejected = assert.rejects(image, { code: 'pdf/unavailable' })
    await encoding.promise
    await service.dispose()
    assert.equal(service.diagnostics().documents, 0)
    gate.resolve(); await rejected
    await assert.rejects(service.renderOcrImage(sessionId, opened.id, 1, undefined, 512, signal), { code: 'pdf/unavailable' })
  } finally { gate.resolve(); await service.dispose(); await state.workspaces.dispose() }
})

test('OCR rejects corrupt pixel buffers before handing them to the encoder', { skip }, async t => {
  const state = memoryWorkspace(await nativeFixture()), request = NativeWorker.prototype.request
  let encodes = 0, fault: 'dimensions' | 'bytes' = 'bytes'
  t.mock.method(NativeWorker.prototype, 'request', async function(this: NativeWorker, ...args: Parameters<NativeWorker['request']>) {
    const reply = await request.apply(this, args)
    if ((args[0] as { command: string }).command !== 'render') return reply
    return fault === 'bytes' ? { ...reply, bytes: reply.bytes.subarray(4) }
      : { ...reply, value: { ...reply.value as object, width: 0 } }
  })
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess,
    async encodeOcrPng(...args) { encodes++; return encodePng(...args) },
  })
  const sessionId = 'pdf-service-ocr-pixel-bound'
  try {
    const opened = await open(service, sessionId)
    for (const mode of ['dimensions', 'bytes'] as const) {
      fault = mode
      await assert.rejects(service.renderOcrImage(sessionId, opened.id, 1, undefined, 512, signal), { code: 'pdf/native-protocol' })
    }
    assert.equal(encodes, 0)
    await service.releaseDocument(opened.id); assert.equal(service.diagnostics().documents, 0)
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('unloading when native pixels arrive never admits PNG compression after the lease', { skip }, async t => {
  const state = memoryWorkspace(await nativeFixture()), request = NativeWorker.prototype.request
  let service!: ReturnType<typeof createPdfService>, unloading: Promise<void> | undefined, encodes = 0
  t.mock.method(NativeWorker.prototype, 'request', async function(this: NativeWorker, ...args: Parameters<NativeWorker['request']>) {
    const reply = await request.apply(this, args)
    if ((args[0] as { command: string }).command === 'render') unloading = service.dispose()
    return reply
  })
  service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess,
    async encodeOcrPng(...args) { encodes++; return encodePng(...args) },
  })
  const sessionId = 'pdf-service-unload-after-raster'
  try {
    const opened = await open(service, sessionId)
    await assert.rejects(service.renderOcrImage(sessionId, opened.id, 1, undefined, 512, signal), { code: 'pdf/unavailable' })
    await unloading
    assert.equal(encodes, 0); assert.equal(service.diagnostics().documents, 0)
  } finally { await unloading; await service.dispose(); await state.workspaces.dispose() }
})

test('wire returns an annotation delta for a continuous open and open fails a missing capability', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture())
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-delta'
  try {
    const opened = await open(service, sessionId)
    const delta = await service.dispatch(sessionId, {
      action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`,
      knownRevision: opened.revision, knownBytesHash: opened.reader.bytesHash,
    }, agent(sessionId), signal) as { document?: unknown; annotationDelta?: unknown }
    assert.equal(delta.document, undefined)
    assert.ok(delta.annotationDelta, 'a continuous open can omit unchanged document metadata')
  } finally { await service.dispose() }

  const unavailable = new CapabilityRegistry()
  unavailable.plan = async () => ({ supported: false, missing: [{ capability: pdfCapabilities.renderPage }] }) as never
  const denied = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess, capabilities: unavailable })
  try { await assert.rejects(open(denied, 'pdf-service-missing-capability'), { code: 'pdf/native-unsupported' }) }
  finally { await denied.dispose(); await state.workspaces.dispose() }
})
