import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { pdfLibDocumentAdapter } from '../../../src/adapters/host/pdf-lib/document-adapter.js'
import { createV1DraftRepository } from '../../../src/adapters/host/storage/v1-drafts.js'
import { digestPdfBytes } from '../../../src/modules/document/index.js'
import { createWorkingCopyService, type DraftRecord, type WorkingCopyFilePort } from '../../../src/modules/working-copy/index.js'

const sessionId = 'form-workflow'
const path = '/form.pdf'
const address = `dsh-resource://file/session/${sessionId}/%2Fform.pdf`
const agent = { session: { id: sessionId, header: { cwd: '/' } } }
const signal = new AbortController().signal

test('form edits use one durable draft, undo/redo, and the ordinary safe-save transaction', async () => {
  const formPdf = await PDFDocument.create()
  const page = formPdf.addPage([300, 400])
  formPdf.getForm().createTextField('applicant').addToPage(page, { x: 20, y: 300, width: 150, height: 24 })
  let current: Uint8Array = new Uint8Array(await formPdf.save())
  const records = new Map<string, DraftRecord>()
  const drafts = createV1DraftRepository({
    get: key => records.get(key),
    async put(key, value) { records.set(key, structuredClone(value)) },
    async delete(key) { records.delete(key) },
  })
  const files: WorkingCopyFilePort = {
    async resolvePath() { return path },
    async read() { return { path, bytes: current, version: digestPdfBytes(current), fsVersion: 'fs-1', size: current.length } },
    async save(_agent, _path, bytes, expected) {
      assert.equal(expected, digestPdfBytes(current))
      current = bytes
      return { path, version: digestPdfBytes(bytes), fsVersion: 'fs-2', size: bytes.length }
    },
  }
  const service = createWorkingCopyService(files, drafts, pdfLibDocumentAdapter)
  try {
    const opened = await service.execute(sessionId, { action: 'open', sessionId, address }, agent, signal)
    assert.ok('document' in opened)
    assert.equal(opened.document.readOnly, false)
    const change = (id: string, revision: number, value: string) => service.execute(sessionId, {
      action: 'change', sessionId, id, revision, operations: [{ type: 'set-field', name: 'applicant', value }],
    }, agent, signal)
    const first = await change(opened.id, opened.revision, '第一个值')
    assert.ok('document' in first)
    assert.equal(first.document.formFields?.[0].value, '第一个值')
    assert.equal(first.dirty, true)
    const undone = await service.execute(sessionId, { action: 'undo', sessionId, id: first.id, revision: first.revision }, agent, signal)
    assert.ok('document' in undone)
    assert.equal(undone.document.formFields?.[0].value, '')
    const redone = await service.execute(sessionId, { action: 'redo', sessionId, id: undone.id, revision: undone.revision }, agent, signal)
    assert.ok('document' in redone)
    assert.equal(redone.document.formFields?.[0].value, '第一个值')
    const second = await change(redone.id, redone.revision, '最终值')
    assert.ok('document' in second)
    assert.equal(second.document.formFields?.[0].value, '最终值')
    const saved = await service.execute(sessionId, {
      action: 'save', sessionId, id: second.id, revision: second.revision, options: {},
    }, agent, signal)
    assert.ok('document' in saved)
    assert.equal(saved.dirty, false)
    assert.equal((await PDFDocument.load(current)).getForm().getTextField('applicant').getText(), '最终值')
    assert.equal(records.size, 0)
  } finally { await service.dispose() }
})
