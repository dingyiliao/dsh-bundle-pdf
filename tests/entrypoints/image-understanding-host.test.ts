import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config, inject, name, provide } from '../../src/entrypoints/image-understanding-host.ts'
import type { HostImageUnderstandingService } from '../../src/modules/image-understanding/index.js'
import { registerPdfTransport } from '../../src/adapters/host/dsh/transport.ts'
import { evidenceSha256 } from '../../src/modules/evidence/index.ts'

type Route = Parameters<Parameters<typeof registerPdfTransport>[0]['connection']['fetch']['register']>[0]

test('image understanding plugin provides one service, three backends, and an authenticated route', async () => {
  const effects: { label: string; dispose: () => void | Promise<void> }[] = []
  const routes = new Map<string, Route>()
  const removed: string[] = []
  let provided: HostImageUnderstandingService | undefined
  const ctx = {
    reflect: { provide(key: string, value: HostImageUnderstandingService) {
      assert.equal(key, 'imageUnderstanding')
      provided = value
    } },
    effect(callback: () => () => void | Promise<void>, label: string) {
      effects.push({ label, dispose: callback() })
    },
    get() { return undefined },
    connection: { fetch: { register(route: Route) {
      assert.equal(routes.has(route.path), false)
      routes.set(route.path, route)
      return async () => { routes.delete(route.path); removed.push(route.path) }
    } } },
    sessionController: { async resolveAgent(sessionId: string) {
      return { agent: { session: { id: sessionId, header: {} } } }
    } },
  } as unknown as Context

  assert.equal(name, 'image-understanding')
  assert.equal(provide, 'imageUnderstanding')
  assert.deepEqual(inject, ['connection', 'sessionController'])
  apply(ctx, Config.parse({ backend: 'ocr-text', auxiliaryVision: {
    provider: 'test-provider', model: 'test-model', maxOutputTokens: 100,
  } }))
  assert.ok(provided)
  const service = provided
  try {
    assert.deepEqual(service.list(), [
      { id: 'session-vision', kind: 'direct-image' },
      { id: 'ocr-text', kind: 'derived-text' },
      { id: 'auxiliary-vision', kind: 'derived-text' },
    ])
    assert.deepEqual(effects.map(effect => effect.label), [
      'image-understanding: dispose requests',
      'image-understanding: session vision backend',
      'image-understanding: OCR text backend',
      'image-understanding: optional auxiliary vision backend',
      'image-understanding: authenticated PDF image route',
    ])
    const route = routes.get('/api/pdf.image')
    assert.ok(route)
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'streaming')
    const response = await route.fetch(new Request('https://example.test/api/pdf.image', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method: 'pdf.image', rpcId: 'availability',
        payload: { action: 'availability', sessionId: 'session-1' } }),
    }))
    assert.equal(response.status, 200)
    const envelope = await response.json() as { result: { ok: boolean; value?: { status: string; reason?: string } } }
    assert.equal(envelope.result.ok, true)
    assert.deepEqual(envelope.result.value, { status: 'unavailable', reason: 'The OCR plugin is not installed.' })
  } finally {
    for (const effect of effects.reverse()) await effect.dispose()
  }
  assert.deepEqual(removed, ['/api/pdf.image'])
  assert.equal(routes.size, 0)
  assert.deepEqual(service.list(), [])
  assert.equal((await service.availability('session-1', new AbortController().signal)).status, 'unavailable')
})

test('image service and RPC route unload with their real Cordis Fiber', async () => {
  const root = new Context()
  const routes = new Map<string, Route>()
  root.reflect.provide('connection', { fetch: { register(route: Route) {
    routes.set(route.path, route)
    return async () => { routes.delete(route.path) }
  } } })
  root.reflect.provide('sessionController', { async resolveAgent() {
    return { error: new Error('No agent in this fixture') }
  } })
  try {
    const fiber = root.plugin({ name, provide, inject, Config, apply }, Config.parse({}))
    await fiber
    const service = root.get('imageUnderstanding')
    assert.ok(service)
    assert.equal(service.list().length, 3)
    assert.ok(routes.has('/api/pdf.image'))

    await fiber.dispose()
    assert.equal(root.get('imageUnderstanding'), undefined)
    assert.deepEqual(service.list(), [])
    assert.equal(routes.size, 0)
  } finally { await root.fiber.dispose() }
})

test('image references are resolved per request, so the reader may load after image understanding', async () => {
  const root = new Context()
  const routes = new Map<string, Route>()
  root.reflect.provide('connection', { fetch: { register(route: Route) {
    routes.set(route.path, route)
    return async () => { routes.delete(route.path) }
  } } })
  root.reflect.provide('sessionController', { async resolveAgent(sessionId: string) {
    return { agent: { session: { id: sessionId, header: {} } } }
  } })
  root.reflect.provide('ocr', {
    async availability() { return { status: 'available' as const, backendId: 'test-ocr' } },
    async recognize() { return { status: 'ok' as const, text: 'Recognized from Host image' } },
  })
  const image = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
  const imageDigest = evidenceSha256(image)
  const evidence = {
    refId: 'pdfref_00000000-0000-4000-8000-000000000001', documentId: 'doc-1',
    sourcePath: '/tmp/test.pdf', sourceDigest: `sha256:${'a'.repeat(64)}`, sourceVersion: 'source-1',
    contentVersion: 'content-1', revision: 1, page: 1, source: 'direct-image' as const,
    renderedImageSha256: imageDigest,
    locator: { kind: 'pdf-region' as const, rectPdf: [0, 0, 10, 10] as [number, number, number, number] },
    precision: 'approximate-geometry' as const, limitations: [],
    snapshot: { kind: 'attachment' as const, attachmentId: 'attachment-1', mediaType: 'image/png' as const,
      bytes: image.byteLength, width: 1, height: 1 },
  }
  const resolver = { async resolve() { return {
    image: { mediaType: 'image/png' as const, data: image, width: 1, height: 1 }, evidence,
  } } }
  const fiber = root.plugin({ name, provide, inject, Config, apply }, Config.parse({ backend: 'ocr-text' }))
  try {
    await fiber
    const route = routes.get('/api/pdf.image')
    assert.ok(route)
    const prepare = () => route.fetch(new Request('https://example.test/api/pdf.image', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method: 'pdf.image', rpcId: 'reference',
        payload: { action: 'prepare-reference', sessionId: 'session-1', documentId: 'doc-1',
          refId: evidence.refId, question: 'Read this region.' } }),
    }))
    const missing = await prepare()
    const missingBody = await missing.json() as { result: { ok: boolean; error?: { code: string } } }
    assert.equal(missingBody.result.ok, false)
    assert.equal(missingBody.result.error?.code, 'pdf/reference-unavailable')

    // The reader plugin provides this capability later; the image route must
    // look it up on the next request instead of capturing a startup snapshot.
    const release = root.reflect.provide('pdfImageEvidence', resolver)
    const provided = await prepare()
    const providedBody = await provided.json() as { result: { ok: boolean; value?: { kind: string; text: string } } }
    assert.equal(providedBody.result.ok, true)
    assert.equal(providedBody.result.value?.kind, 'derived-text')
    assert.equal(providedBody.result.value?.text, 'Recognized from Host image')
    await release?.()
    const removed = await prepare()
    const removedBody = await removed.json() as { result: { error?: { code: string } } }
    assert.equal(removedBody.result.error?.code, 'pdf/reference-unavailable')
  } finally {
    await fiber.dispose()
    await root.fiber.dispose()
  }
})
