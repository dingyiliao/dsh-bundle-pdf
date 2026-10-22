import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { pdfLibDocumentAdapter } from '../../../src/adapters/host/pdf-lib/document-adapter.ts'
import { createV1DraftRepository } from '../../../src/adapters/host/storage/v1-drafts.ts'
import { digestPdfBytes } from '../../../src/modules/document/index.ts'
import { createWorkingCopyService, type DraftRecord, type WorkingCopyFilePort } from '../../../src/modules/working-copy/index.ts'

test('embedded outline drafts recover after restart and ordinary save commits the outline', async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400]); pdf.addPage([300, 400])
  let current = new Uint8Array(await pdf.save())
  const sessionId = 'outline-recovery', path = '/outline.pdf'
  const address = `dsh-resource://file/session/${sessionId}/%2Foutline.pdf`
  const agent = { session: { id: sessionId, header: { cwd: '/' } } }
  const signal = new AbortController().signal
  const records = new Map<string, DraftRecord>()
  const drafts = createV1DraftRepository({ get: key => records.get(key),
    async put(key, value) { records.set(key, structuredClone(value)) }, async delete(key) { records.delete(key) } })
  const files: WorkingCopyFilePort = {
    async resolvePath() { return path },
    async read() { return { path, bytes: current, version: digestPdfBytes(current), fsVersion: 'fs', size: current.length } },
    async save(_agent, _path, bytes, expected) {
      assert.equal(expected, digestPdfBytes(current))
      current = new Uint8Array(bytes)
      return { path, version: digestPdfBytes(current), fsVersion: 'saved', size: current.length }
    },
  }
  let service = createWorkingCopyService(files, drafts, pdfLibDocumentAdapter)
  try {
    const opened = await service.execute(sessionId, { action: 'open', sessionId, address }, agent, signal)
    assert.ok('bytes' in opened)
    const original = current.slice()
    const changed = await service.execute(sessionId, { action: 'change', sessionId, id: opened.id,
      revision: opened.revision, operations: [{ type: 'outline-add', id: 'chapter', title: 'Embedded chapter', page: 1 }] }, agent, signal)
    assert.ok('bytes' in changed)
    assert.equal(changed.dirty, true)
    assert.deepEqual(current, original)
    assert.ok(records.size > 0)
    await service.dispose()
    service = createWorkingCopyService(files, drafts, pdfLibDocumentAdapter)
    const recovered = await service.execute(sessionId, { action: 'open', sessionId, address }, agent, signal)
    assert.ok('bytes' in recovered)
    assert.equal(recovered.document.outline?.[0].title, 'Embedded chapter')
    assert.equal(recovered.dirty, true)
    const undone = await service.execute(sessionId, { action: 'undo', sessionId,
      id: recovered.id, revision: recovered.revision }, agent, signal)
    assert.ok('bytes' in undone)
    assert.deepEqual(undone.document.outline, [])
    const redone = await service.execute(sessionId, { action: 'redo', sessionId,
      id: recovered.id, revision: undone.revision }, agent, signal)
    assert.ok('bytes' in redone)
    const saved = await service.execute(sessionId, { action: 'save', sessionId,
      id: redone.id, revision: redone.revision, options: {} }, agent, signal)
    assert.ok('bytes' in saved)
    assert.equal(saved.dirty, false)
    assert.equal(saved.document.outline?.[0].title, 'Embedded chapter')
    assert.equal(records.size, 0)
  } finally { await service.dispose() }
})
