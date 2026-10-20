import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { loadPdfDocument, PdfDocumentError } from '../src/adapters/host/pdf-lib/pdf-document.ts'
import { createWorkspaces } from '../src/host/workspaces.ts'

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`./fixtures/${name}.pdf`, import.meta.url)))
}

test('encrypted PDFs fail strict inspection rather than opening in a second reader', async () => {
  for (const name of ['encrypted-object-stream', 'password-object-stream']) {
    await assert.rejects(loadPdfDocument(await fixture(name)), (error: unknown) =>
      error instanceof PdfDocumentError && error.code === 'invalid-pdf')
  }
})

test('ordinary PDFs keep editable metadata and malformed input is rejected', async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400])
  const bytes = await pdf.save({ useObjectStreams: false })
  const info = await loadPdfDocument(bytes)
  assert.equal(info.encrypted, false)
  assert.equal(info.readOnly, false)
  assert.deepEqual(info.pages[0].mediaBox, [0, 0, 300, 400])
  const invalid = new Uint8Array(Buffer.concat([bytes, Buffer.from('\n99 0 obj\ninvalid syntax\nendobj\n')]))
  await assert.rejects(loadPdfDocument(invalid), (error: unknown) =>
    error instanceof PdfDocumentError && error.code === 'invalid-pdf')
})

test('workspaces reject encrypted PDFs before creating a working copy or writing', async () => {
  const bytes = await fixture('encrypted-object-stream')
  const path = 'D:/fixtures/encrypted.pdf'
  const sessionId = 'encrypted-session'
  let writes = 0
  const files = {
    resolvePath: async () => path,
    read: async () => ({ path, bytes, version: 'fixture-version', fsVersion: 'fixture-fs-version' }),
    save: async () => { writes++; throw new Error('Unexpected write') },
  } as unknown as Parameters<typeof createWorkspaces>[0]
  const drafts = { get: () => undefined, put: async () => undefined, delete: async () => undefined }
  const agent = { session: { id: sessionId } } as Parameters<ReturnType<typeof createWorkspaces>['execute']>[2]
  const workspaces = createWorkspaces(files, drafts)
  try {
    await assert.rejects(workspaces.execute(sessionId, {
      action: 'open', sessionId, address: `dsh-resource://file/session/${sessionId}/D%3A/fixtures/encrypted.pdf`,
    }, agent, new AbortController().signal), (error: unknown) =>
      error instanceof PdfDocumentError && error.code === 'invalid-pdf')
    assert.equal(writes, 0)
  } finally { await workspaces.dispose() }
})
