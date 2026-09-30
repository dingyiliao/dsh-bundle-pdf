import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { loadPdfDocument } from '../src/core/pdf-document.ts'
import type { NewPdfAnnotation } from '../src/core/pdf-types.ts'
import type { PdfAgent } from '../src/host/transport.ts'
import type { DraftRecord } from '../src/host/validation.ts'
import { createWorkspaces } from '../src/host/workspaces.ts'

const sessionId = 'workspace-test-session'
const path = 'D:/fixtures/workspace.pdf'
const address = `dsh-resource://file/session/${sessionId}/D%3A/fixtures/workspace.pdf`
const agent: PdfAgent = { session: { id: sessionId, header: { cwd: 'D:/fixtures' } } }
const signal = new AbortController().signal

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function fixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400])
  return pdf.save({ useObjectStreams: false })
}

function note(id: string): NewPdfAnnotation {
  return { id, page: 1, subtype: 'Text', rect: [40, 40, 60, 60], contents: id }
}

function harness(initial: Uint8Array) {
  const file = {
    bytes: initial.slice(), version: hash(initial), fsVersion: 'fs-1',
    failNextSave: false, saveAttempts: [] as Uint8Array[],
  }
  const records = new Map<string, DraftRecord>()
  const puts: { key: string; value: DraftRecord }[] = []
  const files: Parameters<typeof createWorkspaces>[0] = {
    async resolvePath(_agent, requested) {
      assert.equal(requested, path)
      return path
    },
    async read(_agent, requested) {
      assert.equal(requested, path)
      return { path, bytes: file.bytes.slice(), version: file.version,
        fsVersion: file.fsVersion, size: file.bytes.byteLength }
    },
    async save(_agent, requested, bytes, expectedVersion) {
      assert.equal(requested, path)
      assert.equal(expectedVersion, file.version)
      file.saveAttempts.push(bytes.slice())
      if (file.failNextSave) {
        file.failNextSave = false
        throw new Error('planned save failure')
      }
      file.bytes = bytes.slice()
      file.version = hash(file.bytes)
      file.fsVersion = `fs-${file.saveAttempts.length + 1}`
      return { path, version: file.version, fsVersion: file.fsVersion, size: file.bytes.byteLength }
    },
  }
  const drafts: Parameters<typeof createWorkspaces>[1] = {
    get: key => records.get(key),
    async put(key, value) {
      assert.match(key, /^[a-zA-Z0-9_-]+$/, 'storage-json draft keys must be path-safe')
      const saved = structuredClone(value)
      records.set(key, saved)
      puts.push({ key, value: saved })
    },
    async delete(key) { records.delete(key) },
  }
  return { file, records, puts, files, drafts }
}

async function snapshot(workspaces: ReturnType<typeof createWorkspaces>, input: Record<string, unknown>) {
  const result = await workspaces.dispatch(sessionId, { sessionId, ...input }, agent, signal)
  if (!('document' in result)) throw new Error('Expected a PDF workspace snapshot')
  return result
}

function edit(id: string, revision: number, annotation: NewPdfAnnotation) {
  return { action: 'change', id, revision, operations: [{ type: 'add', annotation }] }
}

test('edits and redo publish new annotation metadata while retaining the source bytes', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('first')))
    assert.equal(edited.bytes, opened.bytes)
    assert.equal(edited.bytes, Buffer.from(bytes).toString('base64'))
    assert.equal(edited.document.annotations.find(item => item.id === 'first')?.contents, 'first')
    assert.equal(edited.baselineAnnotations?.length, 0)
    assert.equal(edited.dirty, true)
    const undone = await snapshot(workspaces, { action: 'undo', id: edited.id, revision: edited.revision })
    assert.equal(undone.bytes, opened.bytes)
    assert.equal(undone.document.annotations.length, 0)
    assert.equal(undone.canRedo, true)
    const redone = await snapshot(workspaces, { action: 'redo', id: undone.id, revision: undone.revision })
    assert.equal(redone.bytes, opened.bytes)
    assert.equal(redone.document.annotations.find(item => item.id === 'first')?.contents, 'first')
    assert.deepEqual(state.file.bytes, bytes)
  } finally { await workspaces.dispose() }
})

