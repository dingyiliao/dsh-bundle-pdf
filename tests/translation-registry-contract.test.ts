import assert from 'node:assert/strict'
import test from 'node:test'
import { TranslationError, TranslationRegistry, type TranslationEngine, type TranslationOutput } from '../src/translation/index.ts'

const limits = { timeoutMs: 30_000, maxInputCharacters: 100, maxOutputCharacters: 100 }
const instance = { id: 'account', engineId: 'mock', configurationRevision: 'r1', config: { token: 'original' } }
const request = { text: 'word', targetLanguage: 'zh' }
const complete: TranslationOutput = { text: '词', status: 'complete', warnings: [] }
const hasCode = (code: string) => (error: unknown) => error instanceof TranslationError && error.code === code
const fakeEngine = (translate: TranslationEngine['translate'] = async () => complete): TranslationEngine => ({
  descriptor: { id: 'mock', name: 'Mock', version: '1', execution: 'local', maxInputCharacters: 50 }, translate,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

test('registry validates its limits, selection identity, and cloned public metadata', async () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new TranslationRegistry({ ...limits, maxInputCharacters: bad }), RangeError)
  }
  assert.throws(() => new TranslationRegistry({ ...limits, timeoutMs: 2_147_483_648 }), RangeError)

  const registry = new TranslationRegistry(limits)
  assert.equal((await registry.availability()).status, 'not-configured')
  assert.equal(registry.getSelection(), undefined)
  for (const invalid of [
    { ...instance, id: '' }, { ...instance, engineId: '' }, { ...instance, configurationRevision: '' },
  ]) assert.throws(() => registry.select(invalid), hasCode('not-configured'))

  const input = structuredClone(instance)
  registry.select(input)
  input.config.token = 'changed after selection'
  assert.equal(registry.getSelection()?.config.token, 'original')
  const copy = registry.getSelection()!
  ;(copy.config as { token: string }).token = 'changed returned copy'
  assert.equal(registry.getSelection()?.config.token, 'original')
  assert.equal((await registry.availability()).status, 'unavailable')

  const engine = fakeEngine()
  const unregister = registry.register(engine)
  assert.equal((await registry.availability()).status, 'available')
  const descriptors = registry.list()
  descriptors[0]!.name = 'changed returned descriptor'
  assert.equal(registry.list()[0]!.name, 'Mock')
  assert.throws(() => registry.register(engine), /already registered/)
  registry.select({ ...instance, config: { token: 'original' } }) // unchanged selection is harmless
  unregister()
  unregister() // disposal is idempotent
  assert.equal((await registry.availability()).status, 'unavailable')
  registry.dispose()
  registry.dispose()
  assert.equal((await registry.availability()).status, 'unavailable')
  assert.throws(() => registry.register(engine), hasCode('engine-unavailable'))
  assert.throws(() => registry.select(instance), hasCode('engine-unavailable'))
  await assert.rejects(registry.translate(request), hasCode('engine-unavailable'))
})

test('registry validates requests, takes configuration snapshots, and preserves source attribution', async () => {
  const seen: unknown[] = []
  const registry = new TranslationRegistry(limits)
  registry.register(fakeEngine(async (input, config) => {
    seen.push({ input, config })
    return { ...complete, detectedSourceLanguage: 'en', warnings: ['estimated'] }
  }))
  await assert.rejects(registry.translate(request), hasCode('not-configured'))
  registry.select({ ...instance, engineId: 'missing' })
  await assert.rejects(registry.translate(request), hasCode('engine-unavailable'))
  registry.select(instance)
  for (const invalid of [
    { text: '  ', targetLanguage: 'zh' }, { text: 'x', targetLanguage: '  ' },
    { text: 'x', targetLanguage: 'a'.repeat(101) }, { text: 'x', targetLanguage: 'zh', sourceLanguage: ' ' },
    { text: 'x', targetLanguage: 'zh', sourceLanguage: 'a'.repeat(101) },
    { ...request, timeoutMs: 0 }, { ...request, timeoutMs: 1.5 },
  ]) await assert.rejects(registry.translate(invalid), hasCode('invalid-request'))
  await assert.rejects(registry.translate({ ...request, text: 'x'.repeat(51) }), hasCode('limit-exceeded'))

  const context = { sessionId: 'session', documentId: 'doc' }
  const output = await registry.translate({ ...request, timeoutMs: 60_000, context })
  assert.deepEqual(output.source, {
    engineId: 'mock', engineVersion: '1', instanceId: 'account', configurationRevision: 'r1',
  })
  assert.equal(output.detectedSourceLanguage, 'en')
  assert.deepEqual(output.warnings, ['estimated'])
  const sent = seen[0] as { input: { timeoutMs: number; context: typeof context }; config: typeof instance.config }
  assert.equal(sent.input.timeoutMs, 30_000)
  assert.deepEqual(sent.input.context, context)
  assert.notEqual(sent.input.context, context)
  assert.deepEqual(sent.config, { token: 'original' })
  registry.dispose()
})

