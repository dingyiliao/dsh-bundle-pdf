import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { PdfAgent } from '../src/adapters/host/dsh/index.ts'
import { draftSchema, type DraftRecord } from '../src/modules/working-copy/index.ts'
import { createWorkspaces } from './fixtures/working-copy-service.ts'

// These JSON records are frozen, synthetic V1 committed-format examples. They
// are deliberately not produced by the createWorkspaces implementation under
// test, and are not evidence of a published release's stored user data.
const sessionId = 'v1-storage-compat'
const path = '/fixtures/v1-storage.pdf'
const address = `dsh-resource://file/session/${sessionId}/${encodeURIComponent(path)}`
const agent: PdfAgent = { session: { id: sessionId, header: { cwd: '/fixtures' } } }
const signal = new AbortController().signal

type Entry = { key: string; record: DraftRecord }
type InlineFixture = { fixtureOrigin: string; key: string; record: DraftRecord }
type SplitFixture = { fixtureOrigin: string; key: string; baseKey: string; records: Entry[] }

async function sourceBytes(): Promise<Uint8Array> {
  return readFile(new URL('./fixtures/v1-storage/source.pdf', import.meta.url))
}

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`./fixtures/v1-storage/${name}.json`, import.meta.url), 'utf8')) as T
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function recordKey(): string {
  return createHash('sha256').update(JSON.stringify([sessionId, path])).digest('hex')
}

function harness(initial: readonly Entry[], bytes: Uint8Array, exists = true) {
  const records = new Map(initial.map(({ key, record }) => [key, structuredClone(record)]))
  const puts: string[] = [], deletes: string[] = []
  const files: Parameters<typeof createWorkspaces>[0] = {
    async resolvePath(_agent, requested) {
      assert.equal(requested, path)
      return path
    },
    async read(_agent, requested) {
      assert.equal(requested, path)
      if (!exists) throw Object.assign(new Error('The synthetic source has been removed'), { code: 'PDF_NOT_FOUND' })
      return { path, bytes: bytes.slice(), version: digest(bytes), fsVersion: 'fs-fixture-v1', size: bytes.length }
    },
    async save() { throw new Error('Compatibility reads must not save the source PDF') },
  }
  const drafts: Parameters<typeof createWorkspaces>[1] = {
    get: key => records.get(key),
    async put(key, record) { puts.push(key); records.set(key, structuredClone(record)) },
    async delete(key) { deletes.push(key); records.delete(key) },
  }
  return { records, puts, deletes, files, drafts }
}

async function snapshot(workspaces: ReturnType<typeof createWorkspaces>, input: Record<string, unknown>) {
  const result = await workspaces.execute(sessionId, { sessionId, ...input }, agent, signal)
  if (!('document' in result)) throw new Error('Expected a PDF working-copy snapshot')
  return result
}

test('frozen V1 inline draft migrates once without losing its redo branch', async () => {
  const saved = await fixture<InlineFixture>('inline')
  const bytes = await sourceBytes()
  assert.match(saved.fixtureOrigin, /committed-format V1/)
  assert.equal(saved.key, recordKey())
  assert.equal(saved.record.sourceHash, digest(bytes))
  assert.equal(saved.record.original, Buffer.from(bytes).toString('base64'))
  draftSchema.parse(saved.record)

  const state = harness([{ key: saved.key, record: saved.record }], bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    assert.deepEqual(opened.document.annotations.map(item => item.id), ['v1-note-a'])
    assert.deepEqual(opened.bytes, bytes)
    assert.equal(opened.revision, 7)
    assert.equal(opened.contentVersion, 'v1-inline-content')
    assert.equal(opened.dirty, true)
    assert.equal(opened.canUndo, true)
    assert.equal(opened.canRedo, true)

    const active = draftSchema.parse(state.records.get(saved.key))
    assert.equal(active.original, undefined)
    assert.equal(active.groupDates?.length, 2)
    const baseKey = `base_${saved.key}_${saved.record.sourceHash.slice(7)}`
    assert.equal(active.baseKey, baseKey)
    assert.equal(state.records.get(baseKey)?.original, saved.record.original)
    assert.deepEqual(state.puts, [baseKey, saved.key])
    assert.deepEqual(state.deletes, [])

    const redone = await snapshot(workspaces, { action: 'redo', id: opened.id, revision: opened.revision })
    assert.deepEqual(redone.document.annotations.map(item => item.id), ['v1-note-a', 'v1-note-b'])
    assert.deepEqual(bytes, await sourceBytes(), 'replaying draft history must not edit the fixture PDF')
  } finally { await workspaces.dispose() }
  const priorPuts = state.puts.length
  const restarted = createWorkspaces(state.files, state.drafts)
  try {
    const reopened = await snapshot(restarted, { action: 'open', address })
    assert.deepEqual(reopened.document.annotations.map(item => item.id), ['v1-note-a', 'v1-note-b'])
    assert.equal(state.puts.length, priorPuts, 'a second open must not repeat the inline-to-baseKey migration')
  } finally { await restarted.dispose() }
})

