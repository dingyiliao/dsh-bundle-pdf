import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { PdfEvidenceEntry } from '../../../src/client/toolview/pdf-evidence-model.ts'
import { createPdfEvidenceNavigation, type EvidenceRevalidationRequest, type RevalidateEvidence,
  type VisiblePdfReader } from '../../../src/client/toolview/pdf-evidence-navigation.ts'

const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const pageText = 'prefix: relevant passage: suffix'
const excerpt = 'relevant passage'
const offset = pageText.indexOf(excerpt)

function fixture() {
  const snapshot = { id: 'document-1', path: '/work/source.pdf', sourceVersion: 'source-1',
    contentVersion: 'content-1', revision: 3,
    reader: { bytesHash: hash('pdf bytes') }, document: { pageCount: 3 } } as WorkspaceSnapshot
  const evidence: PdfEvidenceEntry = {
    documentId: snapshot.id, sourcePath: snapshot.path, sourceDigest: snapshot.reader.bytesHash,
    sourcePathDigest: hash(snapshot.path), pageTextDigest: hash(pageText),
    contentVersion: snapshot.contentVersion, revision: 3, page: 2,
    locator: { kind: 'text-window', startUtf16: offset, endUtf16: offset + excerpt.length },
    snapshot: { text: excerpt, sha256: hash(excerpt), truncated: false },
  }
  const jumps: number[] = []
  const reads: number[] = []
  let current: WorkspaceSnapshot | null = snapshot
  let text = pageText
  const reader: VisiblePdfReader = {
    sessionId: 'session-1', snapshot, current: () => current,
    readPageText: async page => { reads.push(page); return text },
    jump: async page => { jumps.push(page); return true },
  }
  return { snapshot, evidence, reader, jumps, reads,
    setCurrent: (value: WorkspaceSnapshot | null) => { current = value },
    setText: (value: string) => { text = value } }
}

function approve(snapshot: WorkspaceSnapshot, requests?: EvidenceRevalidationRequest[]): RevalidateEvidence {
  return async request => {
    requests?.push(request)
    return { status: 'valid', documentId: snapshot.id, page: request.page,
      sourceDigest: snapshot.reader.bytesHash, sourceVersion: snapshot.sourceVersion,
      contentVersion: snapshot.contentVersion, revision: snapshot.revision }
  }
}

const hashText = async (value: string) => hash(value)
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

test('navigation is only available for a registered visible reader and cleans up subscriptions', async () => {
  const { evidence, reader, snapshot, jumps, reads } = fixture()
  const requests: EvidenceRevalidationRequest[] = []
  const navigation = createPdfEvidenceNavigation(approve(snapshot, requests), hashText)
  const signal = new AbortController().signal
  assert.equal(navigation.canNavigate('session-1', evidence), false)
  assert.equal(await navigation.navigate('session-1', evidence, signal), 'unavailable')
  const revisions: number[] = []
  const unsubscribe = navigation.subscribe(() => revisions.push(navigation.getRevision()))
  const dispose = navigation.register(reader)
  await nextTurn()
  assert.equal(navigation.canNavigate('session-1', evidence), true)
  assert.equal(await navigation.navigate('session-1', evidence, signal), 'opened')
  assert.deepEqual(requests.map(value => [value.documentId, value.pageTextDigest, value.excerpt]),
    [['document-1', hash(pageText), excerpt]])
  assert.deepEqual(reads, [2])
  assert.deepEqual(jumps, [2])
  dispose()
  dispose()
  assert.equal(navigation.canNavigate('session-1', evidence), false)
  assert.equal(revisions[0], 1)
  assert.equal(revisions.at(-1), navigation.getRevision())
  assert.ok(revisions.length >= 2)
  unsubscribe()
})

test('session, full path digest, page and whole-page evidence must be present', async () => {
  const { evidence, reader, snapshot, jumps } = fixture()
  const navigation = createPdfEvidenceNavigation(approve(snapshot), hashText)
  navigation.register(reader)
  await nextTurn()
  const mismatches: [string, PdfEvidenceEntry][] = [
    ['session-2', evidence],
    ['session-1', { ...evidence, sourcePathDigest: hash('/work/other.pdf') }],
    ['session-1', { ...evidence, sourcePathDigest: undefined }],
    ['session-1', { ...evidence, pageTextDigest: undefined }],
    ['session-1', { ...evidence, page: 4 }],
  ]
  for (const [sessionId, candidate] of mismatches) {
    assert.equal(navigation.canNavigate(sessionId, candidate), false)
    assert.equal(await navigation.navigate(sessionId, candidate, new AbortController().signal), 'unavailable')
  }
  assert.deepEqual(jumps, [])
})

