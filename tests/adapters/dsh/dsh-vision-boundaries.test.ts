import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshVisionBackend, type DshVisionDependencies } from '../../../src/adapters/host/dsh/image-backends.ts'
import { ImageUnderstandingError, MAX_DERIVED_TEXT_CHARACTERS,
  type ImageUnderstandingRequest } from '../../../src/modules/image-understanding/index.js'
import type { EngineConfiguration } from '../../../src/modules/engines/index.js'

type VisionLlm = NonNullable<ReturnType<DshVisionDependencies['getLlm']>>
const request = (signal = new AbortController().signal): ImageUnderstandingRequest => ({
  sessionId: 'session', prompt: 'What does the figure show?', signal,
  image: { mediaType: 'image/png', data: new Uint8Array([1, 2]), width: 1, height: 1 },
})
const reference = { attachmentId: 'image', mediaType: 'image/png', bytes: 2, width: 1, height: 1 }
const hasCode = (code: string) => (error: unknown) => error instanceof ImageUnderstandingError && error.code === code
const dependencies = (overrides: Partial<DshVisionDependencies> = {}): DshVisionDependencies => ({
  selectedModel: () => ({ provider: 'vision', model: 'illustrations' }),
  getAttachments: () => ({ async saveImage() { return reference } }),
  getLlm: () => ({
    async resolveModelInfo() { return { inputModalities: ['image'] } },
    async *stream() { yield { type: 'text-delta', index: 0, text: 'A diagram.' }
      yield { type: 'finish', reason: { kind: 'stop' } } },
  }),
  ...overrides,
})

test('DSH vision refuses oversized identifiers, unavailable services and model lookup failures', async () => {
  const signal = request().signal
  const oversized = createDshVisionBackend(dependencies({
    selectedModel: () => ({ provider: 'vision', model: 'x'.repeat(255) }),
  }))
  assert.deepEqual(await oversized.availability('session', signal), {
    available: false, reason: 'The vision model identifier is too long.',
  })
  await assert.rejects(oversized.understand(request()), hasCode('pdf/image-unconfigured'))

  const missingServices = createDshVisionBackend(dependencies({ getAttachments: () => undefined }))
  await assert.rejects(missingServices.understand(request()), hasCode('pdf/image-unavailable'))
  const modelFailure = createDshVisionBackend(dependencies({ getLlm: () => ({
    async resolveModelInfo() { throw new Error('provider offline') },
    async *stream() { throw new Error('must not start') },
  }) }))
  assert.deepEqual(await modelFailure.availability('session', signal), {
    available: false, reason: 'The selected vision model cannot be resolved.',
  })
  await assert.rejects(modelFailure.understand(request()), hasCode('pdf/image-unavailable'))
})

