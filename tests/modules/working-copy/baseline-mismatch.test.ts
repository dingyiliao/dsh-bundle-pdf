import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { PdfDocumentError, type PdfDocumentInfo } from '../../../src/core/pdf-types.ts'
import type { PdfAgent } from '../../../src/adapters/host/dsh/index.ts'
import { createV1DraftRepository } from '../../../src/adapters/host/storage/v1-drafts.ts'
import { createWorkingCopyService, type ProtectedDocumentPort, type V1DraftPort, type WorkingCopyFilePort } from '../../../src/modules/working-copy/index.ts'

const sessionId = 'baseline-mismatch-session'
const path = '/tmp/baseline-mismatch.pdf'
const address = `dsh-resource://file/session/${sessionId}/${encodeURIComponent(path)}`
const agent: PdfAgent = { session: { id: sessionId, header: { cwd: '/tmp' } } }
const signal = new AbortController().signal

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function document(): PdfDocumentInfo {
  return { pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }],
    annotations: [], signed: false, encrypted: false, readOnly: false }
}

test('baseline mismatch preserves operations until an explicit adopt-current choice', async () => {
  let bytes = new Uint8Array([1])
  let version = hash(bytes)
  let fsVersion = 'fs-1'
  const table = new Map<string, any>()
  const tablePort: V1DraftPort = { get: key => table.get(key), put: async (key, value) => { table.set(key, structuredClone(value)) }, delete: async key => { table.delete(key) } }
  const drafts = createV1DraftRepository(tablePort)
  const files: WorkingCopyFilePort = {
    async resolvePath(_agent, requested) { return requested },
    async read() { return { path, bytes: bytes.slice(), version, fsVersion, size: bytes.byteLength } },
    async save() { throw new Error('not used') },
  }
  const pdf = { inspect: async () => document(), materialize: async () => { throw new Error('not used') } }
  const workspaces = createWorkingCopyService(files, drafts, pdf)
  const opened = await workspaces.execute(sessionId, { sessionId, action: 'open', address, owner: 'agent' }, agent, signal)
  assert.ok('id' in opened && 'revision' in opened)
  await assert.rejects(workspaces.execute(sessionId, { sessionId, action: 'change', id: opened.id, revision: opened.revision,
    operations: [{ type: 'add', annotation: { id: 'partial', page: 1, subtype: 'Text', rect: [10, 10, 20, 20], contents: 'partial' } },
      { type: 'update', id: 'missing', patch: { contents: 'must fail' } }] }, agent, signal))
  const unchanged = workspaces.readSnapshot(sessionId, opened.id)
  assert.equal(unchanged.revision, opened.revision)
  assert.equal(unchanged.dirty, false)
  const changed = await workspaces.execute(sessionId, { sessionId, action: 'change', id: opened.id, revision: opened.revision,
    operations: [{ type: 'add', annotation: { id: 'draft-note', page: 1, subtype: 'Text', rect: [10, 10, 20, 20], contents: 'draft' } }] }, agent, signal)
  assert.ok('dirty' in changed && changed.dirty)

  bytes = new Uint8Array([2]); version = hash(bytes); fsVersion = 'fs-2'
  const conflict = await workspaces.execute(sessionId, { sessionId, action: 'open', address, owner: 'agent' }, agent, signal)
  if (!('document' in conflict)) throw new Error('Expected conflict snapshot')
  assert.equal(conflict.conflict, true)
  assert.deepEqual(conflict.baselineMismatch?.choices, ['adopt-current', 'retain-operations'])
  assert.equal(conflict.baselineId, opened.baselineId)
  assert.equal(conflict.dirty, true)
  bytes = new Uint8Array([1]); version = hash(bytes); fsVersion = 'fs-1-reappeared'
  const reverted = await workspaces.execute(sessionId, { sessionId, action: 'refresh', id: conflict.id }, agent, signal)
  if (!('document' in reverted)) throw new Error('Expected reverted snapshot')
  assert.equal(reverted.conflict, false)
  assert.equal(reverted.baselineMismatch, undefined)
  bytes = new Uint8Array([2]); version = hash(bytes); fsVersion = 'fs-2-again'

  const adopted = await workspaces.execute(sessionId, { sessionId, action: 'open', address, owner: 'agent', baselineChoice: 'adopt-current' }, agent, signal)
  if (!('document' in adopted)) throw new Error('Expected adopted snapshot')
  assert.equal(adopted.conflict, false)
  assert.equal(adopted.dirty, false)
  assert.notEqual(adopted.baselineId, conflict.baselineId)
  assert.equal(adopted.canUndo, false)
})

