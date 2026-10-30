import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../../../src/entrypoints/image-understanding-host.ts'
import { HostImageUnderstandingService, ImageUnderstandingError } from '../../../src/modules/image-understanding/index.js'
import { createImageUnderstandingDispatch, createPdfImageEvidenceResolver } from '../../../src/adapters/host/dsh/image-transport.ts'
import { registerPdfTransport } from '../../../src/adapters/host/dsh/transport.ts'
import type { PdfImageEvidenceResolver } from '../../../src/adapters/host/dsh/image-transport.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256 } from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'

function png(width = 12, height = 9): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.set([73, 72, 68, 82], 12)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}
const signal = new AbortController().signal
const request = () => ({ signal })
const agent = { session: { id: 'session-1', header: {} } }
const imageRefId = 'pdfref_00000000-0000-0000-0000-000000000001'
const input = { action: 'prepare-reference', sessionId: 'session-1', documentId: 'document-1',
  refId: imageRefId, question: 'Explain this region.' }
function verifiedReference(data: Uint8Array = png()): Awaited<ReturnType<PdfImageEvidenceResolver['resolve']>> {
  const digest = evidenceSha256(data)
  return { image: { mediaType: 'image/png', data, width: 12, height: 9 }, evidence: {
    refId: imageRefId, documentId: 'document-1', sourcePath: '/tmp/test.pdf', sourceDigest: digest,
    sourceVersion: 'source-1', contentVersion: 'content-1', revision: 0,
    page: 1, source: 'direct-image', renderedImageSha256: digest,
    locator: { kind: 'pdf-region', rectPdf: [10, 20, 30, 40] },
    precision: 'approximate-geometry', limitations: [],
    snapshot: { kind: 'attachment', attachmentId: digest, mediaType: 'image/png',
      bytes: data.byteLength, width: 12, height: 9, storedImageSha256: digest },
  } }
}
function service(run = async (_prompt: string) => 'Visible chart interpretation') {
  const vision = new HostImageUnderstandingService(() => 'fixture.vision')
  vision.register({ descriptor: { id: 'fixture.vision', name: 'Fixture vision', version: '1', execution: 'local' },
    async availability() { return { available: true } },
    async understand(request) { return { text: await run(request.prompt), model: 'fixture-model' } } })
  return vision
}

test('image Host registers one DSH vision executor by default', () => {
  assert.deepEqual(Config.parse(undefined), { backend: 'dsh-vision' })
})

test('explanation delivery chooses direct session attachments independently of the selected vision executor', async () => {
  const vision = new HostImageUnderstandingService(() => 'not-installed')
  let direct = true
  const dispatch = createImageUnderstandingDispatch(vision, undefined, { canDeliverImage: async () => direct })
  try {
    assert.deepEqual(await dispatch('session-1', { action: 'availability', sessionId: 'session-1' }, agent, signal),
      { status: 'available', kind: 'direct-image', backendId: 'session-model' })
    direct = false
    const unavailable = await dispatch('session-1', { action: 'availability', sessionId: 'session-1' }, agent, signal) as { status: string }
    assert.equal(unavailable.status, 'unavailable', 'missing executor never silently falls back to OCR')
  } finally { vision.dispose() }
})

test('reference dispatch rejects foreign sessions, forged handles and obsolete caller-supplied images', async () => {
  const vision = service()
  let called = false
  const dispatch = createImageUnderstandingDispatch(vision, { async resolve() { called = true; return verifiedReference() } })
  try {
    await assert.rejects(dispatch('session-2', input, agent, signal), { code: 'pdf/session-mismatch' })
    for (const invalid of [{ ...input, refId: 'bad' }, { ...input, image: { data: 'client-controlled' } },
      { action: 'prepare', sessionId: 'session-1', image: { data: 'anything' }, question: 'Explain' }]) {
      await assert.rejects(dispatch('session-1', invalid, agent, signal), { code: 'pdf/image-invalid-request' })
    }
    assert.equal(called, false)
    await assert.rejects(createImageUnderstandingDispatch(vision)('session-1', input, agent, signal), { code: 'pdf/reference-unavailable' })
  } finally { vision.dispose() }
})

