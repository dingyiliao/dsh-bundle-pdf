import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { NativeWorker } from '../src/adapters/host/pdfium/native-worker.ts'
import { createPdfService } from '../src/adapters/host/pdfium/pdf-service.ts'
import { createV1DraftRepository } from '../src/adapters/host/storage/v1-drafts.ts'
import { wireSnapshotSchema } from '../src/contracts/rpc/workspace.ts'
import type { PdfDocumentInfo } from '../src/core/pdf-types.ts'
import { digestPdfBytes } from '../src/modules/document/index.ts'
import { createWorkingCopyService } from '../src/modules/working-copy/index.ts'
import { inProcessPdfDocument } from './fixtures/working-copy-service.ts'
import { memoryWorkspace, nativeFixture } from './native-fixture.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native tests require a built helper')
const skip = !existsSync(executable)
const sessionId = 'protected-reader'
const address = `dsh-resource://file/session/${sessionId}/%2Fprotected.pdf`
const path = '/protected.pdf'
const agent = { session: { id: sessionId, header: {} } }
const signal = new AbortController().signal
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}.pdf`, import.meta.url))

function setup(initial: Uint8Array, beforeInspection?: () => Promise<void>) {
  let bytes = initial
  const files = {
    async resolvePath() { return path },
    async read() { return { path, bytes, size: bytes.length, fsVersion: 'fixture', version: digestPdfBytes(bytes) } },
    async save(): Promise<never> { assert.fail('Protected source should never be written') },
  }
  const drafts = createV1DraftRepository({
    get: () => undefined,
    put: async () => assert.fail('Protected content should never be persisted as a draft'),
    delete: async () => assert.fail('A protected read should not touch draft storage'),
  })
  const workspaces = createWorkingCopyService(files, drafts, inProcessPdfDocument, {
    async inspect(source, password, requestSignal): Promise<PdfDocumentInfo | undefined> {
      await beforeInspection?.()
      return reader.inspectEncrypted(source, password, requestSignal)
    },
    release: id => { void reader.releaseDocument(id) },
  })
  const reader = createPdfService(workspaces, { executable, subprocess: nativeTestSubprocess })
  const dispatch = (input: Record<string, unknown>) => reader.dispatch(sessionId, { ...input, sessionId }, agent, signal)
  const open = (referenceId: string) => dispatch({ action: 'open', address, referenceId })
  const unlock = (referenceId: string, password: string) => dispatch({ action: 'unlock', address, referenceId, password })
  return { workspaces, reader, dispatch, open, unlock, replace: (source: Uint8Array) => { bytes = source },
    async dispose() { await workspaces.dispose(); await reader.dispose() } }
}

test('protected Reader unlock is session-scoped, transient and read-only, even after native handle eviction', { skip }, async () => {
  const state = setup(await fixture('password-object-stream'))
  try {
    await assert.rejects(state.workspaces.execute(sessionId, {
      action: 'open', sessionId, address, owner: 'agent',
    }, agent, signal), { code: 'pdf/protected-document' })
    await assert.rejects(state.open('tab-a'), { code: 'pdf/password-required' })
    await assert.rejects(state.unlock('tab-a', 'bad-password'), error => {
      assert.equal((error as { code: string }).code, 'pdf/password-incorrect')
      assert.doesNotMatch(String(error), /bad-password/)
      return true
    })
    assert.deepEqual(state.workspaces.listDocuments(), [])
    await assert.rejects(state.workspaces.execute('other', { action: 'unlock', sessionId: 'other', address,
      referenceId: 'tab-a', password: 'fixture-password' }, { session: { id: 'other', header: {} } }, signal),
    { code: 'pdf/session-mismatch' })

    const response = await state.unlock('tab-a', 'fixture-password')
    const opened = wireSnapshotSchema.parse(response)
    assert.equal(opened.document?.encrypted, true)
    assert.equal(opened.document?.readOnlyReason, 'encrypted-document')
    assert.equal(opened.document?.pageCount, 2)
    assert.equal(opened.document?.pages[0].rotation, 90)
    assert.doesNotMatch(JSON.stringify(response), /fixture-password/)
    assert.deepEqual(state.workspaces.listOpenDocuments(), [], 'protected copies never schedule indexing')
    await assert.rejects(state.workspaces.execute(sessionId,
      { action: 'open', sessionId, address, owner: 'agent' }, agent, signal), { code: 'pdf/protected-document' })
    await assert.rejects(state.reader.renderPage(sessionId, opened.id, 1, 256, signal), { code: 'pdf/protected-document' })
    await assert.rejects(state.dispatch({ action: 'save', id: opened.id, revision: opened.revision, options: {} }), { code: 'pdf/read-only' })

    await state.reader.releaseDocument(opened.id)
    const tile = async (page: number) => await state.reader.native(sessionId, {
      action: 'tile', sessionId, id: opened.id, bytesHash: opened.reader.bytesHash,
      tile: { page, rotation: 0, rasterWidth: 500, rasterHeight: 320, x: 0, y: 0, width: 500, height: 320, annotations: false },
    }, agent, signal) as { bytes: Buffer }
    const annotated = (await tile(1)).bytes, blank = (await tile(2)).bytes
    assert.equal(annotated.subarray(1, 4).toString(), 'PNG')
    assert.ok(!annotated.equals(blank), 'existing annotations render even without editable overlays')
    assert.equal(state.reader.diagnostics().tileCacheEntries, 0)
    assert.equal(wireSnapshotSchema.parse(await state.open('tab-b')).id, opened.id)
    await state.dispatch({ action: 'release', id: opened.id, referenceId: 'tab-a' })
    assert.equal(state.workspaces.listDocuments()[0]?.uiReferences, 1)
    const releaseRead = await state.workspaces.acquire(sessionId, opened.id, agent, signal)
    try {
      await state.dispatch({ action: 'release', id: opened.id, referenceId: 'tab-b' })
      assert.equal(state.workspaces.passwordFor(opened.id, opened.reader.bytesHash), undefined)
      await assert.rejects(state.open('tab-c'), { code: 'pdf/password-required' })
      await assert.rejects(state.workspaces.acquire(sessionId, opened.id, agent, signal), { code: 'pdf/unknown-document' })
    } finally { releaseRead() }
    await assert.rejects(state.open('tab-c'), { code: 'pdf/password-required' })
    assert.deepEqual(state.workspaces.listDocuments(), [])
    assert.throws(() => state.workspaces.readSnapshot(sessionId, opened.id), { code: 'pdf/unknown-document' })
    await assert.rejects(state.unlock('tab-b', 'fixture-password'), { code: 'pdf/reference-released' })
  } finally { await state.dispose() }
})

test('the Reader honors extraction permissions and rejects non-Reader access to protected pages', { skip }, async () => {
  const state = setup(await fixture('encrypted-restricted-text'))
  try {
    const opened = wireSnapshotSchema.parse(await state.unlock('tab-a', 'fixture-password'))
    assert.equal(opened.document?.allowTextExtraction, false)
    const request = { sessionId, id: opened.id, bytesHash: opened.reader.bytesHash, page: 1 }
    await assert.rejects(state.reader.readPageText(sessionId, opened.id, 1, signal), { code: 'pdf/protected-document' })
    await assert.rejects(state.reader.native(sessionId, { ...request, action: 'inspect', offset: 0, limit: 1 }, agent, signal),
      { code: 'pdf/protected-document' })
    assert.deepEqual(await state.reader.native(sessionId, { ...request, action: 'text', recover: true }, agent, signal),
      { items: [], styles: {}, lang: null })

    await state.dispatch({ action: 'release', id: opened.id, referenceId: 'tab-a' })
    const owner = wireSnapshotSchema.parse(await state.unlock('tab-b', 'fixture-owner'))
    assert.equal(owner.document?.allowTextExtraction, true)
    const ownerText = await state.reader.native(sessionId, { ...request, id: owner.id, action: 'text' }, agent, signal) as {
      items: { str: string }[]
    }
    assert.equal(ownerText.items.map(item => item.str).join(''), 'Protected fixture text')
  } finally { await state.dispose() }
})

test('a legacy native helper receives no password or encrypted payload', { skip }, async t => {
  const bytes = await fixture('password-object-stream')
  const state = setup(bytes)
  const ready = NativeWorker.prototype.ready
  t.mock.method(NativeWorker.prototype, 'ready', async function(this: NativeWorker) {
    await ready.call(this)
    this.encryptedOpen = false
  })
  const request = t.mock.method(NativeWorker.prototype, 'request')
  try {
    assert.equal(await state.reader.inspectEncrypted(bytes, undefined, signal), undefined)
    await assert.rejects(state.unlock('tab-a', 'fixture-password'), { code: 'pdf/security-unsupported' })
    assert.equal(request.mock.callCount(), 0)
    assert.deepEqual(state.workspaces.listDocuments(), [])
  } finally { await state.dispose() }
})

test('missing protected PDF capabilities close the probe handle without publishing a document', { skip }, async t => {
  const state = setup(await fixture('password-object-stream'))
  const request = NativeWorker.prototype.request
  const closed: string[] = []
  let xfaDocument: string | undefined
  t.mock.method(NativeWorker.prototype, 'request', async function(this: NativeWorker,
    ...args: Parameters<NativeWorker['request']>) {
    const { command, documentId } = args[0] as { command: string; documentId: string }
    const reply = await request.apply(this, args)
    if (command === 'close') closed.push(documentId)
    if (command !== 'open') return reply
    xfaDocument = documentId
    return { ...reply, value: { ...(reply.value as object), formType: 2 } }
  })
  try {
    await assert.rejects(state.unlock('tab-a', 'fixture-password'), { code: 'pdf/native-unsupported',
      message: /pdf\.form\.xfa\.render/ })
    assert.ok(xfaDocument)
    assert.deepEqual(closed, [xfaDocument])
    assert.deepEqual(state.workspaces.listDocuments(), [])
  } finally { await state.dispose() }
})

test('a password attempt cannot replace an existing draft after an external source change', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const address = `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`
  const initial = await state.workspaces.execute(sessionId, { action: 'open', sessionId, address }, agent, signal)
  assert.ok('bytes' in initial)
  const edited = await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: initial.id, revision: initial.revision,
    operations: [{ type: 'add', annotation: { id: 'preserved-note', page: 1, subtype: 'Text', rect: [55, 65, 75, 85] } }],
  }, agent, signal)
  assert.ok('bytes' in edited && edited.dirty)
  await state.workspaces.dispose()

  const replacement = await fixture('password-object-stream')
  const files = { ...state.files, async read() {
    return { path: initial.path, bytes: replacement, version: digestPdfBytes(replacement), fsVersion: 'external', size: replacement.length }
  } }
  const resumed = createWorkingCopyService(files, createV1DraftRepository(state.drafts), inProcessPdfDocument, {
    async inspect() { assert.fail('The protected replacement must not be opened over a pending draft') }, release() {},
  })
  try {
    await assert.rejects(resumed.execute(sessionId, { action: 'unlock', sessionId, address, referenceId: 'new-tab',
      password: 'fixture-password' }, agent, signal), { code: 'pdf/source-conflict' })
    const recovered = await resumed.execute(sessionId, { action: 'open', sessionId, address }, agent, signal)
    assert.ok('bytes' in recovered && recovered.dirty && recovered.conflict)
    assert.equal(recovered.contentVersion, edited.contentVersion)
    assert.ok(recovered.document.annotations.some(annotation => annotation.id === 'preserved-note'))
    assert.equal(state.writes(), 0)
  } finally { await resumed.dispose() }
})

test('a final in-flight read cannot retire a protected copy while another view unlocks it', { skip }, async () => {
  let startInspection!: () => void, finishInspection!: () => void
  const started = new Promise<void>(resolve => { startInspection = resolve })
  const proceed = new Promise<void>(resolve => { finishInspection = resolve })
  let delay = false
  const state = setup(await fixture('password-object-stream'), async () => {
    if (delay) { startInspection(); await proceed }
  })
  let releaseRead: (() => void) | undefined
  try {
    const opened = wireSnapshotSchema.parse(await state.unlock('tab-a', 'fixture-password'))
    releaseRead = await state.workspaces.acquire(sessionId, opened.id, agent, signal)
    await state.dispatch({ action: 'release', id: opened.id, referenceId: 'tab-a' })
    delay = true
    const opening = state.unlock('tab-b', 'fixture-password')
    await started
    releaseRead(); releaseRead = undefined
    finishInspection()
    const next = wireSnapshotSchema.parse(await opening)
    assert.equal(next.id, opened.id)
    assert.equal(state.workspaces.listDocuments()[0]?.uiReferences, 1)
  } finally { finishInspection(); releaseRead?.(); await state.dispose() }
})

test('empty-password PDFs open directly and a changed source never inherits the previous unlock', { skip }, async () => {
  const state = setup(await fixture('encrypted-object-stream'))
  try {
    const opened = wireSnapshotSchema.parse(await state.open('tab-a'))
    assert.equal(opened.document?.encrypted, true)
    state.replace(await fixture('password-object-stream'))
    await assert.rejects(state.open('tab-b'), { code: 'pdf/password-required' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).contentVersion, opened.contentVersion)
    const next = wireSnapshotSchema.parse(await state.unlock('tab-b', 'fixture-password'))
    assert.equal(next.id, opened.id)
    assert.notEqual(next.contentVersion, opened.contentVersion)
    await state.workspaces.releaseProtectedSession(sessionId)
    assert.deepEqual(state.workspaces.listDocuments(), [])
    await assert.rejects(state.open('tab-b'), { code: 'pdf/password-required' })
  } finally { await state.dispose() }
})
