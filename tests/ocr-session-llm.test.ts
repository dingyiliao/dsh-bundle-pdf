import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionLlmOcrBackend,
  type SessionLlmOcrDependencies, type SessionOcrLlm } from '../src/host/ocr-session-llm.js'
import type { HostOcrRequest } from '../src/host/ocr-service.js'
import { OcrError } from '../src/ocr/types.js'

type StreamItem = ReturnType<SessionOcrLlm['stream']> extends AsyncIterable<infer T> ? T : never

const reference = { attachmentId: 'image-1', mediaType: 'image/png', bytes: 4, width: 50, height: 40 }
const request = (changes: Partial<HostOcrRequest> = {}): HostOcrRequest => ({
  sessionId: 'session-1', image: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png',
  width: 50, height: 40, languages: ['en'], ...changes,
})
const llmFor = (...items: StreamItem[]): SessionOcrLlm => ({
  async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
  async *stream() { yield* items },
})
const backend = (changes: Partial<SessionLlmOcrDependencies> = {}) => createSessionLlmOcrBackend({
  getLlm: () => llmFor({ type: 'finish', reason: { kind: 'stop' } }),
  getAttachments: () => ({ async saveImage() { return reference } }),
  resolveModel: async () => ({ provider: 'vision', model: 'm1' }),
  ...changes,
})
const hasCode = (code: OcrError['code']) => (error: unknown): boolean =>
  error instanceof OcrError && error.code === code

test('session OCR rejects non-positive or non-integral output bounds', () => {
  for (const maxOutputTokens of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => backend({ maxOutputTokens }), RangeError)
  }
  for (const maxOutputCharacters of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => backend({ maxOutputCharacters }), RangeError)
  }
})

test('session OCR availability distinguishes missing services, model selection, and generic resolution failure', async () => {
  const signal = new AbortController().signal
  assert.match((await backend({ getLlm: () => undefined }).availability('s', signal)).reason!, /unavailable/i)
  assert.match((await backend({ getAttachments: () => undefined }).availability('s', signal)).reason!, /unavailable/i)
  const noModel = backend({ resolveModel: async () => ({ provider: ' ', model: 'm1' }) })
  assert.deepEqual((await noModel.availability('s', signal)).status, 'not-configured')
  await assert.rejects(noModel.recognize(request()), hasCode('not-configured'))
  const noName = backend({ resolveModel: async () => ({ provider: 'vision', model: ' ' }) })
  assert.equal((await noName.availability('s', signal)).status, 'not-configured')
  const broken = backend({ resolveModel: async () => { throw new Error('route read failed') } })
  assert.deepEqual(await broken.availability('s', signal),
    { status: 'unavailable', reason: 'Could not resolve the current session model.' })
})

test('session OCR reports model-catalog failures and undeclared image capability', async () => {
  const catalogFails = backend({ getLlm: () => ({
    async resolveModelInfo() { throw new Error('provider offline') },
    async *stream() { throw new Error('must not stream') },
  }) })
  await assert.rejects(catalogFails.recognize(request()), (error: unknown) =>
    error instanceof OcrError && error.code === 'engine-unavailable'
      && error.cause instanceof Error && error.cause.message === 'provider offline')
  const textOnly = backend({ getLlm: () => ({
    async resolveModelInfo() { return { inputModalities: ['text'] } },
    async *stream() { throw new Error('must not stream') },
  }) })
  await assert.rejects(textOnly.recognize(request()), hasCode('engine-unavailable'))
})

