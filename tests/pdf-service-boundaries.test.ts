import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib'
import { createPdfService } from '../src/host/pdf-service.ts'
import type { PdfAgent } from '../src/host/transport.ts'
import { memoryWorkspace, nativeFixture } from './native-fixture.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native tests require a built helper')
const skip = !existsSync(executable)
const signal = new AbortController().signal

function agent(sessionId: string): PdfAgent {
  return { session: { id: sessionId, header: {} } }
}

async function open(service: ReturnType<typeof createPdfService>, sessionId: string) {
  return await service.dispatch(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal) as {
    id: string; revision: number; reader: { bytesHash: string }
  }
}

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

test('readOutline preserves a real nested Unicode bookmark tree', { skip }, async () => {
  const pdf = await PDFDocument.create()
  const first = pdf.addPage([300, 400])
  const second = pdf.addPage([300, 400])
  const root = pdf.context.obj({ Type: 'Outlines', Count: 2 })
  const rootRef = pdf.context.register(root)
  const chapter = pdf.context.obj({ Title: PDFHexString.fromText('Chapter 1'), Parent: rootRef, Count: 1,
    Dest: [first.ref, PDFName.of('Fit')] })
  const chapterRef = pdf.context.register(chapter)
  const section = pdf.context.obj({ Title: PDFHexString.fromText('第二节'), Parent: chapterRef,
    Dest: [second.ref, PDFName.of('Fit')] })
  const sectionRef = pdf.context.register(section)
  chapter.set(PDFName.of('First'), sectionRef); chapter.set(PDFName.of('Last'), sectionRef)
  root.set(PDFName.of('First'), chapterRef); root.set(PDFName.of('Last'), chapterRef)
  pdf.catalog.set(PDFName.of('Outlines'), rootRef)
  const state = memoryWorkspace(await pdf.save({ useObjectStreams: false }))
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-outline'
  try {
    const opened = await open(service, sessionId)
    assert.deepEqual((await service.readOutline(sessionId, opened.id, signal)).items, [{
      title: 'Chapter 1', dest: [0, { name: 'Fit' }], items: [
        { title: '第二节', dest: [1, { name: 'Fit' }], items: [] },
      ],
    }])
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
  const document = await PDFDocument.create()
  document.addPage([13, 3000])
  const state = memoryWorkspace(await document.save())
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
  let staleOnSecondRead = false
  let reads = 0
  const workspaces = { ...state.workspaces,
    readSnapshot(sessionId: string, id: string) {
      const snapshot = state.workspaces.readSnapshot(sessionId, id)
      return staleOnSecondRead && ++reads === 2 ? { ...snapshot, revision: snapshot.revision + 1 } : snapshot
    },
  }
  const service = createPdfService(workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-render-race'
  try {
    const opened = await open(service, sessionId)
    staleOnSecondRead = true
    await assert.rejects(service.renderPage(sessionId, opened.id, 1, 512, signal), { code: 'pdf/stale-reader' })
    reads = 0
    await assert.rejects(service.renderOcrImage(sessionId, opened.id, 1, undefined, 512, signal), { code: 'pdf/stale-reader' })
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('corrupt page geometry is rejected before a native render is requested', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture())
  let corrupt = false
  const workspaces = { ...state.workspaces,
    readSnapshot(sessionId: string, id: string) {
      const snapshot = state.workspaces.readSnapshot(sessionId, id)
      if (!corrupt) return snapshot
      const first = snapshot.document.pages[0]!
      return { ...snapshot, document: { ...snapshot.document,
        pages: [{ ...first, userUnit: 0 }, ...snapshot.document.pages.slice(1)] } }
    },
  }
  const service = createPdfService(workspaces, { executable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-service-corrupt-geometry'
  try {
    const opened = await open(service, sessionId)
    corrupt = true
    await assert.rejects(service.renderPage(sessionId, opened.id, 1, 512, signal), { code: 'pdf/invalid-page' })
    await assert.rejects(service.renderOcrImage(sessionId, opened.id, 1, undefined, 512, signal), { code: 'pdf/invalid-page' })
  } finally { await service.dispose(); await state.workspaces.dispose() }
})
