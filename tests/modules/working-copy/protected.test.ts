import assert from 'node:assert/strict'
import test from 'node:test'
import { createV1DraftRepository } from '../../../src/adapters/host/storage/v1-drafts.ts'
import type { PdfDocumentInfo, PdfWorkingCopyOperation } from '../../../src/core/pdf-types.ts'
import { PdfDocumentError } from '../../../src/core/pdf-types.ts'
import { digestPdfBytes } from '../../../src/modules/document/index.ts'
import { createWorkingCopyService, type HostWorkspaceSnapshot, type ProtectedReaderPort,
  type WorkingCopyFilePort } from '../../../src/modules/working-copy/index.ts'

const sessionId = 'protected-working-copy-test'
const agent = { session: { id: sessionId, header: { cwd: '/' } } }
const signal = new AbortController().signal
const sourcePath = '/protected.pdf'
const savedPath = '/annotated.pdf'
const address = `dsh-resource://file/session/${sessionId}/%2Fprotected.pdf`
const sourceBytes = Uint8Array.of(1, 2)
const materializedBytes = Uint8Array.of(3, 4)
const note = { type: 'add', annotation: { id: 'note-1', page: 1, subtype: 'Text', rect: [10, 20, 30, 40],
  contents: 'private annotation' } } satisfies PdfWorkingCopyOperation

function failure(code: string) { return Object.assign(new Error(code), { code }) }

function setup(options: { ownerRequired?: boolean; signed?: boolean; writer?: boolean } = {}) {
  const disk = new Map<string, Uint8Array>([[sourcePath, sourceBytes]])
  const writes: Array<{ path: string; expected: string | null }> = []
  const passwords: Array<string | undefined> = []
  const released: string[] = []
  const behavior = { sourceChangeOnUnlock: false, uncertain: false, publishBeforeUncertain: true, preserveEncryption: true }
  const read = (path: string, bytes: Uint8Array) => ({ path, bytes, version: digestPdfBytes(bytes),
    fsVersion: `fs-${bytes.join('-')}`, size: bytes.length })
  const files: WorkingCopyFilePort = {
    async resolvePath(_agent, path) { return path },
    async read(_agent, path) {
      const bytes = disk.get(path)
      if (!bytes) throw failure('PDF_NOT_FOUND')
      return read(path, bytes)
    },
    async save(_agent, path, bytes, expected) {
      const previous = disk.get(path)
      assert.equal(expected, previous ? digestPdfBytes(previous) : null, 'publication receives the exact target CAS')
      writes.push({ path, expected })
      if (behavior.publishBeforeUncertain) disk.set(path, bytes)
      if (behavior.uncertain) throw failure('PDF_SAVE_UNCERTAIN')
      return read(path, bytes)
    },
  }
  const drafts = createV1DraftRepository({
    get: () => undefined,
    async put() { assert.fail('Encrypted edits must never enter disk draft storage') },
    async delete() { assert.fail('Protected transactions must not remove any on-disk draft') },
  })
  const inspector: ProtectedReaderPort = {
    async inspect(_bytes, password) {
      passwords.push(password)
      if (password === 'wrong-password') throw failure('pdf/password-incorrect')
      if (behavior.sourceChangeOnUnlock && password === 'owner-password') disk.set(sourcePath, Uint8Array.of(9))
      const allowed = !options.signed && (!options.ownerRequired || password === 'owner-password')
      const document: PdfDocumentInfo = {
        encrypted: true, signed: options.signed ?? false, readOnly: !allowed,
        ...(allowed ? {} : { readOnlyReason: 'encrypted-document' }),
        annotationEditing: options.signed ? undefined : allowed ? 'allowed' : 'owner-password-required',
        pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }],
        annotations: options.writer === false ? [
          { id: 'native-note', page: 1, subtype: 'Text', flags: 4, supported: true, editable: true },
          { id: 'native-locked', page: 1, subtype: 'Text', flags: 64, supported: true, editable: false },
        ] : [], allowTextExtraction: allowed,
      }
      return document
    },
    release: id => released.push(id),
  }
  let saveCredential: string | undefined
  if (options.writer !== false) inspector.materializeAnnotations = async (snapshot, baseline, password) => {
    assert.equal(snapshot.bytes, sourceBytes, 'projection preserves the exact encrypted baseline bytes')
    assert.equal(baseline.annotations.length, 0)
    assert.ok(snapshot.document.annotations.some(annotation => annotation.id === note.annotation.id))
    saveCredential = password
    return { bytes: materializedBytes, document: { ...snapshot.document, encrypted: behavior.preserveEncryption } }
  }
  const service = createWorkingCopyService(files, drafts, {
    async inspect() { throw new PdfDocumentError('encrypted', 'Encrypted test file') },
    async materialize() { assert.fail('Plaintext PDF writer cannot be used') },
  }, inspector)
  const reader = (input: Record<string, unknown>, origin: 'reader' | 'agent' = 'reader') =>
    service.execute(sessionId, { sessionId, ...input }, agent, signal, origin)
  const snapshot = async (input: Record<string, unknown>) => {
    const value = await reader(input)
    assert.ok('bytes' in value)
    return value
  }
  const open = (referenceId = 'tab-a') => snapshot({ action: 'open', address, referenceId })
  const operation = (document: HostWorkspaceSnapshot, action: string, fields: Record<string, unknown> = {}) =>
    ({ action, id: document.id, revision: document.revision, ...fields })
  const edit = (document: HostWorkspaceSnapshot, ...operations: PdfWorkingCopyOperation[]) =>
    snapshot(operation(document, 'change', { operations }))
  const save = (document: HostWorkspaceSnapshot, path = savedPath, options = {}) =>
    snapshot(operation(document, 'save', { options: { path, ...options } }))
  return { service, reader, snapshot, open, operation, edit, save, disk, writes, passwords, released, behavior,
    saveCredential: () => saveCredential }
}

