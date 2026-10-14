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

async function changedSource(initial: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(initial)
  pdf.addPage([300, 400])
  return pdf.save({ useObjectStreams: false })
}

function note(id: string): NewPdfAnnotation {
  return { id, page: 1, subtype: 'Text', rect: [40, 40, 60, 60], contents: id }
}

function harness(initial: Uint8Array) {
  const file = {
    bytes: initial.slice(), version: hash(initial), fsVersion: 'fs-1',
    exists: true, failNextRead: false, failNextSave: false, failAfterWrite: false, saveAttempts: [] as Uint8Array[],
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
      if (file.failNextRead) {
        file.failNextRead = false
        throw Object.assign(new Error('The PDF was temporarily unreadable'), { code: 'PDF_STALE_VERSION' })
      }
      if (!file.exists) throw Object.assign(new Error('PDF file does not exist'), { code: 'PDF_NOT_FOUND' })
      return { path, bytes: file.bytes.slice(), version: file.version,
        fsVersion: file.fsVersion, size: file.bytes.byteLength }
    },
    async save(_agent, requested, bytes, expectedVersion) {
      assert.equal(requested, path)
      if (!file.exists || expectedVersion !== file.version) {
        throw Object.assign(new Error('The PDF was modified outside this editor'), { code: 'PDF_STALE_VERSION' })
      }
      file.saveAttempts.push(bytes.slice())
      if (file.failNextSave) {
        file.failNextSave = false
        throw new Error('planned save failure')
      }
      file.bytes = bytes.slice()
      file.version = hash(file.bytes)
      file.fsVersion = `fs-${file.saveAttempts.length + 1}`
      if (file.failAfterWrite) {
        file.failAfterWrite = false
        throw Object.assign(new Error('PDF was published, but final verification failed'), { code: 'PDF_SAVE_UNCERTAIN' })
      }
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
  const result = await workspaces.execute(sessionId, { sessionId, ...input }, agent, signal)
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
    assert.deepEqual(edited.bytes, bytes)
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
    assert.deepEqual(Buffer.from(recovered.bytes), Buffer.from(beforeRestart.bytes))
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
    assert.deepEqual(Buffer.from(recovered.bytes), Buffer.from(bytes))
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

test('discard adopts an externally changed source and clears the conflict and draft', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('discarded-note')))
    state.file.bytes = Uint8Array.from(await changedSource(bytes))
    state.file.version = hash(state.file.bytes)
    state.file.fsVersion = 'fs-external'
    const conflicted = await snapshot(workspaces, { action: 'open', address })
    assert.equal(conflicted.conflict, true)
    assert.equal(conflicted.dirty, true)

    const discarded = await snapshot(workspaces, { action: 'discard', id: edited.id, revision: edited.revision })
    assert.equal(discarded.conflict, false)
    assert.equal(discarded.dirty, false)
    assert.equal(discarded.canRedo, false)
    assert.equal(discarded.sourceVersion, 'fs-external')
    assert.equal(discarded.document.pageCount, 2)
    assert.equal(discarded.document.annotations.length, 0)
    assert.deepEqual(discarded.bytes, state.file.bytes)
    assert.equal(state.records.size, 0)
  } finally { await workspaces.dispose() }
})

test('discard preserves the draft when its source file is missing', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('retained-note')))
    state.file.exists = false
    await assert.rejects(snapshot(workspaces, { action: 'discard', id: edited.id, revision: edited.revision }),
      { code: 'PDF_NOT_FOUND' })
    const retained = await snapshot(workspaces, { action: 'open', address })
    assert.equal(retained.conflict, true)
    assert.equal(retained.dirty, true)
    assert.equal(retained.document.annotations[0]?.id, 'retained-note')
    assert.ok(state.records.size > 0)
  } finally { await workspaces.dispose() }
})

test('same-path Save As replaces an observed version only with explicit confirmation and CAS', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('kept-note')))
    state.file.bytes = Uint8Array.from(await changedSource(bytes))
    state.file.version = hash(state.file.bytes)
    state.file.fsVersion = 'fs-external'
    const observedVersion = state.file.version
    await assert.rejects(snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision, options: {},
    }), { code: 'PDF_STALE_VERSION' })
    await assert.rejects(snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision,
      options: { path, expectedTargetVersion: observedVersion },
    }), { code: 'PDF_STALE_VERSION' })
    await assert.rejects(snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision, options: { path, overwrite: true },
    }), { code: 'pdf/overwrite-required' })
    const changedAgain = await changedSource(state.file.bytes)
    state.file.bytes = Uint8Array.from(changedAgain)
    state.file.version = hash(changedAgain)
    state.file.fsVersion = 'fs-external-2'
    await assert.rejects(snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision,
      options: { path, overwrite: true, expectedTargetVersion: observedVersion },
    }), { code: 'PDF_STALE_VERSION' })
    const saved = await snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision,
      options: { path, overwrite: true, expectedTargetVersion: state.file.version },
    })
    assert.equal(saved.conflict, false)
    assert.equal(saved.dirty, false)
    assert.deepEqual((await loadPdfDocument(state.file.bytes)).annotations.map(item => item.id), ['kept-note'])
    assert.equal(state.records.size, 0)
  } finally { await workspaces.dispose() }
})

