import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../../../src/entrypoints/image-understanding-host.ts'
import { HostImageUnderstandingService, ImageUnderstandingError,
  type ImageUnderstandingBackend, type ImageUnderstandingRequest } from '../../../src/modules/image-understanding/index.js'
import { createOcrTextBackend, createSessionVisionBackend } from '../../../src/adapters/host/dsh/image-backends.js'
import { createImageUnderstandingDispatch, createPdfImageEvidenceResolver } from '../../../src/adapters/host/dsh/image-transport.ts'
import { registerPdfTransport } from '../../../src/adapters/host/dsh/transport.ts'
import type { PdfImageEvidenceResolver } from '../../../src/adapters/host/dsh/image-transport.ts'
import { createMemoryEvidenceReferenceStore, evidenceSha256 } from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'
import { HostOcrService } from '../../../src/modules/ocr/index.js'
import type { OcrOutput } from '../../../src/ocr/types.ts'

function png(width = 12, height = 9): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.set([73, 72, 68, 82], 12)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

function request(signal = new AbortController().signal): ImageUnderstandingRequest {
  return { sessionId: 'session-1', image: { mediaType: 'image/png', data: png(), width: 12, height: 9 },
    question: 'What does this region mean?', signal }
}

const agent = { session: { id: 'session-1', header: {} } }

test('image Host defaults to the current session vision backend', () => {
  assert.deepEqual(Config.parse(undefined), { backend: 'session-vision' })
  assert.deepEqual(Config.parse({ backend: 'auxiliary-vision', auxiliaryVision: {
    provider: 'configured-provider', model: 'configured-vision', maxOutputTokens: 2048,
  } }), { backend: 'auxiliary-vision', auxiliaryVision: {
    provider: 'configured-provider', model: 'configured-vision', maxOutputTokens: 2048,
  } })
})