test('session OCR cancellation wins races against model catalog, attachment upload, and stream', async () => {
  for (const phase of ['catalog', 'upload', 'stream'] as const) {
    const controller = new AbortController()
    const reason = new Error(`cancel ${phase}`)
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const hangs = () => new Promise<never>(() => undefined)
    const instance = backend({
      getLlm: () => ({
        resolveModelInfo: async () => phase === 'catalog' ? (entered(), hangs())
          : { inputModalities: ['image'] },
        async *stream() {
          if (phase === 'stream') { entered(); await hangs() }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
      getAttachments: () => ({ async saveImage() {
        if (phase === 'upload') { entered(); return hangs() }
        return reference
      } }),
    })
    const task = instance.recognize(request({ signal: controller.signal }))
    await started
    controller.abort(reason)
    await assert.rejects(task, error => error === reason)
  }
})

test('session OCR accepts Blob bytes, routes reasoning effort, and assembles indexed text in order', async () => {
  let uploaded: Uint8Array | undefined
  const instance = backend({
    getLlm: () => ({
      async resolveModelInfo(provider, model) {
        assert.equal(provider, 'vision')
        assert.equal(model, 'm1')
        return { inputModalities: ['image'] }
      },
      async *stream(options) {
        assert.equal(options.reasoningEffort, 'low')
        assert.equal(options.maxTokens, 32)
        assert.match(options.system, /Do not summarize, translate/)
        assert.deepEqual(options.messages[0]?.content[1], { type: 'image', attachment: reference })
        assert.match((options.messages[0]?.content[0] as { text: string }).text, /en, zh/)
        yield { type: 'text-delta', index: 1, text: 'WORLD' }
        yield { type: 'text-delta', index: 0, text: 'he' }
        yield { type: 'text-delta', index: 0, text: 'llo ' }
        yield { type: 'block-end', index: 1, block: { type: 'text', text: 'world' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
    getAttachments: () => ({ async saveImage(input) {
      uploaded = input.data
      assert.equal(input.name, 'ocr-input')
      assert.equal(input.mediaType, 'image/png')
      return reference
    } }),
    resolveModel: async () => ({ provider: 'vision', model: 'm1', reasoningEffort: 'low' }),
    maxOutputTokens: 32,
  })
  const result = await instance.recognize(request({
    image: new Blob([new Uint8Array([1, 2, 3])]), languages: ['en', 'zh'],
  }))
  assert.deepEqual([...uploaded!], [1, 2, 3])
  assert.equal(result.text, 'hello world')
  assert.deepEqual(result.blocks, [{ id: 'text', text: 'hello world', box: null, confidence: null }])
  assert.deepEqual(result.coverage, [{ x0: 0, y0: 0, x1: 50, y1: 40 }])
  assert.deepEqual(result.warnings, ['geometry-unavailable'])
})

test('session OCR returns empty and token-limited results without inventing coverage', async () => {
  const empty = await backend({ getLlm: () => llmFor({ type: 'finish', reason: { kind: 'stop' } }) })
    .recognize(request())
  assert.deepEqual(empty.blocks, [])
  assert.deepEqual(empty.warnings, [])
  assert.equal(empty.status, 'complete')
  const partial = await backend({ getLlm: () => llmFor(
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ) }).recognize(request())
  assert.equal(partial.text, 'partial')
  assert.equal(partial.status, 'partial')
  assert.deepEqual(partial.coverage, [])
  assert.deepEqual(partial.warnings, ['geometry-unavailable', 'max-tokens'])
})

test('session OCR maps upstream stop reasons into typed failures', async () => {
  const cases: [string, string, OcrError['code']][] = [
    ['aborted', 'other', 'cancelled'],
    ['error', 'AUTH', 'authentication-failed'],
    ['error', 'MISSING_CREDENTIAL', 'authentication-failed'],
    ['error', 'INVALID_CREDENTIAL', 'authentication-failed'],
    ['error', 'NO_ADAPTER', 'engine-unavailable'],
    ['error', 'RATE_LIMIT', 'limit-exceeded'],
    ['error', 'QUOTA', 'limit-exceeded'],
    ['error', 'ACCOUNT_QUOTA', 'limit-exceeded'],
    ['error', 'CONTEXT_WINDOW_EXCEEDED', 'limit-exceeded'],
    ['error', 'IMAGE_OFFLOAD_REQUIRED', 'limit-exceeded'],
    ['error', 'unrecognized', 'recognition-failed'],
  ]
  for (const [kind, code, expected] of cases) {
    await assert.rejects(backend({ getLlm: () => llmFor({ type: 'finish', reason: {
      kind, failure: { code, message: 'upstream' },
    } }) }).recognize(request()), hasCode(expected), `${kind}/${code}`)
  }
  await assert.rejects(backend({ getLlm: () => llmFor({ type: 'finish' }) }).recognize(request()),
    hasCode('recognition-failed'))
})

test('session OCR rejects tool requests and invalid text or indices rather than yielding misleading OCR', async () => {
  const malformed: StreamItem[] = [
    { type: 'tool-call-delta' },
    { type: 'block-start', blockType: 'tool-call' },
    { type: 'block-end', block: { type: 'tool-call' } },
    { type: 'text-delta', index: 0 },
    { type: 'block-end', index: 0, block: { type: 'text' } },
    { type: 'text-delta', text: 'missing index' },
    { type: 'text-delta', index: -1, text: 'negative' },
    { type: 'text-delta', index: 1_000_001, text: 'too high' },
    { type: 'text-delta', index: 0.5, text: 'fractional' },
  ]
  for (const chunk of malformed) {
    await assert.rejects(backend({ getLlm: () => llmFor(chunk) }).recognize(request()),
      hasCode('recognition-failed'), JSON.stringify(chunk))
  }
  await assert.rejects(backend({ getLlm: () => llmFor() }).recognize(request()),
    hasCode('recognition-failed'))
})

test('session OCR caps output characters and independent text blocks', async () => {
  await assert.rejects(backend({
    maxOutputCharacters: 3,
    getLlm: () => llmFor({ type: 'text-delta', index: 0, text: 'abcd' }),
  }).recognize(request()), hasCode('limit-exceeded'))
  const chunks: StreamItem[] = Array.from({ length: 129 }, (_, index) =>
    ({ type: 'text-delta', index, text: 'a' }))
  await assert.rejects(backend({ getLlm: () => llmFor(...chunks) }).recognize(request()),
    hasCode('limit-exceeded'))
})

test('session OCR wraps unexpected stream failures and tolerates iterator cleanup rejection', async () => {
  let cleaned = 0
  const stream = (): ReturnType<SessionOcrLlm['stream']> => ({
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<StreamItem>> { throw new Error('transport failed') },
        async return(): Promise<IteratorResult<StreamItem>> {
          cleaned++
          throw new Error('cleanup failed')
        },
      }
    },
  })
  await assert.rejects(backend({ getLlm: () => ({
    async resolveModelInfo() { return { inputModalities: ['image'] } }, stream,
  }) }).recognize(request()), (error: unknown) =>
    error instanceof OcrError && error.code === 'recognition-failed'
      && error.cause instanceof Error && error.cause.message === 'transport failed')
  assert.equal(cleaned, 1)
  const synchronousReturn = (): ReturnType<SessionOcrLlm['stream']> => ({
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<StreamItem>> { return { done: false, value: { type: 'finish', reason: { kind: 'stop' } } } },
        return(): Promise<IteratorResult<StreamItem>> { throw new Error('sync cleanup failed') },
      }
    },
  })
  const result = await backend({ getLlm: () => ({
    async resolveModelInfo() { return { inputModalities: ['image'] } }, stream: synchronousReturn,
  }) }).recognize(request())
  assert.equal(result.status, 'complete')
})
