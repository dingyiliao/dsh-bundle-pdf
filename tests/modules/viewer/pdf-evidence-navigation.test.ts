import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { pdfEvidenceCardModel, type PdfEvidenceEntry } from '../../../src/client/toolview/pdf-evidence-model.ts'
import { createPdfEvidenceNavigation, type EvidenceRevalidationRequest, type RevalidateEvidence,
  type VisiblePdfReader } from '../../../src/client/toolview/pdf-evidence-navigation.ts'
import type { TextNavigationTarget } from '../../../src/contracts/navigation.ts'

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
  const readOptions: Array<{ recover?: boolean } | undefined> = []
  let current: WorkspaceSnapshot | null = snapshot
  let text = pageText
  const reader: VisiblePdfReader = {
    sessionId: 'session-1', snapshot, current: () => current,
    readPageText: async (page, _signal, options) => { reads.push(page); readOptions.push(options); return text },
    jump: async page => { jumps.push(page); return true },
  }
  return { snapshot, evidence, reader, jumps, reads, readOptions,
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
async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
}

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
  // WebCrypto runs asynchronously; one event-loop turn is not a portable
  // guarantee that the path digest has completed on every CI runner.
  await waitUntil(() => navigation.canNavigate('session-1', evidence))
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

test('a historical tool card uses Host-revalidated exact geometry and never falls back to a page-only jump', async () => {
  const f = fixture()
  const target: TextNavigationTarget = { kind: 'text', refId: 'revalidated-ref', revision: f.snapshot.revision,
    sourceDigest: f.snapshot.reader.bytesHash, pageTextDigest: hash(pageText), startUtf16: offset,
    endUtf16: offset + excerpt.length, textSha256: hash(excerpt), rectPdf: [20, 300, 200, 310],
    quadPoints: [20, 310, 200, 310, 20, 300, 200, 300] }
  let exact = 0
  const navigation = createPdfEvidenceNavigation(async (...args) => ({ ...await approve(f.snapshot)(...args), target }), hashText)
  f.reader.navigateTarget = async (page, received, signal) => {
    assert.equal(page, f.evidence.page)
    assert.deepEqual(received, target)
    assert.equal(signal.aborted, false)
    exact++; return 'opened'
  }
  navigation.register(f.reader)
  await nextTurn()
  assert.equal(await navigation.navigate('session-1', f.evidence, new AbortController().signal), 'opened')
  assert.equal(exact, 1)
  assert.deepEqual(f.jumps, [])
  f.reader.navigateTarget = async () => 'stale'
  assert.equal(await navigation.navigate('session-1', f.evidence, new AbortController().signal), 'stale')
  delete f.reader.navigateTarget
  assert.equal(await navigation.navigate('session-1', f.evidence, new AbortController().signal), 'unavailable')
  assert.deepEqual(f.jumps, [], 'unavailable exact positioning must not silently degrade to the wrong location')
})

test('historical local OCR cards retain sourceDigest through replay and send it for page-only Host validation', async () => {
  const f = fixture()
  const persisted = JSON.parse(JSON.stringify({ ...f.evidence,
    kind: 'pdf-evidence-snapshot', version: 1, tool: 'pdf_page_read', status: 'ok',
    extraction: 'local-ocr', precision: 'page-only', sourceVersion: f.snapshot.sourceVersion }))
  const card = pdfEvidenceCardModel('pdf_page_read', persisted)
  assert.ok(card)
  const evidence = card.entries[0]!
  assert.equal(evidence.sourceDigest, f.snapshot.reader.bytesHash)
  assert.equal(evidence.extraction, 'local-ocr')
  const requests: EvidenceRevalidationRequest[] = []
  let exactCalls = 0
  f.reader.navigateTarget = async () => { exactCalls++; throw new Error('OCR has no exact native target') }
  const navigation = createPdfEvidenceNavigation(async (request, signal) => {
    assert.equal(request.sourceDigest, evidence.sourceDigest, 'the old OCR source digest must reach Host unchanged')
    assert.equal(request.extraction, 'local-ocr')
    return approve(f.snapshot, requests)(request, signal)
  }, hashText)
  navigation.register(f.reader)
  await nextTurn()
  assert.equal(await navigation.navigate('session-1', evidence, new AbortController().signal), 'opened')
  assert.deepEqual(requests.map(request => [request.sourceDigest, request.pageTextDigest, request.excerpt]),
    [[f.snapshot.reader.bytesHash, hash(pageText), excerpt]])
  assert.deepEqual(f.reads, [2])
  assert.deepEqual(f.readOptions, [{ recover: true }])
  assert.deepEqual(f.jumps, [2])
  assert.equal(exactCalls, 0)
})

test('native historical cards use raw Client post-validation even when the Reader default is OCR', async () => {
  const f = fixture(), optionsSeen: Array<{ recover?: boolean } | undefined> = []
  f.reader.readPageText = async (_page, _signal, options) => {
    optionsSeen.push(options)
    return options?.recover === false ? pageText : `${pageText} Different OCR text.`
  }
  const requests: EvidenceRevalidationRequest[] = []
  const navigation = createPdfEvidenceNavigation(approve(f.snapshot, requests), hashText)
  navigation.register(f.reader)
  await nextTurn()
  assert.equal(await navigation.navigate('session-1', f.evidence, new AbortController().signal), 'opened')
  assert.equal(requests[0]!.extraction, undefined)
  assert.deepEqual(optionsSeen, [{ recover: false }])
  assert.deepEqual(f.jumps, [2])
})

test('a historical OCR card with identical wording cannot jump when Host rejects its old source bytes', async () => {
  const f = fixture()
  const current = { ...f.snapshot, reader: { ...f.snapshot.reader, bytesHash: hash('replaced PDF bytes') } }
  const requests: EvidenceRevalidationRequest[] = []
  const reader: VisiblePdfReader = { ...f.reader, snapshot: current, current: () => current }
  const navigation = createPdfEvidenceNavigation(async request => {
    requests.push(request)
    assert.equal(request.sourceDigest, f.evidence.sourceDigest)
    assert.notEqual(request.sourceDigest, current.reader.bytesHash)
    throw Object.assign(new Error('OCR card source bytes cannot be verified'), { code: 'pdf/stale-reader' })
  }, hashText)
  navigation.register(reader)
  await nextTurn()
  assert.equal(await navigation.navigate('session-1', { ...f.evidence, extraction: 'local-ocr' },
    new AbortController().signal), 'stale')
  assert.equal(requests.length, 1)
  assert.deepEqual(f.reads, [], 'Host source denial stops the Client before reading or jumping')
  assert.deepEqual(f.jumps, [])
})
