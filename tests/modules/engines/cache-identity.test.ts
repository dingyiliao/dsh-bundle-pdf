import assert from 'node:assert/strict'
import test from 'node:test'
import { HostOcrService, type HostOcrBackend } from '../../../src/modules/ocr/index.js'
import { HostImageUnderstandingService, type ImageUnderstandingBackend } from '../../../src/modules/image-understanding/index.js'
import { canonicalEngineJson, engineCacheIdentity } from '../../../src/modules/engines/index.js'

const signal = new AbortController().signal
const descriptor = { id: 'fixture', name: 'Fixture', version: '1', execution: 'local' as const,
  configurationFields: [{ key: 'language', label: 'Language', type: 'string' as const },
    { key: 'style', label: 'Style', type: 'string' as const }] }
const ocr = (identity?: HostOcrBackend['cacheIdentity']): HostOcrBackend => ({
  descriptor: { ...descriptor, geometry: [], confidence: false }, cacheIdentity: identity,
  async availability() { return { status: 'available' } },
  async recognize() { return { text: '', blocks: [], words: [], lines: [], coverage: [], warnings: [], status: 'complete', confidence: null } },
})
const image = (identity?: ImageUnderstandingBackend['cacheIdentity']): ImageUnderstandingBackend => ({
  descriptor, cacheIdentity: identity,
  async availability() { return { available: true } },
  async understand() { return { text: 'Figure' } },
})

for (const kind of ['ocr', 'image'] as const) {
  const create = () => kind === 'ocr' ? new HostOcrService(() => 'fixture') : new HostImageUnderstandingService(() => 'fixture')
  const register = (service: ReturnType<typeof create>, identity?: HostOcrBackend['cacheIdentity']) =>
    kind === 'ocr' ? (service as HostOcrService).register(ocr(identity)) : (service as HostImageUnderstandingService).register(image(identity))

  test(`${kind} persistent identity hashes canonical config and model metadata; registration generation is separate`, async () => {
    const first = create(), second = create()
    let model = 'revision-one'
    const stop = register(first, async () => model)
    register(second, async () => model)
    const a = { engineId: 'fixture', config: { language: 'eng', style: 'plain' } }
    const b = { engineId: 'fixture', config: { style: 'plain', language: 'eng' } }
    try {
      const original = await first.cacheIdentity('session-a', signal, a)
      const canonical = await first.cacheIdentity('session-b', signal, b)
      const restart = await second.cacheIdentity('session-a', signal, a)
      assert.equal(original.reusable, true)
      assert.equal(original.fingerprint, canonical.fingerprint)
      assert.equal(original.fingerprint, restart.fingerprint)
      assert.equal(original.generation, first.generation(a))
      assert.notEqual(original.generation, restart.generation)
      assert.notEqual(original.fingerprint, (await first.cacheIdentity('session-a', signal,
        { ...a, config: { ...a.config, language: 'chi_sim' } })).fingerprint)
      model = 'revision-two'
      assert.notEqual(original.fingerprint, (await first.cacheIdentity('session-a', signal, a)).fingerprint)
      stop()
      assert.equal(first.generation(), undefined)
      register(first, async () => model)
      assert.notEqual(original.generation, first.generation())
    } finally { first.dispose(); second.dispose() }
  })

  test(`${kind} unknown cache identity is limited to one session and registration lifetime`, async () => {
    const service = create(), other = create()
    const stop = register(service)
    register(other)
    try {
      const original = await service.cacheIdentity('session-a', signal)
      assert.equal(original.reusable, false)
      assert.equal(original.fingerprint, (await service.cacheIdentity('session-a', signal)).fingerprint)
      assert.notEqual(original.fingerprint, (await service.cacheIdentity('session-b', signal)).fingerprint)
      assert.notEqual(original.fingerprint, (await other.cacheIdentity('session-a', signal)).fingerprint)
      stop(); register(service)
      assert.notEqual(original.fingerprint, (await service.cacheIdentity('session-a', signal)).fingerprint)
    } finally { service.dispose(); other.dispose() }
  })

  test(`${kind} pending identity resolution is revoked when its backend unloads`, async () => {
    const service = create()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const stop = register(service, async () => { entered(); return new Promise(() => undefined) })
    try {
      const pending = service.cacheIdentity('session-a', signal)
      await started
      stop()
      await assert.rejects(pending, { code: kind === 'ocr' ? 'engine-unavailable' : 'pdf/image-unavailable' })
      await assert.rejects(service.cacheIdentity('session-a', signal),
        { code: kind === 'ocr' ? 'engine-unavailable' : 'pdf/image-unavailable' })
    } finally { service.dispose() }
  })
}

test('canonical configuration hashes sort keys recursively while preserving list order', () => {
  assert.equal(canonicalEngineJson({ b: { y: 2, x: 1 }, a: [3, { b: false, a: null }] }),
    canonicalEngineJson({ a: [3, { a: null, b: false }], b: { x: 1, y: 2 } }))
  assert.notEqual(canonicalEngineJson([1, 2]), canonicalEngineJson([2, 1]))
})


test('shared engine identity accepts a caller-provided platform hash through the public SDK', () => {
  const inputs: string[] = []
  const result = engineCacheIdentity(descriptor, { style: 'plain', language: 'eng' }, 'registration', 'session',
    'model-revision', canonical => { inputs.push(canonical); return 'platform-hash' })
  assert.equal(result.fingerprint, 'platform-hash')
  assert.deepEqual(JSON.parse(inputs[0]!), { backendId: 'fixture', backendVersion: '1',
    capabilities: null, config: { language: 'eng', style: 'plain' }, context: null, identity: 'model-revision' })
  assert.equal(result.reusable, true)
})

test('invalid contributed cache identities are rejected before invoking the platform hash', () => {
  let hashCalls = 0
  for (const identity of ['', '   ', 'x'.repeat(16_385), { identity: '', reusable: false as const }]) {
    assert.throws(() => engineCacheIdentity(descriptor, {}, 'registration', 'session', identity,
      () => { hashCalls++; return 'must-not-be-used' }), /The engine returned an invalid cache identity/)
  }
  assert.equal(hashCalls, 0, 'invalid identity metadata must never become a usable cache fingerprint')
})

test('engine capability changes invalidate durable cache identity while capability order is immaterial', () => {
  const fingerprint = (capabilities?: Array<'ocr-text' | 'image-description'>) => engineCacheIdentity(
    { ...descriptor, capabilities }, {}, 'registration', 'session', 'model-revision', value => value).fingerprint
  assert.notEqual(fingerprint(), fingerprint(['image-description']))
  assert.notEqual(fingerprint(['ocr-text']), fingerprint(['image-description']))
  assert.equal(fingerprint(['ocr-text', 'image-description']), fingerprint(['image-description', 'ocr-text']))
})
