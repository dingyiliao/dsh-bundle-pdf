import assert from 'node:assert/strict'
import test from 'node:test'
import { AttachmentId, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createPdfRegionDispatch, prepareRegionImageEvidence } from '../../../../src/adapters/host/dsh/region-evidence.ts'
import { registerPdfTransport } from '../../../../src/adapters/host/dsh/transport.ts'
import { ocrRegionRenderPlan } from '../../../../src/modules/document/index.ts'
import { createImageEvidenceRegistry, createMemoryEvidenceReferenceStore,
  evidenceSha256 } from '../../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.ts'

const signal = new AbortController().signal
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const sessionId = 'reader-session'
const documentId = 'working-copy'
const geometry = { cropBox: [50, 70, 250, 350], rotation: 90, userUnit: 2 }

function fixture() {
  let revision = 3
  let path = '/paper.pdf'
  let bytes = new Uint8Array([37, 80, 68, 70, 45, 49])
  let stored = png
  let renderCalls = 0, saved = 0
  const snapshot = (): HostWorkspaceSnapshot => ({ id: documentId, path, bytes,
    sourceVersion: 'source-1', contentVersion: 'content-1', revision, dirty: false,
    canUndo: false, canRedo: false, conflict: false,
    document: { pageCount: 1, pages: [geometry] } as unknown as HostWorkspaceSnapshot['document'] })
  const workspaces = { readSnapshot(session: string, id: string) {
    if (session !== sessionId || id !== documentId) {
      throw Object.assign(new Error('Foreign working copy'), { code: 'pdf/session-mismatch' })
    }
    return snapshot()
  } }
  const renderer: Parameters<typeof prepareRegionImageEvidence>[0] = {
    async renderOcrImage(session, id, page, region, maxEdge) {
      renderCalls++
      const current = workspaces.readSnapshot(session, id)
      if (page !== 1) throw Object.assign(new Error('Invalid page'), { code: 'pdf/invalid-page' })
      const plan = ocrRegionRenderPlan(geometry as never, region, maxEdge)
      return { snapshot: current, png: Buffer.from(png), width: 2, height: 2,
        pdfRegion: plan.pdfRegion }
    },
  }
  const digest = evidenceSha256(png)
  const image = { attachmentId: AttachmentId(digest), mediaType: 'image/png' as const,
    bytes: png.length, width: 2, height: 2 }
  const attachments = {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 16_000_000,
      maxImagesPerMessage: 10, maxMessageImageBytes: 16_000_000, maxImagePixels: 10_000_000,
      maxImageDimension: 16_384 },
    async saveImage(input: SaveImageAttachment) {
      saved++
      assert.deepEqual(Uint8Array.from(input.data), png)
      return image
    },
    async readImage() { return { ref: image, data: stored } },
  } as unknown as Parameters<typeof prepareRegionImageEvidence>[1]
  const references = createMemoryEvidenceReferenceStore()
  const registry = createImageEvidenceRegistry(workspaces, references,
    async (_session, expected) => expected.attachmentId === digest
      ? { mediaType: image.mediaType, bytes: image.bytes, width: image.width, height: image.height,
        storedImageSha256: digest }
      : undefined)
  const input = { sessionId, documentId, page: 1,
    rectPdf: [20, 90, 100, 400] as const, maxEdge: 512 }
  return { renderer, attachments, registry, references, workspaces, input, digest,
    get renderCalls() { return renderCalls }, get saved() { return saved },
    revise() { revision++ }, move() { path = '/other.pdf' },
    changeBytes() { bytes = new Uint8Array([1, 2, 3]) },
    changeStored() { stored = new Uint8Array([...png, 4]) },
  }
}

type Route = Parameters<Parameters<typeof registerPdfTransport>[0]['connection']['fetch']['register']>[0]
function installRegionRoute(state: ReturnType<typeof fixture>,
  options: { resolvedSessionId?: string; attachmentStore?: ReturnType<typeof fixture>['attachments'] | undefined } = {}) {
  let route!: Route
  const transport = {
    connection: { fetch: { register(value: Route) { route = value; return async () => undefined } } },
    sessionController: { async resolveAgent(id: string) { return {
      agent: { session: { id: options.resolvedSessionId ?? id, header: {} } },
    } } },
  }
  const context: Parameters<typeof createPdfRegionDispatch>[0] = {
    get() { return 'attachmentStore' in options ? options.attachmentStore : state.attachments },
  } as never
  registerPdfTransport(transport, createPdfRegionDispatch(context, state.workspaces,
    state.renderer, state.references), { endpoint: 'pdf.region', maxRequestBytes: 4096 })
  return route
}