test('frozen V1 inline original restores without a current source PDF', async () => {
  const saved = await fixture<InlineFixture>('inline')
  const bytes = await sourceBytes()
  const state = harness([{ key: saved.key, record: saved.record }], bytes, false)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    assert.deepEqual(opened.bytes, bytes)
    assert.deepEqual(opened.document.annotations.map(item => item.id), ['v1-note-a'])
    assert.equal(opened.dirty, true)
    assert.equal(opened.conflict, true)
    assert.equal(opened.canRedo, true)
    assert.equal(state.records.get(saved.key)?.original, undefined)
    assert.ok(state.records.get(state.records.get(saved.key)!.baseKey!)?.original)
  } finally { await workspaces.dispose() }
})

test('frozen V1 baseKey draft restores from its baseline even after source deletion', async () => {
  const saved = await fixture<SplitFixture>('base-key')
  const bytes = await sourceBytes()
  assert.match(saved.fixtureOrigin, /committed-format V1/)
  assert.equal(saved.key, recordKey())
  assert.equal(saved.baseKey, `base_${saved.key}_${digest(bytes).slice(7)}`)
  assert.deepEqual(saved.records.map(item => item.key), [saved.baseKey, saved.key])
  for (const { record } of saved.records) draftSchema.parse(record)
  assert.equal(saved.records[0]?.record.original, Buffer.from(bytes).toString('base64'))
  assert.equal(saved.records[1]?.record.baseKey, saved.baseKey)

  const state = harness(saved.records, bytes, false)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    assert.deepEqual(opened.document.annotations.map(item => item.id), ['v1-note-a'])
    assert.deepEqual(opened.bytes, bytes)
    assert.equal(opened.revision, 9)
    assert.equal(opened.contentVersion, 'v1-split-content')
    assert.equal(opened.dirty, true)
    assert.equal(opened.conflict, true, 'the missing current source must remain visible as a conflict')
    assert.equal(opened.canRedo, true)
    assert.deepEqual(state.puts, [], 'a valid split V1 draft does not need migration writes')
    assert.deepEqual(state.deletes, [])
    const redone = await snapshot(workspaces, { action: 'redo', id: opened.id, revision: opened.revision })
    assert.deepEqual(redone.document.annotations.map(item => item.id), ['v1-note-a', 'v1-note-b'])
  } finally { await workspaces.dispose() }
})

test('V1 baseKey cannot hydrate a mismatched baseline', async () => {
  const saved = await fixture<SplitFixture>('base-key')
  const bytes = await sourceBytes()
  const records = structuredClone(saved.records)
  records[0]!.record.sourceHash = `sha256:${'0'.repeat(64)}`
  const state = harness(records, bytes, false)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    await assert.rejects(snapshot(workspaces, { action: 'open', address }), { code: 'pdf/draft-damaged' })
    assert.deepEqual(state.puts, [])
    assert.deepEqual(state.deletes, [])
  } finally { await workspaces.dispose() }
})