test('protected model opens retain operations until an explicit baseline choice', async () => {
  let bytes = new Uint8Array([11])
  let version = hash(bytes)
  let fsVersion = 'protected-1'
  const table = new Map<string, any>()
  const tablePort: V1DraftPort = { get: key => table.get(key), put: async (key, value) => { table.set(key, structuredClone(value)) }, delete: async key => { table.delete(key) } }
  const drafts = createV1DraftRepository(tablePort)
  const files: WorkingCopyFilePort = {
    async resolvePath(_agent, requested) { return requested },
    async read() { return { path, bytes: bytes.slice(), version, fsVersion, size: bytes.byteLength } },
    async save() { throw new Error('not used') },
  }
  const protectedInfo = (): PdfDocumentInfo => ({ ...document(), encrypted: true, annotationEditing: 'allowed', allowTextExtraction: true })
  const pdf = { inspect: async () => { throw new PdfDocumentError('encrypted', 'protected') }, materialize: async () => { throw new Error('not used') } }
  const protectedPort: ProtectedDocumentPort = {
    async inspect(_bytes, password) { return password === undefined || password === 'secret' ? protectedInfo() : undefined },
    async materializeAnnotations() { throw new Error('not used') },
    release() {},
  }
  const workspaces = createWorkingCopyService(files, drafts, pdf, protectedPort)
  const opened = await workspaces.execute(sessionId, { sessionId, action: 'open', address, owner: 'agent', password: 'secret' }, agent, signal)
  if (!('document' in opened)) throw new Error('Expected protected snapshot')
  const changed = await workspaces.execute(sessionId, { sessionId, action: 'change', id: opened.id, revision: opened.revision,
    operations: [{ type: 'add', annotation: { id: 'protected-note', page: 1, subtype: 'Text', rect: [10, 10, 20, 20], contents: 'draft' } }] }, agent, signal)
  assert.ok('dirty' in changed && changed.dirty)
  const repeated = await workspaces.execute(sessionId, { sessionId, action: 'open', address, owner: 'agent' }, agent, signal)
  if (!('document' in repeated)) throw new Error('Expected repeated protected snapshot')
  assert.equal(repeated.dirty, true, 'repeated model open must reuse the protected operation set')

  bytes = new Uint8Array([12]); version = hash(bytes); fsVersion = 'protected-2'
  const conflict = await workspaces.execute(sessionId, { sessionId, action: 'open', address, owner: 'agent' }, agent, signal)
  if (!('document' in conflict)) throw new Error('Expected protected conflict snapshot')
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.dirty, true)
  assert.deepEqual(conflict.baselineMismatch?.choices, ['adopt-current', 'retain-operations'])

  const adopted = await workspaces.execute(sessionId, { sessionId, action: 'open', address, owner: 'agent', password: 'secret', baselineChoice: 'adopt-current' }, agent, signal)
  if (!('document' in adopted)) throw new Error('Expected protected adopted snapshot')
  assert.equal(adopted.conflict, false)
  assert.equal(adopted.dirty, false)
  assert.notEqual(adopted.baselineId, conflict.baselineId)
  // Windows canonicalizes the backing path after open. Address cleanup must
  // still retire the live identity even when its original lexical key differs.
  await workspaces.execute(sessionId, { sessionId, action: 'discardAddresses', addresses: [address] }, agent, signal)
  assert.deepEqual(workspaces.listDocuments(), [])
  await workspaces.dispose()
})
