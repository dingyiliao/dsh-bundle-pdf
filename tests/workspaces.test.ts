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

function harness(initial: Uint8Array, filePath = path) {
  const file = {
    bytes: initial.slice(), version: hash(initial), fsVersion: 'fs-1',
    exists: true, failNextRead: false, failNextSave: false, failAfterWrite: false, saveAttempts: [] as Uint8Array[],
  }
  const records = new Map<string, DraftRecord>()
  const puts: { key: string; value: DraftRecord }[] = []
  const files: Parameters<typeof createWorkspaces>[0] = {
    async resolvePath(_agent, requested) {
      assert.equal(requested, filePath)
      return filePath
    },
    async read(_agent, requested) {
      assert.equal(requested, filePath)
      if (file.failNextRead) {
        file.failNextRead = false
        throw Object.assign(new Error('The PDF was temporarily unreadable'), { code: 'PDF_STALE_VERSION' })
      }
      if (!file.exists) throw Object.assign(new Error('PDF file does not exist'), { code: 'PDF_NOT_FOUND' })
      return { path: filePath, bytes: file.bytes.slice(), version: file.version,
        fsVersion: file.fsVersion, size: file.bytes.byteLength }
    },
    async save(_agent, requested, bytes, expectedVersion) {
      assert.equal(requested, filePath)
      if (file.exists ? expectedVersion !== file.version : expectedVersion !== null) {
        throw Object.assign(new Error('The PDF was modified outside this editor'), { code: 'PDF_STALE_VERSION' })
      }
      file.saveAttempts.push(bytes.slice())
      if (file.failNextSave) {
        file.failNextSave = false
        throw new Error('planned save failure')
      }
      file.bytes = bytes.slice()
      file.exists = true
      file.version = hash(file.bytes)
      file.fsVersion = `fs-${file.saveAttempts.length + 1}`
      if (file.failAfterWrite) {
        file.failAfterWrite = false
        throw Object.assign(new Error('PDF was published, but final verification failed'), { code: 'PDF_SAVE_UNCERTAIN' })
      }
      return { path: filePath, version: file.version, fsVersion: file.fsVersion, size: file.bytes.byteLength }
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

test('a missing draft baseline is rebuilt only from the identical source PDF', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const firstWorkspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(firstWorkspaces, { action: 'open', address })
    await snapshot(firstWorkspaces, edit(opened.id, opened.revision, note('recovered-note')))
  } finally { await firstWorkspaces.dispose() }

  const [draftKey, draft] = [...state.records].find(([, record]) => record.groups.length === 1) ?? []
  assert.ok(draftKey && draft?.baseKey)
  state.records.delete(draft.baseKey)
  assert.equal(state.records.size, 1, 'the operation record must survive loss of its baseline')

  const recoveredWorkspaces = createWorkspaces(state.files, state.drafts)
  try {
    const recovered = await snapshot(recoveredWorkspaces, { action: 'open', address })
    assert.equal(recovered.dirty, true)
    assert.equal(recovered.conflict, false)
    assert.deepEqual(recovered.bytes, bytes)
    assert.deepEqual(recovered.document.annotations.map(item => item.id), ['recovered-note'])
    assert.equal(state.records.get(draftKey)?.baseKey, draft.baseKey)
    assert.equal(state.records.get(draft.baseKey)?.original, Buffer.from(bytes).toString('base64'))
  } finally { await recoveredWorkspaces.dispose() }
})

test('a missing baseline is never rebuilt from a modified or deleted source', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const firstWorkspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(firstWorkspaces, { action: 'open', address })
    await snapshot(firstWorkspaces, edit(opened.id, opened.revision, note('retained-note')))
  } finally { await firstWorkspaces.dispose() }

  const [draftKey, draft] = [...state.records].find(([, record]) => record.groups.length === 1) ?? []
  assert.ok(draftKey && draft?.baseKey)
  state.records.delete(draft.baseKey)
  const operationRecord = structuredClone(state.records.get(draftKey))

  state.file.bytes = Uint8Array.from(await changedSource(bytes))
  state.file.version = hash(state.file.bytes)
  state.file.fsVersion = 'fs-external'
  const modifiedWorkspaces = createWorkspaces(state.files, state.drafts)
  try {
    await assert.rejects(snapshot(modifiedWorkspaces, { action: 'open', address }), { code: 'pdf/draft-damaged' })
    assert.deepEqual(state.records.get(draftKey), operationRecord)
    assert.equal(state.records.has(draft.baseKey), false)
  } finally { await modifiedWorkspaces.dispose() }

  state.file.exists = false
  const deletedWorkspaces = createWorkspaces(state.files, state.drafts)
  try {
    await assert.rejects(snapshot(deletedWorkspaces, { action: 'open', address }), { code: 'pdf/draft-damaged' })
    assert.deepEqual(state.records.get(draftKey), operationRecord)
    assert.equal(state.records.has(draft.baseKey), false)
  } finally { await deletedWorkspaces.dispose() }
})

