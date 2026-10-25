import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { EngineCatalog, EngineDirectory, engineProbe, validateEngineConfiguration, engineBinding,
  engineConfigurationsSchema, engineConfigurationSchema } from '../../../src/modules/engines/index.ts'
import { HostOcrService, type HostOcrRequest } from '../../../src/modules/ocr/index.ts'
import { TranslationRegistry } from '../../../src/translation/index.ts'
import type { OcrOutput } from '../../../src/ocr/types.ts'

const descriptor = { id: 'fixture.ocr', name: 'Fixture OCR', version: '1', execution: 'local' as const,
  geometry: [] as const, confidence: false }
const output: OcrOutput = { text: 'Synthetic text', blocks: [], lines: [], words: [], confidence: null,
  coverage: [], status: 'complete', warnings: [] }
const request: HostOcrRequest = { sessionId: 'fixture-session', image: new Uint8Array([1]), mediaType: 'image/png',
  width: 1, height: 1, languages: ['auto'] }

test('catalog observes the authoritative directory, unloads and successor registrations without copying implementations', async () => {
  const directory = new EngineDirectory<{ descriptor: typeof descriptor }>(value => value.descriptor)
  const catalog = new EngineCatalog(), stop = catalog.attach('ocr', directory)
  let notices = 0
  const unsubscribe = catalog.subscribe(() => { notices++ })
  const before = catalog.read()
  const waiting = catalog.wait(before.revision, new AbortController().signal)
  const remove = directory.register({ descriptor })
  assert.equal((await waiting).engines.ocr[0]?.id, descriptor.id)
  const snapshot = catalog.read()
  snapshot.engines.ocr[0]!.name = 'External edit'
  assert.equal(catalog.read().engines.ocr[0]?.name, descriptor.name)
  assert.throws(() => directory.register({ descriptor }), /already registered/)
  remove()
  const successor = directory.register({ descriptor: { ...descriptor, version: '2' } })
  remove()
  assert.equal(catalog.read().engines.ocr[0]?.version, '2')
  successor(); stop(); unsubscribe()
  assert.ok(notices >= 4)
  assert.equal(catalog.read().engines.ocr.length, 0)
  const controller = new AbortController(), pending = catalog.wait(catalog.read().revision, controller.signal)
  controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
  const unloaded = catalog.wait(catalog.read().revision, new AbortController().signal)
  catalog.dispose()
  await assert.rejects(unloaded, /disposed/)
  directory.dispose()
})

test('real Cordis contributor Fiber registers dynamically and aborts only its own OCR tasks when unloaded', async () => {
  const root = new Context(), service = new HostOcrService(() => descriptor.id), catalog = new EngineCatalog()
  root.reflect.provide('ocr', service)
  catalog.attach('ocr', service)
  let started!: () => void, requestSignal: AbortSignal | undefined
  const entered = new Promise<void>(resolve => { started = resolve })
  const fiber = root.plugin({ inject: ['ocr'], apply(ctx: Context) {
    ctx.effect(() => ctx.ocr.register({ descriptor, async availability() { return { status: 'available' } },
      async recognize(input) { requestSignal = input.signal; started(); return new Promise<OcrOutput>(() => {}) } }))
  } })
  try {
    await fiber
    assert.equal(catalog.read().engines.ocr[0]?.id, descriptor.id)
    const pending = service.recognize(request)
    await entered
    const updated = catalog.wait(catalog.read().revision, new AbortController().signal)
    await fiber.dispose()
    await assert.rejects(pending, { code: 'engine-unavailable' })
    assert.equal(requestSignal?.aborted, true)
    assert.equal((await updated).engines.ocr.length, 0)
    await assert.rejects(service.recognize(request), { code: 'engine-unavailable' })
    assert.equal(service.selectedDescriptor(), undefined)
    // Same ID may return; old disposers cannot remove it, and it is not a fallback.
    service.register({ descriptor, async availability() { return { status: 'available' } }, async recognize() { return output } })
    assert.equal((await service.recognize(request)).text, output.text)
  } finally { await fiber.dispose(); service.dispose(); catalog.dispose(); await root.fiber.dispose() }
})