function regionRequest(route: Route, payload: Record<string, unknown>): Promise<Response> {
  return route.fetch(new Request('https://example.test/api/pdf.region', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'region-1', method: 'pdf.region', payload }),
  }))
}

test('Host creates exact PNG evidence for the clipped, rotated PDF region', async () => {
  const state = fixture()
  const { evidence, image } = await prepareRegionImageEvidence(
    state.renderer, state.attachments, state.registry, state.input, signal)
  assert.equal(state.renderCalls, 1)
  assert.equal(state.saved, 1)
  assert.deepEqual(evidence.locator, { kind: 'pdf-region', rectPdf: [50, 90, 100, 350] })
  assert.equal(evidence.source, 'direct-image')
  assert.equal(evidence.precision, 'approximate-geometry')
  assert.equal(evidence.renderedImageSha256, state.digest)
  assert.equal(evidence.snapshot.kind, 'attachment')
  assert.equal(evidence.snapshot.attachmentId, String(image.attachmentId))
  assert.equal(JSON.stringify(state.references.get(evidence.refId)).includes(Buffer.from(png).toString('base64')), false)
  const replay = await state.registry.revalidate(sessionId, documentId, evidence.refId, signal,
    async (_session, snapshot) => ({ path: snapshot.path, digest: evidenceSha256(snapshot.bytes) }))
  assert.equal(replay.revalidated, false)
})

test('region preparation rejects foreign sessions and invalid, outside, or unrenderable regions', async () => {
  const state = fixture()
  await assert.rejects(prepareRegionImageEvidence(state.renderer, state.attachments, state.registry,
    { ...state.input, sessionId: 'foreign' }, signal), { code: 'pdf/session-mismatch' })
  await assert.rejects(prepareRegionImageEvidence(state.renderer, state.attachments, state.registry,
    { ...state.input, rectPdf: [260, 370, 300, 400] }, signal), { code: 'pdf/invalid-region' })
  await assert.rejects(prepareRegionImageEvidence(state.renderer, state.attachments, state.registry,
    { ...state.input, rectPdf: [100, 90, 20, 100] }, signal), { code: 'pdf/invalid-region' })
  await assert.rejects(prepareRegionImageEvidence(state.renderer, state.attachments, state.registry,
    { ...state.input, maxEdge: 200 }, signal), { code: 'pdf/invalid-render-size' })
  assert.equal(state.saved, 0)
})

test('region evidence fails closed when the attachment changes the exact PNG', async () => {
  const state = fixture()
  state.changeStored()
  await assert.rejects(prepareRegionImageEvidence(state.renderer, state.attachments, state.registry,
    state.input, signal), { code: 'pdf/attachment-unavailable' })
  assert.equal(state.saved, 1)
})

test('region evidence refuses normalization and rejects missing PNG storage before rendering', async () => {
  const state = fixture()
  const normalized = { ...state.attachments, async saveImage() {
    return { attachmentId: AttachmentId(evidenceSha256('normalized')),
      mediaType: 'image/png' as const, bytes: png.length, width: 2, height: 2 }
  } } as Parameters<typeof prepareRegionImageEvidence>[1]
  await assert.rejects(prepareRegionImageEvidence(state.renderer, normalized, state.registry,
    state.input, signal), { code: 'pdf/image-normalized' })
  const unavailable = { ...state.attachments, imageLimits: {
    ...state.attachments.imageLimits, mediaTypes: ['image/jpeg'],
  } } as Parameters<typeof prepareRegionImageEvidence>[1]
  await assert.rejects(prepareRegionImageEvidence(state.renderer, unavailable, state.registry,
    state.input, signal), { code: 'pdf/image-type-unsupported' })
  assert.equal(state.renderCalls, 1)
})

test('region evidence is not minted after its source version or path changes', async () => {
  const state = fixture()
  const attachments = { ...state.attachments, async saveImage(input: SaveImageAttachment) {
    state.revise()
    return state.attachments.saveImage(input)
  } } as Parameters<typeof prepareRegionImageEvidence>[1]
  await assert.rejects(prepareRegionImageEvidence(state.renderer, attachments, state.registry,
    state.input, signal), { code: 'pdf/stale-reader' })
  const second = fixture()
  const moved = { ...second.attachments, async saveImage(input: SaveImageAttachment) {
    second.move()
    return second.attachments.saveImage(input)
  } } as Parameters<typeof prepareRegionImageEvidence>[1]
  await assert.rejects(prepareRegionImageEvidence(second.renderer, moved, second.registry,
    second.input, signal), { code: 'pdf/stale-reader' })
  const third = fixture()
  const replaced = { ...third.attachments, async saveImage(input: SaveImageAttachment) {
    third.changeBytes()
    return third.attachments.saveImage(input)
  } } as Parameters<typeof prepareRegionImageEvidence>[1]
  await assert.rejects(prepareRegionImageEvidence(third.renderer, replaced, third.registry,
    third.input, signal), { code: 'pdf/stale-reader' })
})

