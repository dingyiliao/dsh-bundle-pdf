import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { NativeWorker } from '../../../src/adapters/host/pdfium/native-worker.ts'
import { createPdfService } from '../../../src/adapters/host/pdfium/pdf-service.ts'
import { createLocalTextRecovery } from '../../../src/adapters/host/ocr/local-text-recovery.ts'
import { brokenTextMappingFixture } from '../../fixtures/broken-text-mapping.ts'
import { nativeTestSubprocess } from '../../native-test-subprocess.ts'
import { hyphenatedTextPdf, memoryWorkspace, nativeFixture, digest } from '../../native-fixture.ts'
import { joinPageText } from '../../../src/shared/page-text.ts'
import { readPageWindow } from '../../../src/modules/evidence/agent-page-read.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import type { OcrOutput } from '../../../src/ocr/types.ts'

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