test('DSH vision accepts an explicit engine-instance route without changing its profile default', async () => {
  const routes: unknown[] = []
  const backend = createDshVisionBackend(dependencies({ getLlm: () => ({
    async resolveModelInfo(provider, model) { routes.push([provider, model]); return { inputModalities: ['image'] } },
    async *stream(options) {
      assert.equal(options.provider, 'configured-provider'); assert.equal(options.model, 'configured-model')
      assert.equal(options.reasoningEffort, 'low')
      yield { type: 'text-delta', index: 0, text: 'Fixture image description.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }) }))
  const configuration = { provider: 'configured-provider', model: 'configured-model', reasoningEffort: 'low' }
  assert.equal((await backend.availability('session', request().signal, configuration)).available, true)
  const prepared = await backend.understand(request(), configuration)
  assert.equal(prepared.model, 'configured-provider/configured-model')
  assert.deepEqual(routes, [['configured-provider', 'configured-model'], ['configured-provider', 'configured-model']])
  assert.equal((await backend.availability('session', request().signal, { provider: 'incomplete' })).available, false)
})

test('following the session ignores orphan effort overrides and preserves the actual route cache identity', async () => {
  let effort = 'low'
  const streamed: unknown[] = []
  const llm: VisionLlm = {
    async resolveModelInfo() { return { inputModalities: ['image'] } },
    async *stream(options) {
      streamed.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort })
      yield { type: 'text-delta', index: 0, text: 'A figure.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const backend = createDshVisionBackend(dependencies({
    selectedModel: () => Object.freeze({ provider: 'session-provider', model: 'session-model', reasoningEffort: effort }),
    getLlm: () => llm,
  }))
  const baseline = await backend.cacheIdentity!('session', request().signal)
  const configurations: EngineConfiguration[] = [{ reasoningEffort: 'high' }, { provider: ' ', model: '', reasoningEffort: 'high' }]
  for (const config of configurations) {
    await backend.understand(request(), config)
    assert.deepEqual(await backend.cacheIdentity!('session', request().signal, config), baseline)
  }
  assert.deepEqual(streamed, Array.from({ length: 2 }, () => ({
    provider: 'session-provider', model: 'session-model', reasoningEffort: 'low',
  })))
  effort = 'medium'
  assert.notDeepEqual(await backend.cacheIdentity!('session', request().signal, { reasoningEffort: 'high' }), baseline,
    'changing the inherited session effort must invalidate the effective model identity')
})

test('explicit vision routes trim their effort and use that same route for inference and cache identity', async () => {
  const efforts: (string | undefined)[] = []
  const llm: VisionLlm = {
    async resolveModelInfo(provider: string, model: string) {
      assert.equal(provider, 'configured-provider'); assert.equal(model, 'configured-model')
      return { inputModalities: ['image'] }
    },
    async *stream(options) {
      efforts.push(options.reasoningEffort)
      yield { type: 'text-delta', index: 0, text: 'A figure.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const backend = createDshVisionBackend(dependencies({ selectedModel: () => assert.fail('explicit routes do not inherit session fields'),
    getLlm: () => llm }))
  const padded = { provider: ' configured-provider ', model: ' configured-model ', reasoningEffort: ' high ' }
  const trimmed = { provider: 'configured-provider', model: 'configured-model', reasoningEffort: 'high' }
  await backend.understand(request(), padded)
  assert.deepEqual(await backend.cacheIdentity!('session', request().signal, padded),
    await backend.cacheIdentity!('session', request().signal, trimmed))
  await backend.understand(request(), { ...trimmed, reasoningEffort: '   ' })
  assert.deepEqual(efforts, ['high', undefined])
})

test('DSH vision does not start inference if durable image storage fails', async () => {
  let started = 0
  const backend = createDshVisionBackend(dependencies({
    getAttachments: () => ({ async saveImage() { throw new Error('storage unavailable') } }),
    getLlm: () => ({ async resolveModelInfo() { return { inputModalities: ['image'] } },
      async *stream() { started++; yield { type: 'finish' } } }),
  }))
  await assert.rejects(backend.understand(request()), hasCode('pdf/image-unavailable'))
  assert.equal(started, 0)
})

test('DSH vision reports a stream that cannot start rather than returning empty evidence', async () => {
  const backend = createDshVisionBackend(dependencies({ getLlm: () => ({
    async resolveModelInfo() { return { inputModalities: ['image'] } },
    stream() { throw new Error('stream failed synchronously') },
  } as never) }))
  await assert.rejects(backend.understand(request()), hasCode('pdf/image-unavailable'))
})

test('DSH vision rejects tool requests, invalid block indexes, excess blocks and excess output', async () => {
  const testStream = async (chunks: unknown[], code: string) => {
    const backend = createDshVisionBackend(dependencies({ getLlm: () => ({
      async resolveModelInfo() { return { inputModalities: ['image'] } },
      async *stream() { for (const chunk of chunks) yield chunk as never },
    }) }))
    await assert.rejects(backend.understand(request()), hasCode(code))
  }
  await testStream([{ type: 'tool-call-delta' }], 'pdf/image-invalid-result')
  await testStream([{ type: 'text-delta', index: -1, text: 'invalid' }], 'pdf/image-invalid-result')
  await testStream(Array.from({ length: 129 }, (_, index) => ({ type: 'text-delta', index, text: 'a' })), 'pdf/image-limit')
  await testStream([{ type: 'text-delta', index: 0, text: 'a'.repeat(MAX_DERIVED_TEXT_CHARACTERS + 1) }], 'pdf/image-limit')
})

test('DSH vision cancellation interrupts a non-cooperative stream and requests iterator cleanup', async () => {
  const controller = new AbortController()
  let entered!: () => void, returned = false
  const started = new Promise<void>(resolve => { entered = resolve })
  const backend = createDshVisionBackend(dependencies({ getLlm: () => ({
    async resolveModelInfo() { return { inputModalities: ['image'] } },
    stream() { return { [Symbol.asyncIterator]() { return {
      next() { entered(); return new Promise<IteratorResult<never>>(() => undefined) },
      async return() { returned = true; return { done: true as const, value: undefined } },
    } } } },
  }) }))
  const pending = backend.understand(request(controller.signal))
  await started; controller.abort(new Error('cancelled by reader'))
  await assert.rejects(pending, /cancelled by reader/)
  assert.equal(returned, true)
})

test('DSH vision cannot silently use a different route when only half an explicit model is configured', async () => {
  let resolved = 0
  const backend = createDshVisionBackend(dependencies({ selectedModel: () => {
    resolved++; return { provider: 'session', model: 'session-model' }
  } }))
  for (const config of [{ provider: 'configured' }, { model: 'configured' }] as Array<Record<string, string>>) {
    await assert.rejects(backend.understand(request(), config), hasCode('pdf/image-unconfigured'))
  }
  assert.equal(resolved, 0)
})
