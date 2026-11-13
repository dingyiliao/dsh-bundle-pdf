import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { NativeWorker } from '../../../src/engine/host/native-worker.ts'
import { createPdfService } from '../../../src/adapters/host/pdfium/pdf-service.ts'
import { createLocalTextRecovery } from '../../../src/adapters/host/ocr/local-text-recovery.ts'
import { brokenTextMappingFixture } from '../../fixtures/broken-text-mapping.ts'
import { nativeTestSubprocess } from '../../native-test-subprocess.ts'
import { hyphenatedTextPdf, memoryWorkspace, nativeFixture, digest } from '../../native-fixture.ts'
import { joinPageText } from '../../../src/shared/page-text.ts'
import { readPageWindow } from '../../../src/modules/evidence/agent-page-read.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import type { OcrOutput } from '../../../src/ocr/types.ts'
import { createPageOcrArtifacts } from '../../../src/adapters/host/ocr/page-ocr-artifacts.ts'
import { BUNDLED_LOCAL_OCR_PRODUCER } from '../../../src/adapters/host/ocr/local-identity.ts'
import { createLocalTesseractOcrBackend } from '../../../src/adapters/host/ocr/local-backend.ts'
import { createRetrievalStore } from '../../../src/adapters/host/filesystem/retrieval-store.ts'
import { createPdfPageContent } from '../../../src/adapters/host/dsh/page-content.ts'
import { HostOcrService } from '../../../src/modules/ocr/index.ts'
import { HostImageUnderstandingService } from '../../../src/modules/image-understanding/index.ts'
import { defaultSettings } from '../../../src/shared/contracts.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const skip = !existsSync(executable)
const sessionId = 'recover-text', agent = { session: { id: sessionId, header: {} } }, signal = new AbortController().signal

test('invalid Unicode mapping is detected and repaired once, identically for Reader and model reads', { skip }, async () => {
  const bytes = await brokenTextMappingFixture(), state = memoryWorkspace(bytes)
  const worker = new NativeWorker(executable, nativeTestSubprocess), local = createLocalTextRecovery()
  let calls = 0
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess,
    textRecovery: { dispose: local.dispose, async recognize(...args) { calls++; return local.recognize(...args) } } })
  try {
    await worker.request({ command: 'open', documentId: 'fault' }, bytes)
    const raw = (await worker.request({ command: 'text', documentId: 'fault', pageIndex: 0 })).value as NativeTextContent
    assert.ok(raw.quality!.unmappedCharacters > 0)
    assert.doesNotMatch(joinPageText(raw.items), /Full name in English/)
    const opened = await service.dispatch(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal) as { id: string; reader: { bytesHash: string } }
    const model = await readPageWindow(state.workspaces, service, sessionId, opened.id, 1, undefined, undefined, signal)
    assert.match(model.text, /Full name in English/); assert.equal(model.extraction, 'local-ocr')
    assert.doesNotMatch(model.text, /DO NOT READ|FORM VALUE/)
    const client = await service.native(sessionId, { action: 'text', sessionId, id: opened.id,
      bytesHash: opened.reader.bytesHash, page: 1 }, agent, signal) as NativeTextContent
    assert.equal(joinPageText(client.items), model.text); assert.equal(calls, 1)
    assert.ok(client.items.length >= 4); assert.ok(client.items.every(item => item.width > 0 && item.height > 0))
    assert.equal(state.writes(), 0); assert.deepEqual(state.current(), bytes)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).dirty, false)
  } finally { await service.dispose(); await worker.dispose(); await state.workspaces.dispose() }
})