test('an encrypted PDF with effective permission keeps undo, redo and edits in memory and saves only an encrypted copy', async () => {
  const f = setup()
  try {
    const opened = await f.open()
    assert.equal(opened.document.annotationEditing, 'allowed')
    assert.deepEqual(f.passwords, [undefined])
    assert.deepEqual(f.service.listOpenDocuments(), [])
    assert.equal(await f.service.suspend(sessionId, opened.id), 'retained-ui')
    const edited = await f.edit(opened, note)
    const updated = await f.edit(edited, { type: 'update', id: note.annotation.id, patch: { contents: 'updated' } })
    const deleted = await f.edit(updated, { type: 'delete', id: note.annotation.id })
    assert.deepEqual(deleted.document.annotations, [])
    const undone = await f.snapshot(f.operation(deleted, 'undo'))
    assert.equal(undone.document.annotations[0]?.contents, 'updated')
    const redone = await f.snapshot(f.operation(undone, 'redo'))
    assert.deepEqual(redone.document.annotations, [])
    const final = await f.snapshot(f.operation(redone, 'undo'))
    assert.equal(final.bytes, opened.bytes)
    assert.equal(f.disk.get(sourcePath), sourceBytes)
    assert.deepEqual(f.writes, [])
    await assert.rejects(f.reader(f.operation(final, 'save', { options: {} })), { code: 'pdf/protected-save-as-required' })
    await assert.rejects(f.save(final, sourcePath), { code: 'pdf/protected-save-as-required' })

    f.behavior.preserveEncryption = false
    await assert.rejects(f.save(final), { code: 'pdf/protected-save-invalid' })
    assert.deepEqual(f.writes, [])
    assert.equal(f.service.readSnapshot(sessionId, opened.id).dirty, true)
    f.behavior.preserveEncryption = true
    const saved = await f.save(final)
    assert.equal(saved.id, opened.id)
    assert.equal(saved.contentVersion, opened.contentVersion)
    assert.equal(saved.path, savedPath)
    assert.equal(saved.document.annotations[0]?.contents, 'updated')
    assert.equal(saved.dirty, false)
    assert.equal(saved.canUndo, false)
    assert.equal(saved.canRedo, false)
    assert.deepEqual(f.writes, [{ path: savedPath, expected: null }])
    assert.equal(f.disk.get(savedPath), materializedBytes)
    assert.equal(f.disk.get(sourcePath), sourceBytes)
    assert.equal(f.saveCredential(), undefined)
  } finally { await f.service.dispose() }
})