test('OCR captures per-consumer configuration and cancels a hanging availability probe on unregister', async () => {
  const service = new HostOcrService(() => descriptor.id)
  const seen: unknown[] = []
  const remove = service.register({ descriptor: { ...descriptor, configurationFields: [{ key: 'language', label: 'Language', type: 'string' }] },
    async availability() { return { status: 'available' } }, async recognize(_request, config) { seen.push(config); return output } })
  try {
    await assert.rejects(service.recognize({ ...request, binding: { engineId: descriptor.id, config: { unknown: 'fixture' } } }),
      { code: 'not-configured' })
    const binding = { engineId: descriptor.id, config: { language: 'en' } }
    const first = service.recognize({ ...request, binding })
    binding.config.language = 'fr'
    await Promise.all([first, service.recognize({ ...request, binding })])
    assert.deepEqual(seen, [{ language: 'en' }, { language: 'fr' }])
    remove()
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const stop = service.register({ descriptor, async availability() { started(); return new Promise(() => {}) },
      async recognize() { return output } })
    const probe = service.availability('fixture-session')
    await entered; stop()
    assert.equal((await probe).status, 'unavailable')
  } finally { service.dispose() }
})

test('OCR availability fences every completion/unregister microtask interleaving', async () => {
  const statuses: string[] = []
  for (let turns = 0; turns < 8; turns++) {
    const service = new HostOcrService(() => descriptor.id)
    let complete!: (value: { status: 'available' }) => void
    const gate = new Promise<{ status: 'available' }>(resolve => { complete = resolve })
    const remove = service.register({ descriptor, availability: () => gate, async recognize() { return output } })
    try {
      const pending = service.availability('fixture-session')
      complete({ status: 'available' })
      for (let index = 0; index < turns; index++) await Promise.resolve()
      remove()
      const result = await pending
      statuses.push(result.status)
      assert.ok(result.status === 'available' || result.status === 'unavailable')
      assert.equal((await service.availability('fixture-session')).status, 'unavailable')
    } finally { service.dispose() }
  }
  assert.ok(statuses.includes('available'), 'a completed pre-unload observation remains valid')
  assert.ok(statuses.includes('unavailable'), 'an in-flight observation cannot keep a removed provider available')
})

test('translation per-request instances do not replace another consumer selection or cancel its work', async () => {
  const registry = new TranslationRegistry({ timeoutMs: 1000, maxInputCharacters: 100, maxOutputCharacters: 100 })
  registry.register({ descriptor: { ...descriptor, id: 'fixture.translation' }, async translate(_request, config) {
    return { text: String(config.language), status: 'complete', warnings: [] }
  } })
  const make = (language: string) => ({ id: language, engineId: 'fixture.translation', configurationRevision: language, config: { language } })
  registry.select(make('default'))
  try {
    const input = { text: 'Fixture', targetLanguage: 'zh' }
    const results = await Promise.all([registry.translate(input, make('a')), registry.translate(input, make('b'))])
    assert.deepEqual(results.map(result => result.text), ['a', 'b'])
    assert.equal(registry.getSelection()?.id, 'default')
  } finally { registry.dispose() }
})