test('failed operation-record cleanup retains the baseline after a successful save', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('saved-note')))
    const [draftKey, draft] = [...state.records].find(([, record]) => record.groups.length === 1) ?? []
    assert.ok(draftKey && draft?.baseKey)
    const deleteRecord = state.drafts.delete.bind(state.drafts)
    state.drafts.delete = async key => {
      if (key === draftKey) throw new Error('planned operation-record cleanup failure')
      return deleteRecord(key)
    }
    const saved = await snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision, options: {},
    })
    assert.equal(saved.dirty, false)
    assert.match(saved.warning ?? '', /planned operation-record cleanup failure/)
    assert.ok(state.records.has(draftKey), 'the failed operation-record delete remains retryable')
    assert.ok(state.records.has(draft.baseKey), 'a live operation record must not lose its baseline')
    state.drafts.delete = deleteRecord
  } finally { await workspaces.dispose() }

  const recoveredWorkspaces = createWorkspaces(state.files, state.drafts)
  try {
    const reopened = await snapshot(recoveredWorkspaces, { action: 'open', address })
    assert.equal(reopened.dirty, false)
    assert.equal(reopened.conflict, false)
    assert.deepEqual(reopened.document.annotations.map(item => item.id), ['saved-note'])
    assert.equal(state.records.size, 0)
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

test('explicit Save As can recreate a deleted source without allowing plain Save to do so', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('restored-note')))
    state.file.exists = false
    await assert.rejects(snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision, options: {},
    }), { code: 'PDF_STALE_VERSION' })
    const saved = await snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision,
      options: { path, expectedTargetVersion: null, overwrite: false },
    })
    assert.equal(saved.dirty, false)
    assert.equal(state.file.exists, true)
    assert.deepEqual((await loadPdfDocument(state.file.bytes)).annotations.map(item => item.id), ['restored-note'])
    assert.equal(state.records.size, 0)
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

test('committed-save recovery retains the baseline if operation-record cleanup fails', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('committed-note')))
    const [draftKey, draft] = [...state.records].find(([, record]) => record.groups.length === 1) ?? []
    assert.ok(draftKey && draft?.baseKey)

    state.file.failAfterWrite = true
    state.file.failNextRead = true
    await assert.rejects(snapshot(workspaces, {
      action: 'save', id: edited.id, revision: edited.revision, options: {},
    }), { code: 'PDF_SAVE_UNCERTAIN' })
    assert.equal(state.records.get(draftKey)?.renderedHash, state.file.version)

    const deleteRecord = state.drafts.delete.bind(state.drafts)
    let failOnce = true
    state.drafts.delete = async key => {
      if (key === draftKey && failOnce) {
        failOnce = false
        throw new Error('planned recovery cleanup failure')
      }
      return deleteRecord(key)
    }
    const recovered = await snapshot(workspaces, { action: 'open', address })
    assert.equal(recovered.dirty, false)
    assert.equal(recovered.conflict, false)
    assert.match(recovered.warning ?? '', /planned recovery cleanup failure/)
    assert.ok(state.records.has(draftKey), 'the failed operation-record delete remains retryable')
    assert.ok(state.records.has(draft.baseKey), 'a live operation record must not lose its baseline')
  } finally { await workspaces.dispose() }

  const restartedWorkspaces = createWorkspaces(state.files, state.drafts)
  try {
    const reopened = await snapshot(restartedWorkspaces, { action: 'open', address })
    assert.equal(reopened.dirty, false)
    assert.equal(reopened.conflict, false)
    assert.deepEqual(reopened.document.annotations.map(item => item.id), ['committed-note'])
    assert.equal(state.records.size, 0)
  } finally { await restartedWorkspaces.dispose() }
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

