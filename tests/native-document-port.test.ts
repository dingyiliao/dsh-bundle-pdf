import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createNativeDocumentPort } from '../src/adapters/host/pdfium/document-port.js'
import { NativeWorker } from '../src/engine/host/native-worker.js'
import type { PdfWorkingCopyOperation } from '../src/core/pdf-types.js'
import { acroformFixture } from './fixtures/acroform.js'
import { classicPdf, onePagePdf, pdfDict, pdfHex } from './fixtures/pdf-fixture-kit.ts'
import { NativeTestSubprocess } from './native-test-subprocess.js'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const required = process.env.DSH_PDF_REQUIRE_NATIVE_EXTENSIONS === '1'
const skip = !required && !existsSync(executable)

async function patchedSubprocess(t: TestContext): Promise<NativeTestSubprocess | undefined> {
  const subprocess = new NativeTestSubprocess()
  const probe = new NativeWorker(executable, subprocess)
  try {
    await probe.ready()
    if (!probe.documentExtensions && !required) {
      t.skip('Native helper does not expose PDFium extensions')
      return undefined
    }
    assert.equal(probe.documentExtensions, true)
  } finally { await probe.dispose() }
  return subprocess
}

test('native document port publishes one mixed PDF transaction and preserves content identity after reopen', { skip }, async t => {
  const subprocess = await patchedSubprocess(t)
  if (!subprocess) return
  const port = createNativeDocumentPort(executable, subprocess)
  t.after(() => port.dispose())

  const bytes = await acroformFixture()
  const before = await port.inspect(bytes)
  assert.equal(before.pageCount, 2)
  assert.ok(before.indexContentDigest)
  assert.deepEqual(before.outline, [])
  const operations: PdfWorkingCopyOperation[] = [
    { type: 'add', annotation: { id: 'new-highlight', page: 1, subtype: 'Highlight',
      rect: [20, 40, 95, 55], quadPoints: [20, 55, 95, 55, 20, 40, 95, 40], color: [0.2, 0.7, 1] } },
    { type: 'add', annotation: { id: 'new-reply', page: 1, subtype: 'Text', replyToId: 'new-highlight',
      rect: [90, 50, 105, 66], contents: '回复', author: 'Reader' } },
    { type: 'update', id: 'new-highlight', patch: { commentPosition: [120, 150] } },
    { type: 'outline-add', id: 'bookmark', title: '目录', page: 2 },
    { type: 'set-field', name: 'Text1', value: 'Native' },
  ]
  const dates = operations.map(() => '2026-11-09T00:00:00Z')
  const saved = await port.materialize(bytes, operations, dates)
  const reopened = await port.inspect(saved.bytes)
  assert.deepEqual(reopened, saved.document)
  assert.equal(reopened.indexContentDigest, before.indexContentDigest)
  const highlight = reopened.annotations.find(item => item.id === 'new-highlight')!
  const reply = reopened.annotations.find(item => item.id === 'new-reply')!
  assert.deepEqual(highlight.commentPosition, [120, 150])
  assert.equal(reply.replyToId, highlight.id)
  assert.equal(reply.contents, '回复')
  assert.equal(reopened.formFields?.find(field => field.name === 'Text1')?.value, 'Native')
  assert.equal(reopened.outline?.[0]?.title, '目录')
  assert.ok(reopened.annotations.find(item => item.id === highlight.id)?.editable)
  await assert.rejects(port.materialize(saved.bytes, [{ type: 'delete', id: highlight.id }], dates.slice(0, 1)),
    { code: 'annotation-read-only' })
  const moved = await port.materialize(saved.bytes, [{ type: 'update', id: highlight.id,
    patch: { commentPosition: [130, 160] } }], dates.slice(0, 1))
  assert.deepEqual(moved.document.annotations.find(item => item.id === highlight.id)?.commentPosition, [130, 160])
  const deleted = await port.materialize(moved.bytes, [{ type: 'delete', id: reply.id }, { type: 'delete', id: highlight.id }],
    dates.slice(0, 2))
  assert.equal(deleted.document.annotations.some(item => item.id === highlight.id || item.id === reply.id), false)
  assert.equal(deleted.document.indexContentDigest, before.indexContentDigest)
})

