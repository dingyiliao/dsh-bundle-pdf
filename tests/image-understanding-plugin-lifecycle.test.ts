import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply, Config, inject, name, provide } from '../src/host/image-understanding-plugin.ts'
import type { HostImageUnderstandingService } from '../src/host/image-understanding-service.ts'
import { registerPdfTransport } from '../src/host/transport.ts'

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