test('discardAddresses removes the live copy and its durable draft by absolute PDF address', async () => {
  const absolutePath = '/tmp/workspace-discard.pdf'
  const absoluteAddress = `dsh-resource://file/session/${sessionId}/${encodeURIComponent(absolutePath)}`
  const state = harness(await fixture(), absolutePath)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address: absoluteAddress })
    await snapshot(workspaces, edit(opened.id, opened.revision, note('discard-address')))
    assert.equal(state.records.size, 2, 'the operation record and its baseline are durable')

    const discarded = await workspaces.execute(sessionId, {
      sessionId, action: 'discardAddresses', addresses: [absoluteAddress, absoluteAddress],
    }, agent, signal)
    assert.deepEqual(discarded, { discarded: [opened.id] })
    assert.equal(state.records.size, 0)
    assert.throws(() => workspaces.readSnapshot(sessionId, opened.id), { code: 'pdf/unknown-document' })

    const reopened = await snapshot(workspaces, { action: 'open', address: absoluteAddress })
    assert.notEqual(reopened.id, opened.id)
    assert.equal(reopened.dirty, false)
    assert.equal(reopened.document.annotations.length, 0)
    assert.deepEqual(await workspaces.execute(sessionId, {
      sessionId, action: 'discardAddresses', addresses: [absoluteAddress],
    }, agent, signal), { discarded: [reopened.id] })
  } finally { await workspaces.dispose() }
})

test('discardAddresses validates all addresses before deleting a valid draft', async () => {
  const absolutePath = '/tmp/workspace-discard-validation.pdf'
  const absoluteAddress = `dsh-resource://file/session/${sessionId}/${encodeURIComponent(absolutePath)}`
  const otherSessionAddress = `dsh-resource://file/session/other-session/${encodeURIComponent(absolutePath)}`
  const nonPdfAddress = `dsh-resource://file/session/${sessionId}/${encodeURIComponent('/tmp/note.txt')}`
  const state = harness(await fixture(), absolutePath)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address: absoluteAddress })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('keep-draft')))
    for (const [invalidAddress, expectedCode] of [
      [otherSessionAddress, 'pdf/session-mismatch'],
      [nonPdfAddress, 'pdf/invalid-address'],
      [address, 'pdf/invalid-address'],
    ] as const) {
      await assert.rejects(workspaces.execute(sessionId, {
        sessionId, action: 'discardAddresses', addresses: [absoluteAddress, invalidAddress],
      }, agent, signal), { code: expectedCode })
      assert.equal(workspaces.readSnapshot(sessionId, edited.id).dirty, true)
      assert.equal(state.records.size, 2)
    }
  } finally { await workspaces.dispose() }
})

test('discardMany reports failed cleanup and permits an idempotent retry', async () => {
  const state = harness(await fixture())
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    await snapshot(workspaces, edit(opened.id, opened.revision, note('retry-discard')))
    const originalDelete = state.drafts.delete.bind(state.drafts)
    state.drafts.delete = async () => { throw new Error('planned draft cleanup failure') }
    await assert.rejects(workspaces.execute(sessionId, {
      sessionId, action: 'discardMany', ids: [opened.id, 'already-closed'],
    }, agent, signal), { code: 'pdf/discard-failed' })
    assert.equal(workspaces.readSnapshot(sessionId, opened.id).dirty, true)
    assert.equal(state.records.size, 2)

    state.drafts.delete = originalDelete
    assert.deepEqual(await workspaces.execute(sessionId, {
      sessionId, action: 'discardMany', ids: [opened.id, 'already-closed'],
    }, agent, signal), { discarded: [opened.id, 'already-closed'] })
    assert.equal(state.records.size, 0)
    assert.deepEqual(await workspaces.execute(sessionId, {
      sessionId, action: 'discardMany', ids: ['already-closed'],
    }, agent, signal), { discarded: ['already-closed'] })
  } finally { await workspaces.dispose() }
})