test('reopening identical PDF bytes can navigate historical evidence after Host and Client validation', async () => {
  const { evidence, snapshot, jumps, reads } = fixture()
  const reopened = { ...snapshot, id: 'reopened-document', contentVersion: 'new-content-version' }
  const reader: VisiblePdfReader = {
    sessionId: 'session-1', snapshot: reopened, current: () => reopened,
    readPageText: async page => { reads.push(page); return pageText },
    jump: async page => { jumps.push(page); return true },
  }
  const navigation = createPdfEvidenceNavigation(approve(reopened), hashText)
  navigation.register(reader)
  await nextTurn()
  assert.equal(navigation.canNavigate('session-1', evidence), true)
  assert.equal(await navigation.navigate('session-1', evidence, new AbortController().signal), 'opened')
  assert.deepEqual(reads, [2])
  assert.deepEqual(jumps, [2])
})

test('a bounded long-path preview can navigate only after its complete path digest is verified', async () => {
  const { evidence, snapshot, jumps, reads } = fixture()
  const longPath = `/work/${'chapter/'.repeat(90)}source.pdf`
  const reopened = { ...snapshot, path: longPath }
  const reader: VisiblePdfReader = {
    sessionId: 'session-1', snapshot: reopened, current: () => reopened,
    readPageText: async page => { reads.push(page); return pageText },
    jump: async page => { jumps.push(page); return true },
  }
  const navigation = createPdfEvidenceNavigation(approve(reopened), hashText)
  navigation.register(reader)
  const historical = { ...evidence, sourcePath: longPath.slice(0, 512), sourcePathDigest: hash(longPath) }
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(navigation.canNavigate('session-1', historical), true)
  assert.equal(await navigation.navigate('session-1', historical, new AbortController().signal), 'opened')
  assert.deepEqual(reads, [2])
  assert.deepEqual(jumps, [2])

  const wrongPath = { ...historical, sourcePathDigest: hash(`${longPath}-different`) }
  assert.equal(navigation.canNavigate('session-1', wrongPath), false)
  assert.equal(await navigation.navigate('session-1', wrongPath, new AbortController().signal), 'unavailable')
  assert.deepEqual(jumps, [2])
  assert.equal(navigation.canNavigate('session-1', { ...historical, sourcePathDigest: undefined }), false)
})

test('text window and whole-page digest are revalidated before jumping', async () => {
  const { evidence, reader, snapshot, jumps, setText } = fixture()
  const navigation = createPdfEvidenceNavigation(approve(snapshot), hashText)
  navigation.register(reader)
  await nextTurn()
  const signal = new AbortController().signal
  for (const invalid of [
    { ...evidence, locator: { ...evidence.locator, startUtf16: offset + 1 } },
    { ...evidence, locator: { ...evidence.locator, endUtf16: pageText.length + 1 } },
    { ...evidence, snapshot: { ...evidence.snapshot, sha256: hash('altered') } },
  ]) assert.equal(await navigation.navigate('session-1', invalid, signal), 'stale')
  setText(pageText.replace(excerpt, 'another passage '))
  assert.equal(await navigation.navigate('session-1', evidence, signal), 'stale')
  assert.deepEqual(jumps, [])
})

test('reader hidden or replaced during asynchronous text read cannot be navigated', async () => {
  const { evidence, reader, jumps, setCurrent, snapshot } = fixture()
  let release!: (text: string) => void
  reader.readPageText = () => new Promise(resolve => { release = resolve })
  const navigation = createPdfEvidenceNavigation(approve(snapshot), hashText)
  navigation.register(reader)
  await nextTurn()
  const pending = navigation.navigate('session-1', evidence, new AbortController().signal)
  await nextTurn()
  setCurrent({ ...snapshot })
  release(pageText)
  assert.equal(await pending, 'stale')
  assert.deepEqual(jumps, [])
  setCurrent(null)
  assert.equal(navigation.canNavigate('session-1', evidence), false)
})