test('native annotation edits retain named links and persist moved and recolored notes with exact markup', { skip }, async t => {
  const subprocess = await patchedSubprocess(t)
  if (!subprocess) return
  const port = createNativeDocumentPort(executable, subprocess)
  t.after(() => port.dispose())
  const source = onePagePdf({ pageEntries: { Annots: '[7 0 R 8 0 R]' }, extraObjects: [
    pdfDict({ Type: '/Annot', Subtype: '/Text', Rect: '[10 20 24 34]', RC: pdfHex('rich'), F: '4' }),
    pdfDict({ Type: '/Annot', Subtype: '/Link', Rect: '[25 30 80 40]', A: pdfDict({ S: '/Named', N: '/FirstPage' }) }),
  ] })
  const { annotations } = await port.inspect(source)
  const note = annotations.find(annotation => annotation.subtype === 'Text')!
  assert.equal(note.hasRichText, true)
  assert.equal(annotations.find(annotation => annotation.subtype === 'Link')?.linkAction, 'FirstPage')
  const operations: PdfWorkingCopyOperation[] = [
    { type: 'update', id: note.id, patch: { contents: 'Plain', color: [0.25, 0.5, 0.75], rect: [80, 90, 104, 114] } },
    { type: 'add', annotation: { id: 'line', page: 1, subtype: 'Underline', rect: [25, 30, 80, 40],
      quadPoints: [25, 40, 80, 40, 25, 30, 80, 30] } },
  ]
  const saved = await port.materialize(source, operations, operations.map(() => '2026-11-09T00:00:00Z'))
  const updated = saved.document.annotations.find(annotation => annotation.id === note.id)!
  assert.equal(updated.contents, 'Plain')
  assert.equal(updated.hasRichText, undefined)
  assert.deepEqual(updated.rect, [80, 90, 104, 114])
  assert.deepEqual(updated.color, [0.25, 0.5, 0.75])
  assert.equal(saved.document.annotations.find(annotation => annotation.subtype === 'Link')?.linkAction, 'FirstPage')
  assert.deepEqual(saved.document.annotations.find(annotation => annotation.id === 'line')?.quadPoints,
    [25, 40, 80, 40, 25, 30, 80, 30])
})