test('inspectTarget distinguishes an existing PDF from a missing destination', async () => {
  const state = harness(await fixture())
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    assert.deepEqual(await workspaces.execute(sessionId, {
      sessionId, action: 'inspectTarget', path,
    }, agent, signal), { version: state.file.version })
    state.file.exists = false
    assert.deepEqual(await workspaces.execute(sessionId, {
      sessionId, action: 'inspectTarget', path,
    }, agent, signal), { version: null })
  } finally { await workspaces.dispose() }
})

test('reopening rejects an operation record whose baseline belongs to another source', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const first = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(first, { action: 'open', address })
    await snapshot(first, edit(opened.id, opened.revision, note('must-not-rebase')))
  } finally { await first.dispose() }
  const draft = [...state.records.values()].find(record => record.groups.length === 1)
  assert.ok(draft?.baseKey)
  const baseline = state.records.get(draft.baseKey)
  assert.ok(baseline)
  state.records.set(draft.baseKey, { ...baseline, sourceHash: hash(await changedSource(bytes)) })
  const reopened = createWorkspaces(state.files, state.drafts)
  try {
    await assert.rejects(snapshot(reopened, { action: 'open', address }), { code: 'pdf/draft-damaged' })
  } finally { await reopened.dispose() }
})

test('reopening rejects corrupted baseline bytes instead of applying the draft', async () => {
  const state = harness(await fixture())
  const first = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(first, { action: 'open', address })
    await snapshot(first, edit(opened.id, opened.revision, note('must-not-apply')))
  } finally { await first.dispose() }
  const draft = [...state.records.values()].find(record => record.groups.length === 1)
  assert.ok(draft?.baseKey)
  const baseline = state.records.get(draft.baseKey)
  assert.ok(baseline)
  state.records.set(draft.baseKey, { ...baseline, original: Buffer.from('not the original PDF').toString('base64') })
  const reopened = createWorkspaces(state.files, state.drafts)
  try {
    await assert.rejects(snapshot(reopened, { action: 'open', address }), { code: 'pdf/draft-damaged' })
  } finally { await reopened.dispose() }
})

test('a draft stored under the wrong file key cannot be opened', async () => {
  const state = harness(await fixture())
  const first = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(first, { action: 'open', address })
    await snapshot(first, edit(opened.id, opened.revision, note('wrong-key')))
  } finally { await first.dispose() }
  const [key, draft] = [...state.records].find(([, record]) => record.groups.length === 1) ?? []
  assert.ok(key && draft)
  state.records.set(key, { ...draft, path: '/elsewhere.pdf' })
  const reopened = createWorkspaces(state.files, state.drafts)
  try {
    await assert.rejects(snapshot(reopened, { action: 'open', address }), { code: 'pdf/draft-mismatch' })
  } finally { await reopened.dispose() }
})

test('reopening an inline-byte legacy draft migrates it without losing the edit', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const first = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(first, { action: 'open', address })
    await snapshot(first, edit(opened.id, opened.revision, note('legacy-note')))
  } finally { await first.dispose() }
  const [key, draft] = [...state.records].find(([, record]) => record.groups.length === 1) ?? []
  assert.ok(key && draft?.baseKey)
  state.records.delete(draft.baseKey)
  state.records.set(key, { ...draft, baseKey: undefined, original: Buffer.from(bytes).toString('base64'), groupDates: undefined })

  const reopened = createWorkspaces(state.files, state.drafts)
  try {
    const recovered = await snapshot(reopened, { action: 'open', address })
    assert.equal(recovered.dirty, true)
    assert.deepEqual(recovered.document.annotations.map(item => item.id), ['legacy-note'])
    const migrated = state.records.get(key)
    assert.ok(migrated?.baseKey)
    assert.equal(migrated.original, undefined)
    assert.equal(migrated.groupDates?.length, 1)
    assert.equal(state.records.get(migrated.baseKey)?.original, Buffer.from(bytes).toString('base64'))
  } finally { await reopened.dispose() }
})

test('reopening an active clean copy observes touches and replaces a changed source', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    state.file.fsVersion = 'fs-touch'
    const touched = await snapshot(workspaces, { action: 'open', address })
    assert.equal(touched.id, opened.id)
    assert.equal(touched.sourceVersion, 'fs-touch')
    assert.equal(touched.revision, opened.revision)

    state.file.bytes = Uint8Array.from(await changedSource(bytes))
    state.file.version = hash(state.file.bytes)
    state.file.fsVersion = 'fs-replacement'
    const replaced = await snapshot(workspaces, { action: 'open', address })
    assert.equal(replaced.id, opened.id)
    assert.equal(replaced.sourceVersion, 'fs-replacement')
    assert.equal(replaced.document.pages.length, 2)
    assert.equal(replaced.conflict, false)
    assert.equal(replaced.dirty, false)
    assert.equal(replaced.revision, opened.revision + 1)
  } finally { await workspaces.dispose() }
})