test('direct explanation returns verified Host PNG without running OCR or vision inference', async () => {
  const source = verifiedReference(), resolutions: string[] = []
  const vision = service(async () => assert.fail('direct delivery must not run an engine'))
  const resolver: PdfImageEvidenceResolver = { async resolve(owner, id, ref) {
    assert.equal(owner, 'session-1'); assert.equal(id, 'document-1'); resolutions.push(ref); return source
  } }
  const dispatch = createImageUnderstandingDispatch(vision, resolver, { canDeliverImage: async () => true })
  try {
    const result = await dispatch('session-1', input, agent, signal) as {
      value: { kind: string; requestedRefId: string; evidence: { refId: string }; bytes: null }; bytes: Uint8Array; mime: string }
    assert.deepEqual(resolutions, [imageRefId, imageRefId])
    assert.equal(result.value.kind, 'direct-image'); assert.equal(result.value.requestedRefId, imageRefId)
    assert.equal(result.value.evidence.refId, imageRefId); assert.equal(result.value.bytes, null)
    assert.equal(result.mime, 'image/png'); assert.deepEqual(result.bytes, source.image.data)
  } finally { vision.dispose() }
})

test('text-only explanation executes the selected vision engine and returns its text with provenance', async () => {
  let prompt = ''
  const vision = service(async value => { prompt = value; return 'Chart trend increases.' })
  const resolver: PdfImageEvidenceResolver = { async resolve() { return verifiedReference() } }
  try {
    const result = await createImageUnderstandingDispatch(vision, resolver)('session-1', input, agent, signal) as {
      kind: string; text: string; evidence: { refId: string }; provenance: { mode: string; backendId: string }; bytes?: Uint8Array }
    assert.equal(prompt, input.question); assert.equal(result.kind, 'derived-text')
    assert.equal(result.text, 'Chart trend increases.'); assert.equal(result.evidence.refId, imageRefId)
    assert.equal(result.provenance.mode, 'image-description'); assert.equal(result.provenance.backendId, 'fixture.vision')
    assert.equal(result.bytes, undefined)
  } finally { vision.dispose() }
})

test('reference preparation refuses corrupted evidence, stale sources and changing conversation modalities', async () => {
  const valid = verifiedReference()
  const vision = service()
  let chosen = valid, calls = 0, direct = false, failProbe = false
  const resolver: PdfImageEvidenceResolver = { async resolve() { calls++; return chosen } }
  const dispatch = createImageUnderstandingDispatch(vision, resolver, { canDeliverImage: async () => {
    if (failProbe) throw new Error('model information unavailable')
    return direct
  } })
  try {
    chosen = { ...valid, evidence: { ...valid.evidence, documentId: 'other' } }
    await assert.rejects(dispatch('session-1', input, agent, signal), { code: 'pdf/reference-unavailable' })
    chosen = { ...valid, image: { ...valid.image, data: png(12, 10) } }
    await assert.rejects(dispatch('session-1', input, agent, signal), { code: 'pdf/reference-unavailable' })
    chosen = valid; failProbe = true
    await assert.rejects(dispatch('session-1', input, agent, signal), /model information unavailable/)
    failProbe = false
    const mutation = service(async () => { chosen = { ...valid, evidence: { ...valid.evidence,
      refId: 'pdfref_00000000-0000-0000-0000-000000000002' } }; return 'Late output' })
    try { await assert.rejects(createImageUnderstandingDispatch(mutation, resolver)('session-1', input, agent, signal),
      { code: 'pdf/stale-reader' }) } finally { mutation.dispose() }
    chosen = valid
    const modalityChange = service(async () => { direct = true; return 'Late interpretation' })
    try { await assert.rejects(createImageUnderstandingDispatch(modalityChange, resolver, {
      canDeliverImage: async () => direct })('session-1', input, agent, signal), { code: 'pdf/image-route-changed' }) }
    finally { modalityChange.dispose() }
    assert.ok(calls >= 6)
  } finally { vision.dispose() }
})

