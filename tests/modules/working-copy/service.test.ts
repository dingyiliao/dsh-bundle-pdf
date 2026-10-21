import assert from 'node:assert/strict'
import test from 'node:test'
import { createV1DraftRepository } from '../../../src/adapters/host/storage/v1-drafts.ts'
import type { PdfDocumentInfo } from '../../../src/core/pdf-types.ts'
import { digestPdfBytes } from '../../../src/modules/document/index.ts'
import { createWorkingCopyService, type DraftRecord, type PdfDocumentPort,
  type WorkingCopyFilePort } from '../../../src/modules/working-copy/index.ts'

const sessionId = 'service-test'
const path = '/fake.pdf'
const address = `dsh-resource://file/session/${sessionId}/%2Ffake.pdf`
const signal = new AbortController().signal
const agent = { session: { id: sessionId, header: { cwd: '/' } } }
const source = Uint8Array.from([1, 2])
const materialized = Uint8Array.from([1, 2, 3])
const info: PdfDocumentInfo = {
  pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }],
  annotations: [], signed: false, encrypted: false, readOnly: false,
}

test('working-copy commands use injected PDF/file ports and preserve logical content across annotation save', async () => {
  const records = new Map<string, DraftRecord>()
  const writes: string[] = []
  const drafts = createV1DraftRepository({
    get: key => records.get(key),
    async put(key, value) { writes.push(key); records.set(key, structuredClone(value)) },
    async delete(key) { records.delete(key) },
  })
  let current: Uint8Array = source
  let inspectCount = 0
  let materializeCount = 0
  let saveExpected: string | null | undefined
  const pdf: PdfDocumentPort = {
    async inspect(bytes) {
      inspectCount += 1
      assert.deepEqual([...bytes], [...source])
      return info
    },
    async materialize(bytes, operations, dates) {
      materializeCount += 1
      assert.deepEqual([...bytes], [...source])
      assert.equal(operations.length, 1)
      assert.equal(dates.length, 1)
      return { bytes: materialized, document: { ...info, annotations: [{
        id: 'note', page: 1, subtype: 'Text', rect: [10, 10, 20, 20],
        flags: 4, supported: true, editable: true,
      }] } }
    },
  }
  const files: WorkingCopyFilePort = {
    async resolvePath(_agent, requested) { assert.equal(requested, path); return path },
    async read(_agent, requested) {
      assert.equal(requested, path)
      return { path, bytes: current, version: digestPdfBytes(current), fsVersion: 'fs-1', size: current.length }
    },
    async save(_agent, requested, bytes, expected) {
      assert.equal(requested, path)
      saveExpected = expected
      current = bytes
      return { path, version: digestPdfBytes(bytes), fsVersion: 'fs-2', size: bytes.length }
    },
  }
  const service = createWorkingCopyService(files, drafts, pdf)
  try {
    const opened = await service.execute(sessionId, { action: 'open', sessionId, address }, agent, signal)
    assert.ok('document' in opened)
    assert.equal(opened.dirty, false)
    const edited = await service.execute(sessionId, {
      action: 'change', sessionId, id: opened.id, revision: opened.revision,
      operations: [{ type: 'add', annotation: { id: 'note', page: 1, subtype: 'Text', rect: [10, 10, 20, 20] } }],
    }, agent, signal)
    assert.ok('document' in edited)
    assert.equal(edited.dirty, true)
    assert.equal(edited.bytes, opened.bytes, 'metadata projection does not rewrite source bytes')
    assert.deepEqual(writes.map(key => key.startsWith('base_')), [true, false])
    const saved = await service.execute(sessionId, {
      action: 'save', sessionId, id: edited.id, revision: edited.revision, options: {},
    }, agent, signal)
    assert.ok('document' in saved)
    assert.equal(saved.dirty, false)
    assert.equal(saved.contentVersion, opened.contentVersion)
    assert.equal(saved.revision, edited.revision + 1)
    assert.equal(inspectCount, 1)
    assert.equal(materializeCount, 1)
    assert.equal(saveExpected, digestPdfBytes(source))
    assert.deepEqual([...current], [...materialized])
    assert.equal(records.size, 0, 'operation record and baseline are cleaned after publication')
  } finally {
    await service.dispose()
  }
})

test('saving a read-only PDF fails before choosing or publishing a destination', async () => {
  const drafts = createV1DraftRepository({
    get() { return undefined },
    async put() { throw new Error('A clean read-only PDF needs no draft') },
    async delete() { throw new Error('A rejected save must not clean drafts') },
  })
  let destinationResolved = false
  const files: WorkingCopyFilePort = {
    async resolvePath() { destinationResolved = true; return path },
    async read() { return { path, bytes: source, version: digestPdfBytes(source), fsVersion: 'fs-1', size: source.length } },
    async save() { throw new Error('Must not publish a read-only PDF') },
  }
  const pdf: PdfDocumentPort = {
    async inspect() { return { ...info, readOnly: true, readOnlyReason: 'Signature permissions forbid edits' } },
    async materialize() { throw new Error('Must not materialize a read-only PDF') },
  }
  const service = createWorkingCopyService(files, drafts, pdf)
  try {
    const opened = await service.execute(sessionId, { action: 'open', sessionId, address }, agent, signal)
    assert.ok('document' in opened)
    destinationResolved = false
    await assert.rejects(service.execute(sessionId, {
      action: 'save', sessionId, id: opened.id, revision: opened.revision, options: {},
    }, agent, signal), { code: 'pdf/read-only', message: 'Signature permissions forbid edits' })
    assert.equal(destinationResolved, false)
  } finally { await service.dispose() }
})

test('revision watch wakes after a durable model-style edit and rejects another session', async () => {
  const records = new Map<string, DraftRecord>()
  const drafts = createV1DraftRepository({
    get: key => records.get(key),
    async put(key, value) { records.set(key, structuredClone(value)) },
    async delete(key) { records.delete(key) },
  })
  const files: WorkingCopyFilePort = {
    async resolvePath() { return path },
    async read() { return { path, bytes: source, version: digestPdfBytes(source), fsVersion: 'fs-1', size: source.length } },
    async save() { throw new Error('No file save expected') },
  }
  const pdf: PdfDocumentPort = {
    async inspect() { return info },
    async materialize() { throw new Error('No materialization expected') },
  }
  const service = createWorkingCopyService(files, drafts, pdf)
  try {
    const opened = await service.execute(sessionId, { action: 'open', sessionId, address }, agent, signal)
    assert.ok('document' in opened)
    await assert.rejects(service.waitForRevision('other-session', opened.id, opened.revision, signal),
      { code: 'pdf/unknown-document' })
    const pending = service.waitForRevision(sessionId, opened.id, opened.revision, signal)
    const changed = await service.execute(sessionId, { action: 'change', sessionId, id: opened.id,
      revision: opened.revision, operations: [{ type: 'add', annotation: {
        id: 'model-note', page: 1, subtype: 'Text', rect: [10, 10, 20, 20], contents: 'model',
      } }] }, agent, signal)
    assert.ok('document' in changed)
    assert.equal(await pending, changed.revision)
    assert.equal(await service.waitForRevision(sessionId, opened.id, opened.revision, signal), changed.revision)
    const abort = new AbortController()
    const cancelled = service.waitForRevision(sessionId, opened.id, changed.revision, abort.signal)
    abort.abort(new Error('reader closed'))
    await assert.rejects(cancelled, /reader closed/)
    const closing = service.waitForRevision(sessionId, opened.id, changed.revision, signal)
    await service.dispose()
    await assert.rejects(closing, { code: 'pdf/unknown-document' })
  } finally { await service.dispose() }
})