test('same-path Save As recovers a committed PDF after post-publication verification fails', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('committed-note')))
    state.file.failAfterWrite = true
    const saved = await snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision,
      options: { path, overwrite: true, expectedTargetVersion: state.file.version },
    })
    assert.equal(saved.dirty, false)
    assert.equal(saved.conflict, false)
    assert.notDeepEqual(state.file.bytes, bytes, 'the Save As write reached the source file')
    assert.equal(state.records.size, 0)

    // The same Host process still owns this working copy. Its normal reopen
    // must recognize the committed hash instead of reporting an external conflict.
    const reopened = await snapshot(workspaces, { action: 'open', address })
    assert.equal(reopened.id, edited.id)
    assert.equal(reopened.dirty, false)
    assert.equal(reopened.conflict, false)
    assert.equal(reopened.canUndo, false)
    assert.equal(reopened.sourceVersion, state.file.fsVersion)
    assert.deepEqual(reopened.bytes, state.file.bytes)
    assert.deepEqual(reopened.document.annotations.map(item => item.id), ['committed-note'])
    assert.equal(state.records.size, 0)
  } finally { await workspaces.dispose() }
})

test('same-process reopen recovers a committed PDF when immediate verification is unavailable', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('committed-later')))
    state.file.failAfterWrite = true
    state.file.failNextRead = true
    await assert.rejects(snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision,
      options: { path, overwrite: true, expectedTargetVersion: state.file.version },
    }), { code: 'PDF_SAVE_UNCERTAIN' })
    const draft = [...state.records.values()].find(record => record.groups.length > 0)
    assert.equal(draft?.renderedHash, state.file.version)
    assert.equal(workspaces.readSnapshot(sessionId, edited.id).dirty, true)

    // The transient read failure has passed. No Host restart or manual discard
    // should be required to recognize the already-published file.
    const reopened = await snapshot(workspaces, { action: 'open', address })
    assert.equal(reopened.id, edited.id)
    assert.equal(reopened.dirty, false)
    assert.equal(reopened.conflict, false)
    assert.equal(reopened.canUndo, false)
    assert.equal(reopened.sourceVersion, state.file.fsVersion)
    assert.deepEqual(reopened.bytes, state.file.bytes)
    assert.deepEqual(reopened.document.annotations.map(item => item.id), ['committed-later'])
    assert.equal(state.records.size, 0)
  } finally { await workspaces.dispose() }
})

test('background release preserves drafts and refuses to close a Client-owned copy', async () => {
  const state = harness(await fixture())
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const first = await snapshot(workspaces, { action: 'open', address, owner: 'agent' })
    assert.equal(workspaces.isUiOwned(sessionId, first.id), false)
    const edited = await snapshot(workspaces, edit(first.id, first.revision, note('background-draft')))
    assert.equal(await workspaces.releaseBackground(sessionId, first.id), 'released')
    assert.throws(() => workspaces.readSnapshot(sessionId, first.id), { code: 'pdf/unknown-document' })
    assert.ok(state.records.size > 0, 'releasing memory must not delete the saved draft')
    const reopened = await snapshot(workspaces, { action: 'open', address, owner: 'agent' })
    assert.notEqual(reopened.id, first.id)
    assert.equal(reopened.dirty, true)
    assert.equal(reopened.document.annotations.find(item => item.id === 'background-draft')?.contents, 'background-draft')
    const ui = await snapshot(workspaces, { action: 'open', address })
    assert.equal(ui.id, reopened.id)
    assert.equal(workspaces.isUiOwned(sessionId, ui.id), true)
    assert.equal(await workspaces.releaseBackground(sessionId, ui.id), 'retained-ui')
    assert.equal(workspaces.readSnapshot(sessionId, ui.id).revision, edited.revision)
    await assert.rejects(workspaces.releaseBackground('other-session', ui.id), { code: 'pdf/session-mismatch' })
  } finally { await workspaces.dispose() }
})