test('an aborted read or declined jump never reports success', async () => {
  const { evidence, reader, snapshot, jumps } = fixture()
  const navigation = createPdfEvidenceNavigation(approve(snapshot), hashText)
  navigation.register(reader)
  await nextTurn()
  const abort = new AbortController()
  abort.abort()
  assert.equal(await navigation.navigate('session-1', evidence, abort.signal), 'unavailable')
  reader.jump = async page => { jumps.push(page); return false }
  assert.equal(await navigation.navigate('session-1', evidence, new AbortController().signal), 'unavailable')
  assert.deepEqual(jumps, [2])
})

test('annotation-only save may change bytes but keeps historical card navigable after Host text validation', async () => {
  const { evidence, snapshot, jumps, reads } = fixture()
  const saved = { ...snapshot, reader: { ...snapshot.reader, bytesHash: hash('bytes after annotations') },
    revision: snapshot.revision + 1 }
  const requests: EvidenceRevalidationRequest[] = []
  const reader: VisiblePdfReader = { sessionId: 'session-1', snapshot: saved, current: () => saved,
    readPageText: async page => { reads.push(page); return pageText },
    jump: async page => { jumps.push(page); return true } }
  const navigation = createPdfEvidenceNavigation(approve(saved, requests), hashText)
  navigation.register(reader)
  await nextTurn()
  assert.notEqual(evidence.sourceDigest, saved.reader.bytesHash)
  assert.equal(navigation.canNavigate('session-1', evidence), true)
  assert.equal(await navigation.navigate('session-1', evidence, new AbortController().signal), 'opened')
  assert.equal(requests[0]?.documentId, saved.id)
  assert.deepEqual(reads, [2])
  assert.deepEqual(jumps, [2])
})

test('Host denial or a response for an older revision cannot become navigation', async () => {
  const { evidence, snapshot, reader, jumps, reads } = fixture()
  const denied = createPdfEvidenceNavigation(async () => { throw new Error('stale') }, hashText)
  denied.register(reader)
  await nextTurn()
  assert.equal(await denied.navigate('session-1', evidence, new AbortController().signal), 'stale')
  const oldRevision = createPdfEvidenceNavigation(async request => ({ ...(await approve(snapshot)(request, new AbortController().signal)),
    revision: snapshot.revision - 1 }), hashText)
  oldRevision.register(reader)
  await nextTurn()
  assert.equal(await oldRevision.navigate('session-1', evidence, new AbortController().signal), 'stale')
  assert.deepEqual(reads, [])
  assert.deepEqual(jumps, [])
})

test('bounded excerpts send their own exact span for Host revalidation', async () => {
  const { evidence, snapshot, reader } = fixture()
  const requests: EvidenceRevalidationRequest[] = []
  const navigation = createPdfEvidenceNavigation(approve(snapshot, requests), hashText)
  navigation.register(reader)
  await nextTurn()
  const truncated = { ...evidence, locator: { ...evidence.locator, endUtf16: pageText.length },
    snapshot: { ...evidence.snapshot, truncated: true } }
  assert.equal(await navigation.navigate('session-1', truncated, new AbortController().signal), 'opened')
  assert.equal(requests[0]?.endUtf16, offset + excerpt.length)
})

test('the production SHA-256 implementation validates a visible Reader', async () => {
  const { evidence, snapshot, reader } = fixture()
  const navigation = createPdfEvidenceNavigation(approve(snapshot))
  navigation.register(reader)
  await nextTurn()
  assert.equal(navigation.canNavigate('session-1', evidence), true)
  assert.equal(await navigation.navigate('session-1', evidence, new AbortController().signal), 'opened')
})

test('failed or late path hashing cannot activate a Reader lease', async () => {
  const { evidence, snapshot, reader } = fixture()
  const failed = createPdfEvidenceNavigation(approve(snapshot), async () => { throw new Error('hash failed') })
  failed.register(reader)
  await nextTurn()
  assert.equal(failed.canNavigate('session-1', evidence), false)

  let finish!: (value: string) => void
  const delayed = createPdfEvidenceNavigation(approve(snapshot),
    () => new Promise<string>(resolve => { finish = resolve }))
  const dispose = delayed.register(reader)
  const afterRegister = delayed.getRevision()
  dispose()
  finish(hash(snapshot.path))
  await nextTurn()
  assert.equal(delayed.getRevision(), afterRegister + 1)
  assert.equal(delayed.canNavigate('session-1', evidence), false)
})