test('Host reference resolver rechecks source and reads exact stored PNG bytes', async () => {
  const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])
  const source = verifiedReference()
  source.evidence.sourceDigest = evidenceSha256(pdfBytes)
  const store = createMemoryEvidenceReferenceStore()
  await store.put(imageRefId, { sessionId: 'session-1', evidence: source.evidence, createdAt: Date.now() })
  const workspace = { readSnapshot(owner: string, id: string) {
    assert.equal(owner, 'session-1')
    assert.equal(id, 'document-1')
    return { id, path: '/tmp/test.pdf', bytes: pdfBytes, sourceVersion: 'source-1',
      contentVersion: 'content-1', revision: 0, document: { pageCount: 1 } } as HostWorkspaceSnapshot
  } }
  let reads = 0
  const attachments = { async readImage(ref: { attachmentId: string }) {
    reads++
    assert.equal(ref.attachmentId, source.evidence.snapshot.attachmentId)
    return { ref: { ...ref, mediaType: 'image/png', bytes: source.image.data.byteLength,
      width: 12, height: 9 }, data: source.image.data }
  } }
  let fresh = true
  let sourceChecks = 0
  const resolver = createPdfImageEvidenceResolver(workspace, store, attachments as never,
    async (owner, snapshot) => {
      assert.equal(owner, 'session-1')
      assert.equal(snapshot.path, '/tmp/test.pdf')
      sourceChecks++
      return { path: snapshot.path, digest: fresh ? evidenceSha256(pdfBytes) : evidenceSha256(new Uint8Array([1])) }
    })
  const result = await resolver.resolve('session-1', 'document-1', imageRefId, request().signal)
  assert.deepEqual(result.image.data, source.image.data)
  assert.notEqual(result.image.data, source.image.data)
  assert.equal(result.evidence.refId, imageRefId)
  assert.equal(reads, 1)
  assert.equal(sourceChecks, 2)
  const unavailable = createPdfImageEvidenceResolver(workspace, store, { async readImage() {
    throw new Error('attachment backend offline')
  } } as never, async (_owner, current) => ({ path: current.path, digest: evidenceSha256(pdfBytes) }))
  await assert.rejects(unavailable.resolve('session-1', 'document-1', imageRefId, request().signal),
    { code: 'pdf/attachment-unavailable' })
  const controlled = createPdfImageEvidenceResolver(workspace, store, { async readImage() {
    throw new ImageUnderstandingError('pdf/attachment-denied', 'Attachment access denied.')
  } } as never, async (_owner, current) => ({ path: current.path, digest: evidenceSha256(pdfBytes) }))
  await assert.rejects(controlled.resolve('session-1', 'document-1', imageRefId, request().signal),
    { code: 'pdf/attachment-denied' })

  const derivedStore = createMemoryEvidenceReferenceStore()
  const derived = { ...source.evidence, source: 'ocr-text' as const,
    snapshot: { kind: 'derived-text' as const, text: 'Visible text', sha256: evidenceSha256('Visible text'),
      backendId: 'test-ocr', backendVersion: '1' } }
  await derivedStore.put(imageRefId, { sessionId: 'session-1', evidence: derived, createdAt: Date.now() })
  const derivedResolver = createPdfImageEvidenceResolver(workspace, derivedStore, attachments as never,
    async (_owner, current) => ({ path: current.path, digest: evidenceSha256(pdfBytes) }))
  await assert.rejects(derivedResolver.resolve('session-1', 'document-1', imageRefId, request().signal),
    { code: 'pdf/reference-unavailable' })
  fresh = false
  await assert.rejects(resolver.resolve('session-1', 'document-1', imageRefId, request().signal),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'pdf/stale-reader')
  fresh = true
  source.image.data[8] = 99
  await assert.rejects(resolver.resolve('session-1', 'document-1', imageRefId, request().signal),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'pdf/attachment-unavailable')
})


test('reference image RPC transports the attested PNG as binary, not Base64 JSON', async () => {
  const source = verifiedReference()
  const resolver: PdfImageEvidenceResolver = { async resolve() { return source } }
  const vision = service(async () => assert.fail('direct delivery does not invoke inference'))
  let route: { fetch(request: Request): Promise<Response> } | undefined
  const ctx = {
    connection: { fetch: { register(value: typeof route) { route = value; return async () => {} } } },
    sessionController: { async resolveAgent() { return { agent } } },
  }
  const dispose = registerPdfTransport(ctx as never,
    createImageUnderstandingDispatch(vision, resolver, { canDeliverImage: async () => true }),
    { endpoint: 'pdf.image', maxRequestBytes: 4096 })
  try {
    const response = await route!.fetch(new Request('https://example.test/api/pdf.image', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method: 'pdf.image', rpcId: 'test-ref', payload: input }),
    }))
    assert.equal(response.status, 200)
    const form = await response.formData()
    const envelope = JSON.parse(form.get('metadata') as string) as {
      result: { ok: boolean; value: { evidence: { refId: string }; bytes: null } }
    }
    assert.equal(envelope.result.ok, true); assert.equal(envelope.result.value.evidence.refId, imageRefId)
    assert.equal(envelope.result.value.bytes, null)
    assert.deepEqual(new Uint8Array(await (form.get('pdf-bytes') as Blob).arrayBuffer()), source.image.data)
  } finally { await dispose(); vision.dispose() }
})