test('the draft writes its PDF baseline once and later edits rewrite only the operation record', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const first = await snapshot(workspaces, edit(opened.id, opened.revision, note('first')))
    await snapshot(workspaces, edit(first.id, first.revision, note('second')))
    const baselineWrites = state.puts.filter(({ value }) => value.original !== undefined)
    assert.equal(baselineWrites.length, 1)
    assert.equal(baselineWrites[0].value.original, Buffer.from(bytes).toString('base64'))
    assert.equal(baselineWrites[0].value.groups.length, 0)
    const active = [...state.records.values()].find(record => record.groups.length === 2)
    assert.ok(active)
    assert.equal(active.original, undefined)
    assert.equal(active.baseKey, baselineWrites[0].key)
    assert.equal(active.groupDates?.length, 2)
    assert.equal(state.records.size, 2)
  } finally { await workspaces.dispose() }
})

test('a restarted workspace restores the draft and its undo and redo branch', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const firstWorkspaces = createWorkspaces(state.files, state.drafts)
  let beforeRestart
  try {
    const opened = await snapshot(firstWorkspaces, { action: 'open', address })
    const first = await snapshot(firstWorkspaces, edit(opened.id, opened.revision, note('first')))
    const second = await snapshot(firstWorkspaces, edit(first.id, first.revision, note('second')))
    beforeRestart = await snapshot(firstWorkspaces, { action: 'undo', id: second.id, revision: second.revision })
  } finally { await firstWorkspaces.dispose() }
  const recoveredWorkspaces = createWorkspaces(state.files, state.drafts)
  try {
    const recovered = await snapshot(recoveredWorkspaces, { action: 'open', address })
    assert.equal(recovered.bytes, beforeRestart.bytes)
    assert.deepEqual(recovered.document.annotations.map(item => item.id), ['first'])
    assert.equal(recovered.canUndo, true)
    assert.equal(recovered.canRedo, true)
    const undone = await snapshot(recoveredWorkspaces, { action: 'undo', id: recovered.id, revision: recovered.revision })
    assert.equal(undone.document.annotations.length, 0)
    const redone = await snapshot(recoveredWorkspaces, { action: 'redo', id: undone.id, revision: undone.revision })
    assert.deepEqual(redone.document.annotations.map(item => item.id), ['first'])
    const restored = await snapshot(recoveredWorkspaces, { action: 'redo', id: redone.id, revision: redone.revision })
    assert.deepEqual(restored.document.annotations.map(item => item.id), ['first', 'second'])
    assert.deepEqual(state.file.bytes, bytes)
  } finally { await recoveredWorkspaces.dispose() }
})

test('save materializes valid PDF bytes and a failed write retains the draft', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('saved-note')))
    state.file.failNextSave = true
    await assert.rejects(snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision, options: {},
    }), /planned save failure/)
    assert.deepEqual(state.file.bytes, bytes)
    assert.equal(state.records.size, 2)
    assert.ok([...state.records.values()].some(record => record.groups.length === 1 && record.original === undefined))
    assert.deepEqual((await loadPdfDocument(state.file.saveAttempts[0])).annotations.map(item => item.id), ['saved-note'])
  } finally { await workspaces.dispose() }
  const recoveredWorkspaces = createWorkspaces(state.files, state.drafts)
  try {
    const recovered = await snapshot(recoveredWorkspaces, { action: 'open', address })
    assert.equal(recovered.dirty, true)
    assert.equal(recovered.document.annotations[0].id, 'saved-note')
    assert.equal(recovered.bytes, Buffer.from(bytes).toString('base64'))
    const saved = await snapshot(recoveredWorkspaces, {
      action: 'save', id: recovered.id, revision: recovered.revision, options: {},
    })
    assert.equal(saved.dirty, false)
    assert.equal(saved.document.annotations[0].id, 'saved-note')
    assert.equal(saved.baselineAnnotations?.[0].id, 'saved-note')
    assert.notDeepEqual(state.file.bytes, bytes)
    assert.deepEqual((await loadPdfDocument(state.file.bytes)).annotations.map(item => item.id), ['saved-note'])
    assert.equal(state.records.size, 0)
  } finally { await recoveredWorkspaces.dispose() }
})