function oversizedForm(signed: boolean): Uint8Array {
  const fields = Array.from({ length: 5001 }, (_, index) => `<< /FT /Tx /T (Field${index}) /V (Old) >>`)
  const fieldRefs = fields.map((_, index) => `${index + 4} 0 R`).join(' ')
  const permissions = signed ? '/Perms << /UR3 << /Contents <0102> >> >>' : ''
  return classicPdf([
    `<< /Type /Catalog /Pages 2 0 R ${permissions} /AcroForm << /Fields [${fieldRefs}] >> >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>',
    ...fields,
  ])
}

test('paginated inspection preserves signature protection for a large form', { skip }, async t => {
  const subprocess = await patchedSubprocess(t)
  if (!subprocess) return
  const port = createNativeDocumentPort(executable, subprocess)
  t.after(() => port.dispose())
  const bytes = oversizedForm(true)
  const document = await port.inspect(bytes)
  assert.equal(document.formKind, 'acroform')
  assert.equal(document.formFields?.length, 5001)
  assert.ok(document.formFields?.every(field => field.readOnly))
  assert.equal(document.signed, true)
  assert.equal(document.readOnlyReason, 'signed-document')
  await assert.rejects(port.materialize(bytes, [
    { type: 'add', annotation: { id: 'denied', page: 1, subtype: 'Text', rect: [10, 10, 20, 20] } },
  ], ['2026-11-09T00:00:00Z']), { code: 'read-only' })
})

test('native document inspection reads a large form across pages of metadata and classifies encrypted files', { skip }, async t => {
  const subprocess = await patchedSubprocess(t)
  if (!subprocess) return
  const port = createNativeDocumentPort(executable, subprocess)
  t.after(() => port.dispose())
  const document = await port.inspect(oversizedForm(false))
  assert.equal(document.formFields?.length, 5001)
  assert.equal(document.signed, false)
  assert.equal(document.readOnly, false)
  assert.ok(document.indexContentDigest)
  for (const file of ['encrypted-object-stream.pdf', 'password-object-stream.pdf']) {
    const encrypted = await readFile(new URL(`./fixtures/${file}`, import.meta.url))
    await assert.rejects(port.inspect(encrypted), { code: 'encrypted' })
  }
})

test('native form failure aborts the transaction and leaves source bytes untouched', { skip }, async t => {
  const subprocess = await patchedSubprocess(t)
  if (!subprocess) return
  const request = NativeWorker.prototype.request
  let failureCode = 'pdf/native-form'
  t.mock.method(NativeWorker.prototype, 'request', function(this: NativeWorker, ...args: Parameters<typeof request>) {
    if (failureCode && args[0].command === 'applyFormFields') {
      return Promise.reject(Object.assign(new Error('Injected native write failure'), { code: failureCode }))
    }
    return request.apply(this, args)
  })
  const port = createNativeDocumentPort(executable, subprocess)
  t.after(() => port.dispose())
  const bytes = await acroformFixture()
  const operations: PdfWorkingCopyOperation[] = [
    { type: 'add', annotation: { id: 'transaction-note', page: 1, subtype: 'Text', rect: [10, 10, 20, 20] } },
    { type: 'set-field', name: 'Text1', value: 'Native' },
  ]
  const dates = operations.map(() => '2026-11-09T00:00:00Z')
  for (const code of ['pdf/native-form', 'pdf/native-protocol']) {
    failureCode = code
    await assert.rejects(port.materialize(bytes, operations, dates), { code })
    const source = await port.inspect(bytes)
    assert.equal(source.annotations.some(item => item.id === 'transaction-note'), false)
    assert.notEqual(source.formFields?.find(field => field.name === 'Text1')?.value, 'Native')
  }
  failureCode = ''
  const saved = await port.materialize(bytes, operations, dates)
  assert.equal(saved.document.formFields?.find(field => field.name === 'Text1')?.value, 'Native')
  assert.ok(saved.document.annotations.some(item => item.id === 'transaction-note'))
})

test('native document inspection rejects a stalled form cursor and can retry the same input', { skip }, async t => {
  const subprocess = await patchedSubprocess(t)
  if (!subprocess) return
  const request = NativeWorker.prototype.request
  let stall = true
  t.mock.method(NativeWorker.prototype, 'request', async function(this: NativeWorker, ...args: Parameters<typeof request>) {
    const reply = await request.apply(this, args)
    if (stall && args[0].command === 'formFields') return { ...reply, value: { ...reply.value, nextOffset: 0 } }
    return reply
  })
  const port = createNativeDocumentPort(executable, subprocess)
  t.after(() => port.dispose())
  const bytes = await acroformFixture()
  await assert.rejects(port.inspect(bytes), /Invalid native form metadata cursor/)
  stall = false
  assert.ok((await port.inspect(bytes)).formFields?.length)
})

test('native save retains the original identity of a nonzero-generation bookmark', { skip }, async t => {
  const subprocess = await patchedSubprocess(t)
  if (!subprocess) return
  const port = createNativeDocumentPort(executable, subprocess)
  t.after(() => port.dispose())

  const bytes = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>',
    '<< /Producer (fixture) >>',
    '<< /Type /Outlines /Count 1 /First 8 0 R /Last 8 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>',
    '<< /Type /Outlines /Count 1 /First 8 0 R /Last 8 0 R >>',
    '<< /Title (Imported) /Parent 7 0 R /Dest [3 0 R /Fit] >>',
  ])
  const id = 'pdf-outline:8:0'
  assert.equal((await port.inspect(bytes)).outline?.[0]?.id, id)

  const saved = await port.materialize(bytes, [
    { type: 'add', annotation: { id: 'saved-note', page: 1, subtype: 'Text', rect: [10, 10, 20, 20], contents: 'Saved' } },
  ], ['2026-11-09T00:00:00Z'])
  assert.equal(saved.document.outline?.[0]?.id, id)
  const reopened = await port.inspect(saved.bytes)
  assert.deepEqual(saved.document, reopened, 'the save and reopen use the same metadata authority')
  assert.equal(reopened.outline?.[0]?.id, id)
  assert.equal(reopened.annotations.find(item => item.id === 'saved-note')?.contents, 'Saved')
})
