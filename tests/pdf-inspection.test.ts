import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { blankPdf } from './fixtures/plain-pdf.ts'
import { inspectFixturePdf } from './fixtures/native-document.ts'
import { PdfDocumentError } from '../src/core/pdf-types.ts'
import { createWorkspaces } from './fixtures/working-copy-service.ts'

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`./fixtures/${name}.pdf`, import.meta.url)))
}

test('the ordinary native document port redirects encrypted object streams to protected handling', async () => {
  for (const name of ['encrypted-object-stream', 'password-object-stream']) {
    await assert.rejects(inspectFixturePdf(await fixture(name)), (error: unknown) =>
      error instanceof PdfDocumentError && error.code === 'encrypted')
  }
})

test('ordinary PDFs keep editable metadata and malformed input is rejected', async () => {
  const bytes = blankPdf(1, [300, 400])
  const info = await inspectFixturePdf(bytes)
  assert.equal(info.encrypted, false)
  assert.equal(info.readOnly, false)
  assert.deepEqual(info.pages[0].mediaBox, [0, 0, 300, 400])
  const invalid = Buffer.from('%PDF-1.4\n1 0 obj\ninvalid syntax\nendobj\n%%EOF\n')
  await assert.rejects(inspectFixturePdf(invalid), (error: unknown) =>
    error instanceof PdfDocumentError && error.code === 'invalid-pdf')
})

test('workspaces without the native unlock port reject encrypted PDFs without writing', async () => {
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
      error instanceof PdfDocumentError && error.code === 'encrypted')
    assert.equal(writes, 0)
  } finally { await workspaces.dispose() }
})