test('normal native text never starts OCR; cancellation/disposal terminate recognition threads', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture()), local = createLocalTextRecovery()
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess,
    textRecovery: { async recognize() { throw new Error('Normal text must not OCR') }, dispose: local.dispose } })
  try {
    const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
    assert.ok('bytes' in opened)
    assert.match(joinPageText((await service.readPageText(sessionId, opened.id, 1, signal)).content.items), /Native PDF test/)
    const cancelled = new AbortController(); cancelled.abort(new Error('Cancelled by test'))
    await assert.rejects(local.recognize(new Uint8Array(), 100, 100, cancelled.signal), /Cancelled by test/)
    const pending = local.recognize(new Uint8Array([1]), 100, 100, signal)
    const rejected = assert.rejects(pending, /unloading/)
    await local.dispose(); await rejected
    await assert.rejects(local.recognize(new Uint8Array(), 100, 100, signal), /closed/)
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('ordinary line-wrap hyphens keep native text for both model and Reader without starting OCR', { skip }, async () => {
  const state = memoryWorkspace(await hyphenatedTextPdf())
  let calls = 0
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess,
    textRecovery: { async recognize() { calls++; throw new Error('Layout hyphens must not trigger OCR') }, async dispose() {} } })
  try {
    const opened = await service.dispatch(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal) as { id: string; reader: { bytesHash: string } }
    const model = await readPageWindow(state.workspaces, service, sessionId, opened.id, 1, undefined, undefined, signal)
    assert.match(model.text, /understand\s+ing the model/)
    assert.notEqual(model.extraction, 'local-ocr')
    const reader = await service.native(sessionId, { action: 'text', sessionId, id: opened.id,
      bytesHash: opened.reader.bytesHash, page: 1 }, agent, signal) as NativeTextContent
    assert.equal(joinPageText(reader.items), model.text)
    assert.equal(reader.quality, undefined)
    assert.equal(calls, 0)
    assert.equal(state.writes(), 0)
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

test('a queued text repair rejects a baseline changed by reload instead of publishing or caching old text', { skip }, async () => {
  const bytes = await brokenTextMappingFixture(), state = memoryWorkspace(bytes)
  let resume!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { resume = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const output: OcrOutput = { text: 'Recovered label', status: 'complete', blocks: [], lines: [], warnings: [], coverage: [], confidence: null,
    words: [{ id: 'word', text: 'Recovered', parentId: 'line', box: { x0: 20, y0: 20, x1: 80, y1: 40 }, confidence: null }] }
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess,
    textRecovery: { async recognize() { entered(); await gate; return output }, async dispose() { resume() } } })
  try {
    const opened = await service.dispatch(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal) as {
      id: string; revision: number; path: string; reader: { bytesHash: string }
    }
    const first = service.readPageText(sessionId, opened.id, 1, signal)
    const firstRejected = assert.rejects(first, { code: 'pdf/stale-reader' })
    await started
    const common = { sessionId, id: opened.id, bytesHash: opened.reader.bytesHash, page: 1 }
    const second = service.native(sessionId, { ...common, action: 'text' }, agent, signal)
    const secondRejected = assert.rejects(second, { code: 'pdf/stale-reader' })
    // Native lease barrier: the second read has captured its old snapshot and
    // queued behind recognition, without relying on a timeout or private state.
    await service.native(sessionId, { ...common, action: 'links' }, agent, signal)
    await state.files.save(agent, opened.path, new Uint8Array([...bytes, 10, 37, 10]), digest(bytes))
    await state.workspaces.execute(sessionId, { action: 'reload', sessionId, id: opened.id, revision: opened.revision }, agent, signal)
    resume(); await Promise.all([firstRejected, secondRejected])
  } finally { resume(); await service.dispose(); await state.workspaces.dispose() }
})

test('Reader text rechecks its requested bytes after handle admission, even for ordinary native text', { skip }, async () => {
  const bytes = await nativeFixture(), state = memoryWorkspace(bytes)
  const replacement = new Uint8Array([...bytes, 10, 37, 10])
  let changed = false
  const service = createPdfService({ ...state.workspaces, readSnapshot(owner, id) {
    const snapshot = state.workspaces.readSnapshot(owner, id)
    return changed ? { ...snapshot, bytes: replacement, revision: snapshot.revision + 1 } : snapshot
  } }, { executable, subprocess: nativeTestSubprocess })
  try {
    const opened = await service.dispatch(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal) as { id: string; reader: { bytesHash: string } }
    const pending = service.native(sessionId, { action: 'text', sessionId, id: opened.id,
      bytesHash: opened.reader.bytesHash, page: 1 }, agent, signal)
    changed = true // Baseline switches before the asynchronously admitted raw read.
    await assert.rejects(pending, { code: 'pdf/stale-reader' })
  } finally { await service.dispose(); await state.workspaces.dispose() }
})

function sharedFixture(directory: string, bytes: Uint8Array, onRecognize?: (signal: AbortSignal) => Promise<void>) {
  const state = memoryWorkspace(bytes), store = createRetrievalStore({ directory, maxMemoryBytes: 0 })
  const counts = { recognition: 0 }, dimensions: [number, number][] = []
  const recovery = { producer: BUNDLED_LOCAL_OCR_PRODUCER, async recognize(_png: Uint8Array, width: number, height: number, active: AbortSignal) {
    counts.recognition++; dimensions.push([width, height]); await onRecognize?.(active); active.throwIfAborted()
    return { text: 'Recovered label', status: 'complete' as const, blocks: [], lines: [], confidence: null, coverage: [], warnings: [],
      words: [{ id: 'word', text: 'Recovered label', box: { x0: 20, y0: 20, x1: 100, y1: 40 }, confidence: null }] }
  }, async dispose() {} }
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess, textRecovery: recovery,
    ocrArtifacts: createPageOcrArtifacts({ cache: store }) })
  const ocr = new HostOcrService(() => 'local-tesseract'); ocr.register(createLocalTesseractOcrBackend(recovery))
  const settings = () => ({ ...defaultSettings, ocrEngine: 'local-tesseract', indexScanPages: true, indexImageDescriptions: false })
  const content = createPdfPageContent(state.workspaces, service, { settings, ocr: () => ocr, image: () => undefined, cache: store })
  const open = async (session: string) => {
    const opened = await service.dispatch(session, { action: 'open', sessionId: session,
      address: `dsh-resource://file/session/${session}//fixtures/native.pdf` }, { session: { id: session, header: {} } }, signal) as { id: string }
    return opened.id
  }
  return { state, store, counts, dimensions, service, content, ocr, settings, open,
    async dispose() { content.dispose(); ocr.dispose(); await service.dispose(); await state.workspaces.dispose(); await store.dispose() } }
}
async function storedRecords(store: ReturnType<typeof createRetrievalStore>, prefix: string) {
  const entries: [string, unknown][] = []
  let cursor: string | undefined
  do {
    const batch = await store.scan(prefix, cursor)
    entries.push(...batch.entries); cursor = batch.nextKey
  } while (cursor !== undefined)
  return { entries }
}