test('contributor configuration is bounded, type checked and declared; bindings never expose implementation functions', () => {
  const configured = { ...descriptor, configurationFields: [{ key: 'endpoint', label: 'Endpoint', type: 'string' as const, required: true },
    { key: 'enabled', label: 'Enabled', type: 'boolean' as const }] }
  assert.throws(() => validateEngineConfiguration(configured, {}), /requires/)
  assert.throws(() => validateEngineConfiguration(configured, { endpoint: 'test', enabled: 'true' }), /Invalid/)
  assert.throws(() => validateEngineConfiguration(configured, { endpoint: 'test', apiKey: 'not-a-real-secret' }), /Unknown/)
  assert.deepEqual(validateEngineConfiguration(configured, { endpoint: 'test', enabled: false }), { endpoint: 'test', enabled: false })
  assert.deepEqual(engineBinding('ocr', descriptor.id, { ocr: { [descriptor.id]: { endpoint: 'test' } } }),
    { engineId: descriptor.id, config: { endpoint: 'test' } })
  const secret = { ...descriptor, configurationFields: [{ key: 'credential', label: 'Credential reference', type: 'secret-reference' as const }] }
  assert.throws(() => validateEngineConfiguration(secret, { credential: 'invalid ref with spaces' }), /reference/)
  assert.deepEqual(validateEngineConfiguration(secret, { credential: 'fixture.reference' }), { credential: 'fixture.reference' })
  assert.throws(() => engineConfigurationSchema.parse({ a: 'x'.repeat(8192), b: 'x'.repeat(8192), c: 'x' }), /limit/)
  assert.throws(() => engineConfigurationsSchema.parse({ ocr: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [String(index), {}])) }), /Too many/)
  assert.throws(() => engineConfigurationsSchema.parse({ ocr: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index), { x: 'x'.repeat(8000) }])) }), /limit/)
})

test('directory validates metadata, bounds providers and isolates observers and disposal failures', () => {
  const directory = new EngineDirectory<{ descriptor: typeof descriptor & { configurationFields?: Array<{ key: string; label: string; type: 'string' }> } }>(value => value.descriptor)
  const stop = directory.subscribe(() => { throw new Error('Observer failed') })
  const remove = directory.register({ descriptor }, () => { throw new Error('Cleanup failed') })
  assert.equal(directory.has(descriptor.id), true)
  assert.equal(directory.get(descriptor.id)?.descriptor.id, descriptor.id)
  assert.equal(directory.descriptor('missing'), undefined)
  assert.equal(directory.list()[0]?.id, descriptor.id)
  assert.throws(remove, /Cleanup failed/)
  remove()
  assert.equal(directory.has(descriptor.id), false)
  const field = { key: 'key', label: 'Field', type: 'string' as const }
  assert.throws(() => directory.register({ descriptor: { ...descriptor, configurationFields: [field, field] } }), /Duplicate/)
  for (let index = 0; index < 128; index++) directory.register({ descriptor: { ...descriptor, id: `fixture.${index}` } })
  assert.throws(() => directory.register({ descriptor: { ...descriptor, id: 'fixture.overflow' } }), /limit/)
  stop(); directory.dispose()
  assert.throws(() => directory.register({ descriptor }), /disposed/)
  const catalog = new EngineCatalog()
  const live = new EngineDirectory<{ descriptor: typeof descriptor }>(value => value.descriptor)
  catalog.attach('ocr', live)
  assert.throws(() => catalog.attach('ocr', live), /duplicated/)
  catalog.subscribe(() => { throw new Error('Observer failed') })
  live.register({ descriptor })
  catalog.dispose(); live.dispose()
})

test('catalog long poll expires with the unchanged snapshot rather than inventing removals', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const catalog = new EngineCatalog(), before = catalog.read()
  const result = catalog.wait(before.revision, new AbortController().signal)
  t.mock.timers.tick(15_000)
  assert.deepEqual(await result, before)
  catalog.dispose()
})

test('shared probe deadline aborts non-cooperative implementations and releases all bookkeeping', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const tasks = new Map<AbortController, object>(), provider = {}
  let signal: AbortSignal | undefined
  const pending = engineProbe(tasks, provider, new AbortController().signal,
    { cancelled: () => new Error('cancelled'), timeout: () => new Error('probe timeout') }, async input => {
      signal = input; return new Promise(() => {})
    })
  const rejected = assert.rejects(pending, /probe timeout/)
  assert.equal(tasks.size, 1)
  t.mock.timers.tick(30_000)
  await rejected
  assert.equal(signal?.aborted, true)
  assert.equal(tasks.size, 0)
})