test('annotation unlock requires a live reference, unchanged source and a password that grants edit permission', async () => {
  const f = setup({ ownerRequired: true })
  try {
    const opened = await f.open()
    assert.equal(opened.document.annotationEditing, 'owner-password-required')
    await assert.rejects(f.edit(opened, note), { code: 'pdf/read-only' })
    const unlock = (password: string, referenceId = 'tab-a') =>
      f.operation(opened, 'unlockEdit', { password, referenceId, knownBytesHash: digestPdfBytes(sourceBytes) })
    await assert.rejects(f.reader(unlock('owner-password'), 'agent'), { code: 'pdf/protected-document' })
    await assert.rejects(f.reader(unlock('owner-password', 'unrelated-tab')), { code: 'pdf/reference-released' })
    await assert.rejects(f.reader({ ...unlock('owner-password'), revision: opened.revision + 1 }), { code: 'pdf/stale-revision' })
    assert.deepEqual(f.passwords, [undefined], 'unauthorized and stale requests never inspect the password')
    await assert.rejects(f.reader(unlock('wrong-password')), { code: 'pdf/password-incorrect' })
    await assert.rejects(f.reader(unlock('user-password')), { code: 'pdf/owner-password-required' })
    assert.equal(f.service.passwordFor(opened.id, digestPdfBytes(sourceBytes)), undefined)

    f.disk.set(sourcePath, Uint8Array.of(9))
    await assert.rejects(f.reader(unlock('owner-password')), { code: 'pdf/source-conflict' })
    f.disk.set(sourcePath, sourceBytes)
    f.behavior.sourceChangeOnUnlock = true
    await assert.rejects(f.reader(unlock('owner-password')), { code: 'pdf/source-conflict' })
    f.disk.set(sourcePath, sourceBytes)
    f.behavior.sourceChangeOnUnlock = false
    const unlocked = await f.snapshot(unlock('owner-password'))
    assert.equal(unlocked.document.annotationEditing, 'allowed')
    assert.equal(unlocked.document.allowTextExtraction, true)
    assert.equal(unlocked.bytes, opened.bytes)
    assert.equal(unlocked.revision, opened.revision + 1)
    assert.equal(unlocked.contentVersion, opened.contentVersion)
    assert.doesNotMatch(JSON.stringify(unlocked), /owner-password/)

    const joined = await f.snapshot({ action: 'unlock', address, referenceId: 'tab-b', password: 'user-password' })
    assert.equal(joined.revision, unlocked.revision, 'the same live copy cannot be downgraded by a later opening password')
    const edited = await f.edit(unlocked, note)
    await assert.rejects(f.reader(f.operation(edited, 'save', { options: { path: savedPath } }), 'agent'),
      { code: 'pdf/protected-document' })
    const saved = await f.save(edited)
    assert.equal(f.saveCredential(), 'owner-password')
    assert.equal(f.service.passwordFor(saved.id, digestPdfBytes(sourceBytes)), undefined)
    assert.equal(f.service.passwordFor(saved.id, digestPdfBytes(materializedBytes)), 'owner-password')
    await f.reader({ action: 'release', id: saved.id, referenceId: 'tab-b' })
    await f.reader({ action: 'release', id: saved.id, referenceId: 'tab-a' })
    assert.equal(f.service.passwordFor(saved.id, digestPdfBytes(materializedBytes)), undefined)
    assert.deepEqual(f.released, [saved.id])
    assert.deepEqual(f.service.listDocuments(), [])
  } finally { await f.service.dispose() }
})