test('index OCR and read-page recovery share a durable raw artifact in both directions, including a new Host/session/document', { skip }, async () => {
  const bytes = await brokenTextMappingFixture()
  const directory = await mkdtemp(join(tmpdir(), 'pdf-shared-page-ocr-'))
  let f = sharedFixture(directory, bytes)
  const originalRequest = NativeWorker.prototype.request
  let renders = 0
  NativeWorker.prototype.request = function(command, ...args) {
    if ('command' in command && command.command === 'render') renders++
    return originalRequest.call(this, command, ...args)
  }
  try {
    const id = await f.open('index-first')
    const indexed = await f.content.read('index-first', id, 1, signal)
    const representation = indexed.blocks.flatMap(block => block.representations).find(rep => rep.kind === 'ocr-text')!
    assert.equal(representation.text, 'Recovered label')
    assert.notEqual(indexed.nativeText.text, representation.text, 'OCR must not become native text or exact native ranges')
    assert.equal(f.counts.recognition, 1); assert.equal(Math.max(...f.dimensions[0]!), 2048)
    const afterIndex = renders
    const read = await f.service.readPageText('index-first', id, 1, signal)
    assert.equal(read.content.extraction, 'local-ocr'); assert.equal(joinPageText(read.content.items), representation.text)
    assert.ok(read.content.items.every(item => item.glyphs === undefined))
    assert.equal(f.counts.recognition, 1); assert.equal(renders, afterIndex, 'artifact reuse avoids rasterizing as well as recognizing')
    const artifactRecords = await storedRecords(f.store, 'pageocr_')
    assert.equal(artifactRecords.entries.length, 1)
    await f.dispose()
    f = sharedFixture(directory, bytes)
    const reopenedId = await f.open('reader-after-restart')
    assert.notEqual(reopenedId, id)
    const restored = await f.service.readPageText('reader-after-restart', reopenedId, 1, signal)
    assert.equal(restored.content.extraction, 'local-ocr'); assert.equal(f.counts.recognition, 0); assert.equal(renders, afterIndex)
    // Remove only the final/representation cache in this isolated test store.
    // The raw OCR derivative alone is enough to reconstruct an index layer.
    for (const [key] of (await storedRecords(f.store, 'pagecontent_')).entries) await f.store.delete(key)
    const rebuilt = await f.content.read('reader-after-restart', reopenedId, 1, signal)
    assert.equal(rebuilt.blocks.flatMap(block => block.representations).find(rep => rep.kind === 'ocr-text')!.inputDigest, representation.inputDigest)
    assert.equal(f.counts.recognition, 0); assert.equal(renders, afterIndex)
    assert.deepEqual((await storedRecords(f.store, 'pageocr_')).entries, artifactRecords.entries)
  } finally { NativeWorker.prototype.request = originalRequest; await f.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('an index subscriber can cancel while another session completes the same local repair and caches it', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-shared-ocr-cancel-'))
  let entered!: () => void, finish!: () => void, producing!: AbortSignal
  const started = new Promise<void>(yes => { entered = yes }), gate = new Promise<void>(yes => { finish = yes })
  const f = sharedFixture(directory, await brokenTextMappingFixture(), async active => { producing = active; entered(); await gate })
  const abortIndex = new AbortController()
  try {
    const indexId = await f.open('cancel-index'), readerId = await f.open('keep-reader')
    const indexing = f.content.read('cancel-index', indexId, 1, abortIndex.signal)
    const rejected = assert.rejects(indexing, /Index subscriber cancelled/)
    await started
    const reading = f.service.readPageText('keep-reader', readerId, 1, signal)
    // A native-read lease barrier admits the second read before cancellation.
    await f.service.readOutline('keep-reader', readerId, signal)
    abortIndex.abort(new Error('Index subscriber cancelled')); await rejected
    assert.equal(producing.aborted, false)
    finish()
    assert.equal((await reading).content.extraction, 'local-ocr')
    assert.equal(f.counts.recognition, 1); assert.equal((await storedRecords(f.store, 'pageocr_')).entries.length, 1)
  } finally { finish(); await f.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('existing 1024px OCR index representations retain provenance and remain readable without masquerading as a 2048px raw artifact', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-legacy-page-ocr-')), f = sharedFixture(directory, await brokenTextMappingFixture())
  const legacy = createPdfPageContent(f.state.workspaces,
    { readPageText: f.service.readPageText, renderOcrImage: f.service.renderOcrImage },
    { settings: f.settings, ocr: () => f.ocr, image: () => undefined, cache: f.store })
  try {
    const id = await f.open('legacy-index')
    const original = await legacy.read('legacy-index', id, 1, signal)
    assert.equal(Math.max(...f.dimensions[0]!), 1024)
    const cached = await f.content.read('legacy-index', id, 1, signal)
    assert.deepEqual(cached, original); assert.equal(f.counts.recognition, 1)
    assert.equal((await storedRecords(f.store, 'pageocr_')).entries.length, 0, 'a lossy PageRepresentation is not fabricated into raw OCR')
    await f.service.readPageText('legacy-index', id, 1, signal)
    assert.equal(f.counts.recognition, 2); assert.equal(Math.max(...f.dimensions[1]!), 2048)
    assert.deepEqual(await f.content.read('legacy-index', id, 1, signal), original)
  } finally { legacy.dispose(); await f.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('third-party OCR keeps its own input/producer and shares one clean raster with image descriptions', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-external-page-ocr-')), f = sharedFixture(directory, await brokenTextMappingFixture())
  let externalCalls = 0, imageCalls = 0, renders = 0
  f.ocr.register({ descriptor: { id: 'fixture-external', name: 'External OCR', version: 'fixture/1', execution: 'local',
    geometry: [], confidence: false }, async availability() { return { status: 'available' } },
    async cacheIdentity() { return 'external-model-configuration-one' },
    async recognize(request) {
      externalCalls++; assert.equal(Math.max(request.width, request.height), 1024)
      return { text: 'External OCR text', blocks: [], lines: [], words: [], confidence: null,
        coverage: [], warnings: [], status: 'complete' }
    } })
  const image = new HostImageUnderstandingService(() => 'fixture-image')
  image.register({ descriptor: { id: 'fixture-image', name: 'Fixture image', version: '1', execution: 'local' },
    async availability() { return { available: true } }, async cacheIdentity() { return 'stable-image-model' },
    async understand(request) { imageCalls++; assert.equal(Math.max(request.image.width, request.image.height), 1024); return { text: 'Visible chart description' } } })
  const content = createPdfPageContent(f.state.workspaces, f.service, { settings: () => ({ ...f.settings(),
    ocrEngine: 'fixture-external', imageEngine: 'fixture-image', indexImageDescriptions: true }),
    ocr: () => f.ocr, image: () => image, cache: f.store })
  const originalRequest = NativeWorker.prototype.request
  NativeWorker.prototype.request = function(command, ...args) {
    if ('command' in command && command.command === 'render') renders++
    return originalRequest.call(this, command, ...args)
  }
  try {
    const id = await f.open('external-index')
    const indexed = await content.read('external-index', id, 1, signal)
    const representation = indexed.blocks.flatMap(block => block.representations).find(rep => rep.kind === 'ocr-text')!
    assert.equal(representation.producer.id, 'fixture-external')
    assert.equal(externalCalls, 1); assert.equal(imageCalls, 1); assert.equal(renders, 1)
    assert.equal(f.counts.recognition, 0, 'an explicitly selected external producer does not fall back to local OCR')
    const externalArtifacts = await storedRecords(f.store, 'pageocr_')
    assert.equal(externalArtifacts.entries.length, 1)
    const raw = externalArtifacts.entries[0]![1] as { producer: { id: string; requestIdentity: string }; input: { render: { width: number } } }
    assert.equal(raw.producer.id, 'fixture-external'); assert.match(raw.producer.requestIdentity, /languages/)
    assert.equal(raw.input.render.width, 1024)
    await f.service.readPageText('external-index', id, 1, signal)
    assert.equal(f.counts.recognition, 1, 'local repair cannot consume the different external producer or 1024px input')
    assert.equal((await storedRecords(f.store, 'pageocr_')).entries.length, 2)
    assert.equal(externalCalls, 1)
  } finally {
    NativeWorker.prototype.request = originalRequest; content.dispose(); image.dispose(); await f.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('PDF disposal stops the local producer while draining a shared artifact, even when adapter disposal releases recognition', { skip }, async () => {
  const state = memoryWorkspace(await brokenTextMappingFixture())
  let entered!: () => void, finish!: () => void, disposed = 0
  const started = new Promise<void>(yes => { entered = yes }), gate = new Promise<void>(yes => { finish = yes })
  const service = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess,
    textRecovery: { producer: BUNDLED_LOCAL_OCR_PRODUCER, async recognize() {
      entered(); await gate
      return { text: '', blocks: [], lines: [], words: [], confidence: null, coverage: [], warnings: [], status: 'complete' }
    }, async dispose() { disposed++; finish() } } })
  try {
    const opened = await service.dispatch(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal) as { id: string }
    const reading = service.readPageText(sessionId, opened.id, 1, signal)
    const rejected = assert.rejects(reading, /abort/i)
    await started; await service.dispose(); await rejected
    assert.equal(disposed, 1)
    assert.equal(service.diagnostics().documents, 0)
  } finally { finish(); await service.dispose(); await state.workspaces.dispose() }
})