test('a persisted draft adopts a byte-identical source with a newer filesystem version', async () => {
  const state = harness(await fixture())
  const first = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(first, { action: 'open', address })
    await snapshot(first, edit(opened.id, opened.revision, note('saved-draft')))
  } finally { await first.dispose() }
  state.file.fsVersion = 'fs-touched-after-draft'
  const second = createWorkspaces(state.files, state.drafts)
  try {
    const restored = await snapshot(second, { action: 'open', address })
    assert.equal(restored.sourceVersion, 'fs-touched-after-draft')
    assert.equal(restored.dirty, true)
    assert.deepEqual(restored.document.annotations.map(item => item.id), ['saved-draft'])
  } finally { await second.dispose() }
})

test('discard, clean save and reload use the latest source without retaining stale edits', async () => {
  const bytes = await fixture()
  const state = harness(bytes)
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(workspaces, { action: 'open', address })
    const edited = await snapshot(workspaces, edit(opened.id, opened.revision, note('discard-me')))
    const discarded = await snapshot(workspaces, { action: 'discard', id: edited.id, revision: edited.revision })
    assert.equal(discarded.dirty, false)
    assert.equal(discarded.document.annotations.length, 0)
    assert.equal(state.records.size, 0)

    const saved = await snapshot(workspaces, { action: 'save', id: discarded.id, revision: discarded.revision, options: {} })
    assert.equal(saved.dirty, false)
    assert.deepEqual(saved.bytes, bytes)

    state.file.bytes = Uint8Array.from(await changedSource(bytes))
    state.file.version = hash(state.file.bytes)
    state.file.fsVersion = 'fs-reloaded'
    const reloaded = await snapshot(workspaces, { action: 'reload', id: saved.id, revision: saved.revision })
    assert.equal(reloaded.sourceVersion, 'fs-reloaded')
    assert.equal(reloaded.document.pages.length, 2)
    assert.equal(reloaded.conflict, false)
  } finally { await workspaces.dispose() }
})

test('inspectTarget propagates non-missing file errors', async () => {
  const state = harness(await fixture())
  const workspaces = createWorkspaces(state.files, state.drafts)
  try {
    state.file.failNextRead = true
    await assert.rejects(workspaces.execute(sessionId, {
      sessionId, action: 'inspectTarget', path,
    }, agent, signal), { code: 'PDF_STALE_VERSION' })
  } finally { await workspaces.dispose() }
})

test('a clean leftover draft opens as saved when storage cleanup temporarily fails', async () => {
  const state = harness(await fixture())
  const first = createWorkspaces(state.files, state.drafts)
  try {
    const opened = await snapshot(first, { action: 'open', address })
    await snapshot(first, edit(opened.id, opened.revision, note('leftover-draft')))
  } finally { await first.dispose() }
  const [key, draft] = [...state.records].find(([, record]) => record.groups.length === 1) ?? []
  assert.ok(key && draft?.baseKey)
  state.records.set(key, { ...draft, groups: [], groupDates: [], cursor: 0 })
  const originalDelete = state.drafts.delete.bind(state.drafts)
  let failOnce = true
  state.drafts.delete = async target => {
    if (target === key && failOnce) {
      failOnce = false
      throw new Error('storage cleanup temporarily unavailable')
    }
    return originalDelete(target)
  }

  const restarted = createWorkspaces(state.files, state.drafts)
  try {
    const recovered = await snapshot(restarted, { action: 'open', address })
    assert.equal(recovered.dirty, false)
    assert.equal(recovered.conflict, false)
    assert.match(recovered.warning ?? '', /storage cleanup temporarily unavailable/)
    assert.equal(recovered.document.annotations.length, 0)
    assert.ok(state.records.has(key), 'failed cleanup leaves the record retryable')
  } finally { await restarted.dispose() }
})