test('authenticated pdf.region RPC returns exact PNG through Connection multipart and a durable ref', async () => {
  const state = fixture()
  const route = installRegionRoute(state)
  const payload = { ...state.input, expectedRevision: 3, expectedContentVersion: 'content-1' }
  const response = await regionRequest(route, payload)
  assert.match(response.headers.get('content-type') ?? '', /^multipart\/form-data/)
  const body = await response.formData()
  const metadata = JSON.parse(String(body.get('metadata'))) as { result: { ok: boolean; value: {
    refId: string; documentId: string; page: number; rectPdf: number[];
    sourceDigest: string; sourceVersion: string; contentVersion: string; revision: number;
    mediaType: string; width: number; height: number; bytes: null;
  } }; attachments: Array<{ codec: string; path: string[] }> }
  assert.equal(metadata.result.ok, true)
  assert.deepEqual(metadata.result.value.rectPdf, [50, 90, 100, 350])
  assert.equal(metadata.result.value.sourceDigest, evidenceSha256(new Uint8Array([37, 80, 68, 70, 45, 49])))
  assert.deepEqual([metadata.result.value.documentId, metadata.result.value.page,
    metadata.result.value.sourceVersion, metadata.result.value.contentVersion,
    metadata.result.value.revision, metadata.result.value.mediaType],
  ['working-copy', 1, 'source-1', 'content-1', 3, 'image/png'])
  assert.equal(metadata.result.value.bytes, null)
  assert.deepEqual(metadata.attachments, [{ codec: 'bytes', part: 'pdf-bytes', path: ['bytes'] }])
  assert.deepEqual(new Uint8Array(await (body.get('pdf-bytes') as Blob).arrayBuffer()), png)
  assert.ok(state.references.get(metadata.result.value.refId))
})

test('pdf.region denies stale requests and mismatched sessions before rendering or storing bytes', async () => {
  const state = fixture()
  const route = installRegionRoute(state)
  const payload = { ...state.input, expectedRevision: 2, expectedContentVersion: 'content-1' }
  const stale = await (await regionRequest(route, payload)).json() as { result: {
    error: { code: string }
  } }
  assert.equal(stale.result.error.code, 'pdf/stale-reader')
  assert.equal(state.renderCalls, 0)
  assert.equal(state.saved, 0)
  const foreignRoute = installRegionRoute(state, { resolvedSessionId: 'foreign-session' })
  const foreign = await (await regionRequest(foreignRoute,
    { ...payload, expectedRevision: 3 })).json() as { result: { error: { code: string } } }
  assert.equal(foreign.result.error.code, 'pdf/session-mismatch')
  assert.equal(state.renderCalls, 0)
  const unavailableRoute = installRegionRoute(state, { attachmentStore: undefined })
  const unavailable = await (await regionRequest(unavailableRoute,
    { ...payload, expectedRevision: 3 })).json() as { result: { error: { code: string } } }
  assert.equal(unavailable.result.error.code, 'pdf/attachment-unavailable')
  assert.equal(state.renderCalls, 0)
})

test('pdf.region rejects payload identity mismatch and unavailable attachment verification', async () => {
  const state = fixture()
  const dispatch = createPdfRegionDispatch({ get: () => state.attachments }, state.workspaces,
    state.renderer, state.references)
  await assert.rejects(dispatch(sessionId, { ...state.input, sessionId: 'other-session',
    expectedRevision: 3, expectedContentVersion: 'content-1' },
  { session: { id: sessionId, header: {} } }, signal), { code: 'pdf/session-mismatch' })

  let reads = 0
  const failingAttachments = { ...state.attachments, async readImage(...args: Parameters<typeof state.attachments.readImage>) {
    reads++
    if (reads === 2) throw new Error('attachment read failed during evidence attestation')
    return state.attachments.readImage(...args)
  } }
  const route = installRegionRoute(state, { attachmentStore: failingAttachments })
  const response = await regionRequest(route, { ...state.input, expectedRevision: 3,
    expectedContentVersion: 'content-1' })
  const body = await response.json() as { result: { ok: boolean; error: { code: string } } }
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'pdf/attachment-unavailable')
  assert.equal(reads, 2)
})
