import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { pdfLibDocumentAdapter } from '../src/adapters/host/pdf-lib/document-adapter.ts'
import { createV1DraftRepository } from '../src/adapters/host/storage/v1-drafts.ts'
import { createV1NavigationStore } from '../src/adapters/host/storage/v1-navigation.ts'
import { createReadingPositions,
  type ReadingPositionRecord } from '../src/modules/navigation/index.ts'
import { createWorkingCopyService, type DraftRecord, type HostWorkspaceSnapshot } from '../src/modules/working-copy/index.ts'
import { priorMainDraftSchema,
  priorMainPositionSchema } from './fixtures/v1-storage/prior-main-schemas.ts'

interface Stored<T> { key: string; record: T }
interface CapturedV1 {
  origin: { kind: string; commit: string; sourceSha256: string }
  sessionId: string
  path: string
  address: string
  expected: {
    activeAnnotationIds: string[]
    redoAnnotationIds: string[]
    revision: number
    sourceHash: string
    position: {
      page: number; x: number; y: number; scale: number
      fit: 'custom' | 'width' | 'page'
      viewportAnchor: { x: number; y: number }
    }
  }
  domains: {
    drafts: Stored<DraftRecord>[]
    positions: Stored<ReadingPositionRecord>[]
  }
}

const source = new URL('./fixtures/v1-storage/source.pdf', import.meta.url)
const captureFile = new URL('./fixtures/v1-storage/prior-main-capture.json', import.meta.url)
const sourceHash = (bytes: Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
const draftKey = (sessionId: string, path: string) =>
  createHash('sha256').update(JSON.stringify([sessionId, pathKey(path)])).digest('hex')
const navigationKey = (path: string) => createHash('sha256').update(pathKey(path)).digest('hex')

async function captured(): Promise<{ data: CapturedV1; bytes: Uint8Array }> {
  const data = JSON.parse(await readFile(captureFile, 'utf8')) as CapturedV1
  const bytes = new Uint8Array(await readFile(source))
  return { data, bytes }
}

function harness(data: CapturedV1, bytes: Uint8Array, sourceExists = true) {
  const drafts = new Map(data.domains.drafts.map(({ key, record }) => [key, structuredClone(record)]))
  const positions = new Map(data.domains.positions.map(({ key, record }) => [key, structuredClone(record)]))
  const table = <T>(records: Map<string, T>) => ({
    get: (key: string) => records.get(key),
    async put(key: string, record: T) { records.set(key, structuredClone(record)) },
    async delete(key: string) { records.delete(key) },
  })
  const files: Parameters<typeof createWorkingCopyService>[0] = {
    async resolvePath(_agent, requested) { assert.equal(requested, data.path); return data.path },
    async read(_agent, requested) {
      assert.equal(requested, data.path)
      if (!sourceExists) throw Object.assign(new Error('Captured PDF was deleted'), { code: 'PDF_NOT_FOUND' })
      return { path: data.path, bytes: bytes.slice(), version: sourceHash(bytes),
        fsVersion: 'prior-main-source-1', size: bytes.length }
    },
    async save() { throw new Error('Compatibility replay must not write the source PDF') },
  }
  const start = () => {
    const workingCopy = createWorkingCopyService(files, createV1DraftRepository(table(drafts)), pdfLibDocumentAdapter)
    const positionService = createReadingPositions(workingCopy, createV1NavigationStore(table(positions)))
    const agent = { session: { id: data.sessionId, header: { cwd: '/fixtures' } } }
    const signal = new AbortController().signal
    return {
      open: () => workingCopy.execute(data.sessionId,
        { action: 'open', sessionId: data.sessionId, address: data.address }, agent, signal),
      run: (input: Record<string, unknown>) => workingCopy.execute(data.sessionId,
        { sessionId: data.sessionId, ...input }, agent, signal),
      position: (input: Record<string, unknown>) => positionService.dispatch(data.sessionId,
        { sessionId: data.sessionId, ...input }, agent, signal),
      async dispose() { await positionService.dispose(); await workingCopy.dispose() },
    }
  }
  return { drafts, positions, start }
}

function snapshot(value: unknown): HostWorkspaceSnapshot {
  if (!value || typeof value !== 'object' || !('document' in value)) {
    throw new Error('Expected a working-copy snapshot')
  }
  return value as HostWorkspaceSnapshot
}

test('pre-refactor main writes have unchanged V1 keys, baseline and schema', async () => {
  const { data, bytes } = await captured()
  assert.deepEqual(data.origin, {
    kind: 'pre-refactor-git-main-source',
    commit: '643a7c9512ff615d9d718b70b1f97c617b2b9abd',
    sourceSha256: sourceHash(bytes),
  })
  assert.equal(data.expected.sourceHash, sourceHash(bytes))
  const key = draftKey(data.sessionId, data.path)
  const base = 'base_' + key + '_' + sourceHash(bytes).slice(7)
  assert.deepEqual(data.domains.drafts.map(entry => entry.key), [base, key])
  assert.deepEqual(data.domains.positions.map(entry => entry.key), [navigationKey(data.path)])
  for (const entry of data.domains.drafts) priorMainDraftSchema.parse(entry.record)
  for (const entry of data.domains.positions) priorMainPositionSchema.parse(entry.record)
  assert.equal(data.domains.drafts[0]?.record.original, Buffer.from(bytes).toString('base64'))
  assert.equal(data.domains.drafts[1]?.record.baseKey, base)
})

test('new modules read old main data, keep redo, and write records accepted by old main schemas', async () => {
  const { data, bytes } = await captured()
  const records = harness(data, bytes)
  let reader = records.start()
  try {
    const opened = snapshot(await reader.open())
    assert.deepEqual(opened.document.annotations.map(item => item.id), data.expected.activeAnnotationIds)
    assert.equal(opened.revision, data.expected.revision)
    assert.equal(opened.canRedo, true)
    assert.equal(opened.dirty, true)
    assert.equal(opened.conflict, false)
    const oldPosition = (await reader.position({ action: 'get', id: opened.id })) as {
      position: { position: CapturedV1['expected']['position']; stale: string }
    }
    assert.deepEqual(oldPosition.position.position, data.expected.position)
    assert.equal(oldPosition.position.stale, 'none')

    const redone = snapshot(await reader.run({ action: 'redo', id: opened.id, revision: opened.revision }))
    assert.deepEqual(redone.document.annotations.map(item => item.id), data.expected.redoAnnotationIds)
    const edited = snapshot(await reader.run({ action: 'change', id: redone.id, revision: redone.revision,
      operations: [{ type: 'add', annotation: { id: 'new-module-note', page: 1,
        subtype: 'Text', rect: [120, 40, 140, 60], contents: 'new-module-note' } }] }))
    await reader.position({ action: 'set', id: edited.id,
      position: { ...data.expected.position, x: 45 } })

    for (const record of records.drafts.values()) priorMainDraftSchema.parse(record)
    for (const record of records.positions.values()) priorMainPositionSchema.parse(record)
    const key = draftKey(data.sessionId, data.path)
    assert.equal(records.drafts.get(key)?.cursor, 3)
    assert.equal(records.drafts.get(key)?.groupDates?.length, 3)
    assert.equal(records.drafts.get(key)?.baseKey, data.domains.drafts[1]?.record.baseKey)
    assert.deepEqual([...records.drafts.keys()].sort(), data.domains.drafts.map(entry => entry.key).sort())

    await reader.dispose()
    reader = records.start()
    const reopened = snapshot(await reader.open())
    assert.deepEqual(reopened.document.annotations.map(item => item.id),
      ['old-main-note-a', 'old-main-note-b', 'new-module-note'])
    const savedPosition = (await reader.position({ action: 'get', id: reopened.id })) as {
      position: { position: CapturedV1['expected']['position']; stale: string }
    }
    assert.equal(savedPosition.position.position.x, 45)
    assert.equal(savedPosition.position.stale, 'none')
    assert.deepEqual(bytes, new Uint8Array(await readFile(source)))
  } finally { await reader.dispose() }
})

test('old main split draft still restores its exact baseline after source deletion', async () => {
  const { data, bytes } = await captured()
  const records = harness(data, bytes, false)
  const reader = records.start()
  try {
    const opened = snapshot(await reader.open())
    assert.equal(opened.conflict, true)
    assert.equal(opened.canRedo, true)
    assert.deepEqual(Buffer.from(opened.bytes), Buffer.from(bytes))
    assert.deepEqual(opened.document.annotations.map(item => item.id), data.expected.activeAnnotationIds)
  } finally { await reader.dispose() }
})