test('changing selection, removing engine, disposing, timing out, and caller cancellation stop in-flight work', async () => {
  const started = deferred<void>()
  const never = new Promise<TranslationOutput>(() => undefined)
  const registry = new TranslationRegistry(limits)
  const unregister = registry.register(fakeEngine(async () => { started.resolve(); return never }))
  registry.select(instance)

  let pending = registry.translate(request)
  await started.promise
  registry.select({ ...instance, configurationRevision: 'r2' })
  await assert.rejects(pending, hasCode('cancelled'))

  pending = registry.translate(request)
  unregister()
  await assert.rejects(pending, hasCode('engine-unavailable'))

  registry.register(fakeEngine(async () => never))
  registry.select(instance)
  await assert.rejects(registry.translate({ ...request, timeoutMs: 5 }), hasCode('timeout'))
  const caller = new AbortController()
  pending = registry.translate({ ...request, signal: caller.signal })
  caller.abort(new Error('private caller error'))
  await assert.rejects(pending, hasCode('cancelled'))

  const withCode = new AbortController()
  const reason = new TranslationError('stale-result', 'selection changed in the UI')
  withCode.abort(reason)
  await assert.rejects(registry.translate({ ...request, signal: withCode.signal }), (error: unknown) => error === reason)

  pending = registry.translate(request)
  registry.dispose()
  await assert.rejects(pending, hasCode('cancelled'))
})

test('registry rejects malformed engine output and lexical details without leaking arbitrary errors', async () => {
  const registry = new TranslationRegistry(limits)
  let next: unknown = complete
  registry.register(fakeEngine(async () => next as TranslationOutput))
  registry.select(instance)
  const invalid = [
    null, { ...complete, text: '' }, { ...complete, status: 'unknown' },
    { ...complete, warnings: ['x'.repeat(201)] }, { ...complete, warnings: ['w'].concat(Array(20).fill('w')) },
    { ...complete, detectedSourceLanguage: 12 }, { ...complete, text: 'x'.repeat(101) },
    { ...complete, detail: [] }, { ...complete, detail: { kind: 'other', meanings: [] } },
    { ...complete, detail: { kind: 'word', meanings: [null] } },
    { ...complete, detail: { kind: 'word', meanings: [{ partOfSpeech: 'noun', meaning: '词', example: 'word', exampleTranslation: '词' }] }, status: 'partial' },
  ]
  for (next of invalid) {
    await assert.rejects(registry.translate(request), (error: unknown) => error instanceof TranslationError)
  }
  next = { ...complete, detail: { kind: 'word', meanings: [
    { partOfSpeech: 'noun', meaning: 'x'.repeat(99), example: 'word', exampleTranslation: '词' },
  ] } }
  await assert.rejects(registry.translate(request), hasCode('limit-exceeded'))
  next = complete
  registry.dispose()

  const failed = new TranslationRegistry(limits)
  failed.register(fakeEngine(async () => { throw new Error('provider secret') }))
  failed.select(instance)
  await assert.rejects(failed.translate(request), (error: unknown) => error instanceof TranslationError
    && error.code === 'translation-failed' && error.cause instanceof Error && error.cause.message === 'provider secret')
})