test('an encrypted Reader rejects other operation kinds and protects in-memory content from model requests', async () => {
  const f = setup()
  try {
    await assert.rejects(f.reader({ action: 'open', address, owner: 'ui', referenceId: 'model-view' }, 'agent'),
      { code: 'pdf/protected-document' })
    await assert.rejects(f.reader({ action: 'unlock', address, referenceId: 'model-view', password: 'owner-password' }, 'agent'),
      { code: 'pdf/protected-document' })
    const opened = await f.open()
    const change = f.operation(opened, 'change', { operations: [note] })
    await assert.rejects(f.reader(change, 'agent'), { code: 'pdf/protected-document' })
    await assert.rejects(f.reader({ action: 'refresh', id: opened.id }, 'agent'), { code: 'pdf/protected-document' })
    await assert.rejects(f.reader({ action: 'discardMany', ids: [opened.id] }, 'agent'), { code: 'pdf/protected-document' })
    await assert.rejects(f.reader({ action: 'open', address, owner: 'agent' }, 'agent'), { code: 'pdf/protected-document' })
    await assert.rejects(f.reader(f.operation(opened, 'reload')), { code: 'pdf/read-only' })
    for (const operation of [
      { type: 'set-field', fieldId: 'field', value: 'private' },
      { type: 'outline-delete', id: 'bookmark' },
      { ...note, annotation: { ...note.annotation, replyToId: 'parent' } },
      { type: 'update', id: note.annotation.id, patch: { commentPosition: [1, 2] } },
    ] satisfies PdfWorkingCopyOperation[]) {
      await assert.rejects(f.edit(opened, operation), { code: 'pdf/protected-annotation-operation' })
    }
    for (const operation of [
      ...(['id', 'contents', 'author'] as const).map(key =>
        ({ ...note, annotation: { ...note.annotation, [key]: '\0' } })),
      { type: 'update', id: note.annotation.id, patch: { contents: 'bad\0text' } },
    ] satisfies PdfWorkingCopyOperation[]) {
      await assert.rejects(f.edit(opened, operation), { code: 'pdf/invalid-operation' })
    }
    const edited = await f.edit(opened, note)
    const discarded = await f.snapshot(f.operation(edited, 'discard'))
    assert.equal(discarded.dirty, false)
    const redrafted = await f.edit(discarded, note)
    f.disk.set(sourcePath, Uint8Array.of(7))
    const conflicted = await f.snapshot(f.operation(redrafted, 'discard'))
    assert.equal(conflicted.conflict, true)
    assert.equal(conflicted.dirty, false)
    assert.equal(conflicted.bytes, sourceBytes)
    await f.reader({ action: 'discardMany', ids: [opened.id] })
    assert.deepEqual(f.service.listDocuments(), [])
  } finally { await f.service.dispose() }
})

test('closing the final protected view fences edits and drops its draft even with an in-flight read', async () => {
  const f = setup()
  let unpin: (() => void) | undefined
  try {
    const draft = await f.edit(await f.open(), note)
    unpin = await f.service.acquire(sessionId, draft.id, agent, signal)
    await f.reader({ action: 'release', id: draft.id, referenceId: 'tab-a' })
    await assert.rejects(f.edit(draft, { ...note, annotation: { ...note.annotation, id: 'late-note' } }), { code: 'pdf/unknown-document' })
    await assert.rejects(f.reader({ action: 'refresh', id: draft.id }), { code: 'pdf/unknown-document' })
    const reopened = await f.open('tab-b')
    assert.equal(reopened.id, draft.id, 'a pending read can temporarily retain the registry identity')
    assert.equal(reopened.dirty, false)
    assert.deepEqual(reopened.document.annotations, [])
    await f.reader({ action: 'release', id: draft.id, referenceId: 'tab-b' })
    const reclaim = f.service.suspend(sessionId, draft.id)
    unpin(); unpin = undefined
    assert.equal(await reclaim, 'released')
    assert.deepEqual(f.released, [draft.id])
    assert.deepEqual(f.service.listDocuments(), [])
  } finally { unpin?.(); await f.service.dispose() }
})

test('old or signed protected readers never enable annotation unlock or edits', async () => {
  for (const config of [{ writer: false }, { signed: true }]) {
    const f = setup(config)
    try {
      const opened = await f.open()
      assert.equal(opened.document.readOnly, true)
      assert.equal(opened.document.annotationEditing, undefined)
      assert.ok(opened.document.annotations.every(annotation => !annotation.editable))
      await assert.rejects(f.edit(opened, note), { code: 'pdf/read-only' })
      await assert.rejects(f.reader(f.operation(opened, 'unlockEdit', { referenceId: 'tab-a', password: 'owner-password' })),
        { code: 'pdf/read-only' })
    } finally { await f.service.dispose() }
  }
})

test('an uncertain encrypted publication can be reconciled from the same in-memory output digest', async () => {
  const f = setup()
  try {
    const edited = await f.edit(await f.open(), note)
    f.behavior.uncertain = true
    f.behavior.publishBeforeUncertain = false
    await assert.rejects(f.save(edited), { code: 'PDF_SAVE_UNCERTAIN' })
    assert.equal(f.service.readSnapshot(sessionId, edited.id).dirty, true)
    f.behavior.publishBeforeUncertain = true
    const saved = await f.save(edited)
    assert.equal(saved.path, savedPath)
    assert.equal(saved.dirty, false)
  } finally { await f.service.dispose() }
})