test('direct image backend follows declared image capability of the current session model', async () => {
  let model = 'text-only'
  let checked = 0
  const backend = createSessionVisionBackend({ get(key: string) {
    if (key === 'sessionController') return { async resolveAgent(id: string) {
      assert.equal(id, 'session-1')
      return { agent: { session: { requestHeader: () => ({ config: { provider: 'test', model } }) } } }
    } }
    if (key === 'llm') return { async resolveModelInfo(provider: string, name: string) {
      checked++
      assert.equal(provider, 'test')
      return { inputModalities: name === 'vision' ? ['text', 'image'] : ['text'] }
    } }
    return undefined
  } } as never)
  const service = new HostImageUnderstandingService(() => 'session-vision')
  service.register(backend)
  try {
    assert.deepEqual(await service.availability('session-1', request().signal),
      { status: 'unavailable', reason: 'The current session model does not declare image input.' })
    await assert.rejects(service.prepare(request()), (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/image-unavailable')
    model = 'vision'
    assert.deepEqual(await service.availability('session-1', request().signal),
      { status: 'available', kind: 'direct-image', backendId: 'session-vision' })
    assert.deepEqual(await service.prepare(request()), { kind: 'direct-image', backendId: 'session-vision',
      provenance: { backendId: 'session-vision', mode: 'session-vision' } })
    assert.ok(checked >= 4)
  } finally { service.dispose() }
})

test('selected backend registration is scoped, and removal aborts in-flight preparation', async () => {
  const service = new HostImageUnderstandingService(() => 'community-description')
  let started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  const backend: ImageUnderstandingBackend = {
    id: 'community-description', kind: 'derived-text',
    async availability() { return { available: true } },
    async prepare() { started(); return new Promise<never>(() => undefined) },
  }
  const unregister = service.register(backend)
  assert.deepEqual(service.list().map(({ id, kind }) => ({ id, kind })), [{ id: 'community-description', kind: 'derived-text' }])
  try {
    const pending = service.prepare(request())
    await began
    unregister()
    await assert.rejects(pending, (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/image-unavailable')
    assert.deepEqual(service.list(), [])
    assert.equal((await service.availability('session-1', request().signal)).status, 'unavailable')
  } finally { service.dispose() }
})

test('backend output is bounded and a selected unavailable backend does not silently fall back', async () => {
  const service = new HostImageUnderstandingService(() => 'community-description')
  service.register({ id: 'session-vision', kind: 'direct-image',
    async availability() { return { available: true } },
    async prepare() { return { kind: 'direct-image', mode: 'session-vision' } } })
  assert.deepEqual(await service.availability('session-1', request().signal), {
    status: 'unavailable', reason: 'The selected image backend is not installed.',
  })
  service.register({ id: 'community-description', kind: 'derived-text',
    async availability() { return { available: true } },
    async prepare() { return { kind: 'derived-text', mode: 'image-description', text: 'x'.repeat(32_769) } },
  })
  try {
    await assert.rejects(service.prepare(request()), (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/image-invalid-result')
  } finally { service.dispose() }
})

test('OCR text backend is explicit and reports that it cannot interpret diagrams', async () => {
  const ocr = new HostOcrService(() => 'local-ocr')
  const output: OcrOutput = { text: 'A visible label', blocks: [], lines: [], words: [], confidence: null,
    status: 'complete', coverage: [], warnings: [] }
  ocr.register({
    descriptor: { id: 'local-ocr', name: 'Local OCR', version: '1', execution: 'local', geometry: [], confidence: false },
    async availability() { return { status: 'available' } },
    async recognize(input) { assert.equal(input.mediaType, 'image/png'); return output },
  })
  const service = new HostImageUnderstandingService(() => 'ocr-text')
  service.register(createOcrTextBackend({ get: (key: string) => key === 'ocr' ? ocr : undefined } as never))
  try {
    assert.deepEqual(await service.availability('session-1', request().signal), {
      status: 'available', kind: 'derived-text', backendId: 'ocr-text',
      limitation: 'OCR extracts visible text only; diagrams and layout are not understood.',
    })
    assert.deepEqual(await service.prepare(request()), { kind: 'derived-text', text: 'A visible label',
      provenance: { backendId: 'ocr-text', mode: 'ocr-text' },
      limitations: 'OCR extracts visible text only; visual structure and diagrams may be missing.' })
  } finally { service.dispose(); ocr.dispose() }
})

test('authenticated image dispatch rejects mismatched sessions, malformed image data, and spoofed dimensions', async () => {
  const service = new HostImageUnderstandingService(() => 'test')
  service.register({ id: 'test', kind: 'direct-image', async availability() { return { available: true } },
    async prepare() { return { kind: 'direct-image', mode: 'session-vision' } } })
  const dispatch = createImageUnderstandingDispatch(service)
  const data = Buffer.from(png()).toString('base64')
  const input = { action: 'prepare', sessionId: 'session-1', image: {
    mediaType: 'image/png', data, width: 12, height: 9 }, question: 'Explain.' }
  try {
    await assert.rejects(dispatch('session-2', input, agent, request().signal), (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/session-mismatch')
    await assert.rejects(dispatch('session-1', { ...input, image: { ...input.image, data: `${data} ` } },
      agent, request().signal), (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/image-invalid-request')
    await assert.rejects(dispatch('session-1', { ...input, image: { ...input.image, height: 10 } },
      agent, request().signal), (error: unknown) =>
      error instanceof ImageUnderstandingError && error.code === 'pdf/image-invalid-request')
    assert.equal((await dispatch('session-1', input, agent, request().signal) as { kind: string }).kind, 'direct-image')
  } finally { service.dispose() }
})

const imageRefId = 'pdfref_00000000-0000-0000-0000-000000000001'

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

test('reference preparation sends only Host-verified image bytes for a vision model', async () => {
  const source = verifiedReference()
  const resolutions: string[] = []
  const resolver: PdfImageEvidenceResolver = { async resolve(sessionId, documentId, refId) {
    assert.equal(sessionId, 'session-1')
    assert.equal(documentId, 'document-1')
    resolutions.push(refId)
    return source
  } }
  const service = new HostImageUnderstandingService(() => 'session-vision')
  let received: Uint8Array | undefined
  service.register({ id: 'session-vision', kind: 'direct-image',
    async availability() { return { available: true } },
    async prepare(input) { received = input.image.data; return { kind: 'direct-image', mode: 'session-vision' } },
  })
  const dispatch = createImageUnderstandingDispatch(service, resolver)
  const input = { action: 'prepare-reference', sessionId: 'session-1', documentId: 'document-1',
    refId: imageRefId, question: 'Explain this region.' }
  try {
    const result = await dispatch('session-1', input, agent, request().signal) as {
      value: { kind: string; requestedRefId: string; evidence: { refId: string }; bytes: null }
      bytes: Uint8Array; mime: string
    }
    assert.deepEqual(resolutions, [imageRefId, imageRefId])
    assert.equal(result.value.kind, 'direct-image')
    assert.equal(result.value.requestedRefId, imageRefId)
    assert.equal(result.value.evidence.refId, imageRefId)
    assert.equal(result.value.bytes, null)
    assert.equal(result.mime, 'image/png')
    assert.deepEqual(result.bytes, source.image.data)
    assert.deepEqual(received, source.image.data)
    assert.notEqual(received, source.image.data, 'backends receive an independent image copy')
  } finally { service.dispose() }
})

test('reference preparation fails closed for missing, foreign, mutated, stale, or text-only image evidence', async () => {
  const input = { action: 'prepare-reference', sessionId: 'session-1', documentId: 'document-1',
    refId: imageRefId, question: 'Explain this region.' }
  const signal = request().signal
  const service = new HostImageUnderstandingService(() => 'test')
  let visual = true
  service.register({ id: 'test', kind: 'direct-image',
    async availability() { return visual ? { available: true } : { available: false, reason: 'No image input.' } },
    async prepare() { return { kind: 'direct-image', mode: 'session-vision' } },
  })
  const valid = verifiedReference()
  let selected = valid
  let calls = 0
  const resolver: PdfImageEvidenceResolver = { async resolve() { calls++; return selected } }
  const dispatch = createImageUnderstandingDispatch(service, resolver)
  try {
    await assert.rejects(createImageUnderstandingDispatch(service)('session-1', input, agent, signal),
      (error: unknown) => error instanceof ImageUnderstandingError && error.code === 'pdf/reference-unavailable')
    await assert.rejects(dispatch('session-2', input, agent, signal),
      (error: unknown) => error instanceof ImageUnderstandingError && error.code === 'pdf/session-mismatch')
    await assert.rejects(dispatch('session-1', { ...input, refId: 'bad' }, agent, signal),
      (error: unknown) => error instanceof ImageUnderstandingError && error.code === 'pdf/image-invalid-request')
    await assert.rejects(dispatch('session-1', { ...input, image: { data: 'client-controlled' } }, agent, signal),
      (error: unknown) => error instanceof ImageUnderstandingError && error.code === 'pdf/image-invalid-request')
    assert.equal(calls, 0)
    selected = { ...valid, evidence: { ...valid.evidence, documentId: 'other-document' } }
    await assert.rejects(dispatch('session-1', input, agent, signal),
      (error: unknown) => error instanceof ImageUnderstandingError && error.code === 'pdf/reference-unavailable')
    selected = { ...valid, image: { ...valid.image, data: png(12, 10) } }
    await assert.rejects(dispatch('session-1', input, agent, signal),
      (error: unknown) => error instanceof ImageUnderstandingError && error.code === 'pdf/reference-unavailable')
    selected = valid
    visual = false
    await assert.rejects(dispatch('session-1', input, agent, signal),
      (error: unknown) => error instanceof ImageUnderstandingError && error.code === 'pdf/image-unavailable')
  } finally { service.dispose() }
})

test('reference preparation returns text, not pixels, from an explicitly selected OCR backend', async () => {
  const source = verifiedReference()
  const service = new HostImageUnderstandingService(() => 'ocr-text')
  service.register({ id: 'ocr-text', kind: 'derived-text',
    async availability() { return { available: true } },
    async prepare(input) {
      assert.deepEqual(input.image.data, source.image.data)
      return { kind: 'derived-text', mode: 'ocr-text', text: 'Recognized words' }
    },
  })
  const resolver: PdfImageEvidenceResolver = { async resolve() { return source } }
  try {
    const result = await createImageUnderstandingDispatch(service, resolver)('session-1', {
      action: 'prepare-reference', sessionId: 'session-1', documentId: 'document-1',
      refId: imageRefId, question: 'Read this.' }, agent, request().signal) as {
      kind: string; text: string; evidence: { refId: string }; bytes?: Uint8Array
    }
    assert.equal(result.kind, 'derived-text')
    assert.equal(result.text, 'Recognized words')
    assert.equal(result.evidence.refId, imageRefId)
    assert.equal(result.bytes, undefined)
  } finally { service.dispose() }
})

test('reference preparation revalidates after asynchronous backend work', async () => {
  const first = verifiedReference()
  const nextData = png(12, 9)
  nextData[8] = 42
  const digest = evidenceSha256(nextData)
  const next = { ...first, image: { ...first.image, data: nextData }, evidence: {
    ...first.evidence, refId: 'pdfref_00000000-0000-0000-0000-000000000002' as const,
    renderedImageSha256: digest, snapshot: { ...first.evidence.snapshot,
      attachmentId: digest, storedImageSha256: digest },
  } }
  let calls = 0
  const resolver: PdfImageEvidenceResolver = { async resolve() { return ++calls === 1 ? first : next } }
  const service = new HostImageUnderstandingService(() => 'test')
  service.register({ id: 'test', kind: 'direct-image', async availability() { return { available: true } },
    async prepare() { return { kind: 'direct-image', mode: 'session-vision' } } })
  try {
    await assert.rejects(createImageUnderstandingDispatch(service, resolver)('session-1', {
      action: 'prepare-reference', sessionId: 'session-1', documentId: 'document-1',
      refId: imageRefId, question: 'Explain.' }, agent, request().signal),
    (error: unknown) => error instanceof ImageUnderstandingError && error.code === 'pdf/stale-reader')
    assert.equal(calls, 2)
  } finally { service.dispose() }
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

test('reference image RPC transports the attested PNG as binary, not a Base64 JSON field', async () => {
  const source = verifiedReference()
  const resolver: PdfImageEvidenceResolver = { async resolve() { return source } }
  const service = new HostImageUnderstandingService(() => 'vision')
  service.register({ id: 'vision', kind: 'direct-image',
    async availability() { return { available: true } },
    async prepare() { return { kind: 'direct-image', mode: 'session-vision' } },
  })
  let route: { fetch(request: Request): Promise<Response> } | undefined
  const ctx = {
    connection: { fetch: { register(value: typeof route) { route = value; return async () => {} } } },
    sessionController: { async resolveAgent() { return { agent } } },
  }
  const dispose = registerPdfTransport(ctx as never,
    createImageUnderstandingDispatch(service, resolver), { endpoint: 'pdf.image', maxRequestBytes: 4096 })
  try {
    const response = await route!.fetch(new Request('https://example.test/api/pdf.image', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method: 'pdf.image', rpcId: 'test-ref',
        payload: { action: 'prepare-reference', sessionId: 'session-1', documentId: 'document-1',
          refId: imageRefId, question: 'Explain.' } }),
    }))
    assert.equal(response.status, 200)
    const form = await response.formData()
    const envelope = JSON.parse(form.get('metadata') as string) as {
      result: { ok: boolean; value: { evidence: { refId: string }; bytes: null } }
    }
    assert.equal(envelope.result.ok, true)
    assert.equal(envelope.result.value.evidence.refId, imageRefId)
    assert.equal(envelope.result.value.bytes, null)
    assert.deepEqual(new Uint8Array(await (form.get('pdf-bytes') as Blob).arrayBuffer()), source.image.data)
  } finally { await dispose(); service.dispose() }
})
