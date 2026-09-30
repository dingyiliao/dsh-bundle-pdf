import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { applyPdfOperations, loadPdfDocument, PdfDocumentError } from '../src/core/pdf-document.ts'
import { loadPdfForReading } from '../src/host/pdf-inspection.ts'
import { createWorkspaces } from '../src/host/workspaces.ts'

async function fixture(name = 'encrypted-object-stream') {
  return new Uint8Array(await readFile(new URL(`./fixtures/${name}.pdf`, import.meta.url)))
}

test('encrypted object streams retain page geometry and native annotations in read-only inspection', async () => {
  const bytes = await fixture()
  const original = bytes.slice()
  // This encrypted object stream fails before pdf-lib reaches its encryption check.
  await assert.rejects(loadPdfDocument(bytes), (error: unknown) => error instanceof PdfDocumentError
    && error.code === 'invalid-pdf' && /Trying to parse invalid object/.test(error.message))
  const info = await loadPdfForReading(bytes)
  assert.equal(info.pageCount, 2)
  assert.equal(info.title, 'Encrypted compatibility fixture')
  assert.equal(info.encrypted, true)
  assert.equal(info.readOnly, true)
  assert.equal(info.readOnlyReason, 'encrypted-document')
  assert.deepEqual(info.pages[0], { page: 1, cropBox: [20, 30, 340, 530], rotation: 90, userUnit: 2 })
  const annotation = info.annotations.find((item) => item.subtype === 'Highlight')!
  assert.equal(annotation.contents, 'Fixture annotation')
  assert.equal(annotation.author, 'Fixture author')
  assert.deepEqual(annotation.rect, [40, 440, 140, 460])
  assert.deepEqual(annotation.quadPoints, [40, 460, 140, 460, 40, 440, 140, 440])
  assert.deepEqual(annotation.color, [1, 1, 0])
  assert.equal(annotation.opacity, 0.4)
  assert.equal(annotation.createdAt, 'D:20260101000000Z')
  assert.equal(annotation.modifiedAt, 'D:20260102000000Z')
  assert.equal(annotation.editable, false)
  assert.equal(annotation.readOnlyReason, 'encrypted-document')
  assert.deepEqual(bytes, original)
  // Compatibility reading must never make the existing editing parser permissive.
  await assert.rejects(applyPdfOperations(bytes, [{ type: 'delete', id: annotation.id }]), PdfDocumentError)
  assert.deepEqual(bytes, original)
})

test('password-protected encrypted input reports the missing password explicitly', async () => {
  await assert.rejects(loadPdfForReading(await fixture('password-object-stream')), (error: unknown) =>
    error instanceof PdfDocumentError && error.code === 'password-required')
})

test('ordinary PDFs keep their editable metadata and strict malformed input is not rescued', async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400])
  const bytes = await pdf.save({ useObjectStreams: false })
  const info = await loadPdfForReading(bytes)
  assert.equal(info.encrypted, false)
  assert.equal(info.readOnly, false)
  assert.deepEqual(info.pages[0].mediaBox, [0, 0, 300, 400])
  // PDF.js ignores this unused object after the trailer, while the editor rejects it.
  const invalid = new Uint8Array(Buffer.concat([bytes, Buffer.from('\n99 0 obj\ninvalid syntax\nendobj\n')]))
  await assert.rejects(loadPdfForReading(invalid), (error: unknown) => error instanceof PdfDocumentError
    && error.code === 'invalid-pdf' && /Trying to parse invalid object/.test(error.message))
})

test('workspaces publish original encrypted bytes and reject edits and saves before writing', async () => {
  const bytes = await fixture()
  const path = 'D:/fixtures/encrypted.pdf'
  const sessionId = 'encrypted-session'
  const version = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  let writes = 0
  const files = {
    resolvePath: async () => path,
    read: async () => ({ path, bytes, version, fsVersion: 'fixture-fs-version' }),
    save: async () => { writes++; throw new Error('Read-only inspection attempted a write') },
  } as unknown as Parameters<typeof createWorkspaces>[0]
  const drafts = { get: () => undefined, put: async () => undefined, delete: async () => undefined }
  const agent = { session: { id: sessionId } } as Parameters<ReturnType<typeof createWorkspaces>['execute']>[2]
  const controller = new AbortController()
  const workspaces = createWorkspaces(files, drafts)
  try {
    const opened = await workspaces.execute(sessionId, {
      action: 'open', sessionId, address: `dsh-resource://file/session/${sessionId}/D%3A/fixtures/encrypted.pdf`,
    }, agent, controller.signal)
    assert.ok('bytes' in opened)
    assert.equal(opened.document.readOnly, true)
    assert.deepEqual(opened.bytes, bytes)
    for (const request of [
      { action: 'save', options: {} },
      { action: 'change', operations: [{ type: 'delete', id: opened.document.annotations[0].id }] },
    ]) {
      await assert.rejects(workspaces.execute(sessionId, {
        ...request, sessionId, id: opened.id, revision: opened.revision,
      }, agent, controller.signal), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'pdf/read-only')
    }
    assert.equal(writes, 0)
  } finally { await workspaces.dispose() }
})
