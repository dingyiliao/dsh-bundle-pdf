import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, LlmError, type GenerateOptions, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import {
  createDshModelTranslationEngine, type DshTranslationChunk, type DshTranslationGenerateOptions,
} from '../../../src/adapters/host/dsh/translation-model.ts'
import { TranslationError, type TranslationEngineRequest } from '../../../src/translation/types.ts'

const hasCode = (code: string) => (error: unknown) => error instanceof TranslationError && error.code === code
const request = (signal = new AbortController().signal): TranslationEngineRequest => ({
  text: 'A complete sentence.', sourceLanguage: 'auto', targetLanguage: 'zh',
  context: { sessionId: 'session' }, signal, timeoutMs: 30_000, maxOutputCharacters: 32_768,
})
const translatedSentence = JSON.stringify({ kind: 'sentence', translation: '一个完整的句子。' })

function modelWith(chunks: DshTranslationChunk[], resolveContext = () => ({ provider: 'provider', model: 'model' })) {
  return createDshModelTranslationEngine({
    llm: { async * stream(_options: DshTranslationGenerateOptions) { for (const chunk of chunks) yield chunk } },
    resolveContext, maxOutputTokens: 4096,
  })
}

test('model translation requires a valid token limit, model service, session and configured route', async () => {
  for (const maxOutputTokens of [0, -1, 1.2, Number.NaN]) {
    assert.throws(() => createDshModelTranslationEngine({ llm: undefined, resolveContext: () => ({
      provider: 'provider', model: 'model',
    }), maxOutputTokens }), RangeError)
  }
  const missingModel = createDshModelTranslationEngine({
    llm: undefined, resolveContext: () => ({ provider: 'provider', model: 'model' }), maxOutputTokens: 1,
  })
  assert.equal((await missingModel.availability?.({}))?.status, 'unavailable')
  await assert.rejects(missingModel.translate(request(), {}), hasCode('engine-unavailable'))
  const model = modelWith([])
  assert.equal((await model.availability?.({}))?.status, 'available')
  await assert.rejects(model.translate({ ...request(), context: undefined }, {}), hasCode('not-configured'))
  for (const route of [{ provider: '', model: 'model' }, { provider: 'provider', model: '  ' }]) {
    const unconfigured = modelWith([], () => route)
    await assert.rejects(unconfigured.translate(request(), {}), hasCode('not-configured'))
  }
})

test('aborting while session routing is pending stops promptly and preserves safe cancellation reasons', async () => {
  let observedSignal: AbortSignal | undefined
  const routing = createDshModelTranslationEngine({
    llm: { async * stream() { throw new Error('routing must finish first') } },
    resolveContext: (_sessionId, signal) => {
      observedSignal = signal
      return new Promise(() => undefined)
    },
    maxOutputTokens: 1,
  })
  const caller = new AbortController()
  const pending = routing.translate(request(caller.signal), {})
  assert.ok(observedSignal)
  caller.abort(new Error('private caller reason'))
  await assert.rejects(pending, hasCode('cancelled'))
  assert.equal(observedSignal?.aborted, true)

  const exact = new AbortController()
  const reason = new TranslationError('stale-result', 'The document changed.')
  exact.abort(reason)
  await assert.rejects(modelWith([]).translate(request(exact.signal), {}), (error: unknown) => error === reason)
})

test('a rejected session route is reported as a safe translation failure', async () => {
  const upstream = new Error('private routing diagnostic')
  const engine = createDshModelTranslationEngine({
    llm: { async * stream() { throw new Error('routing must finish first') } },
    resolveContext: async () => { throw upstream },
    maxOutputTokens: 1,
  })
  await assert.rejects(engine.translate(request(), {}), (error: unknown) => error instanceof TranslationError
    && error.code === 'translation-failed' && error.cause === upstream
    && !error.message.includes('private routing diagnostic'))
})

test('a rejected model stream remains a transport failure without exposing provider diagnostics', async () => {
  const upstream = new Error('private provider network diagnostic')
  const engine = createDshModelTranslationEngine({
    llm: { async * stream() { throw upstream } },
    resolveContext: () => ({ provider: 'provider', model: 'model' }),
    maxOutputTokens: 4096,
  })
  await assert.rejects(engine.translate(request(), {}), (error: unknown) => error instanceof TranslationError
    && error.code === 'translation-failed' && error.cause === upstream
    && !error.message.includes('private provider network diagnostic'))
})

test('a stalled provider times out independently of selected text semantics', async () => {
  const engine = createDshModelTranslationEngine({
    llm: { async * stream() { await new Promise(() => undefined) } },
    resolveContext: () => ({ provider: 'provider', model: 'model' }),
    maxOutputTokens: 4096,
  })
  await assert.rejects(engine.translate({ ...request(), text: 'a', timeoutMs: 5 }, {}), hasCode('timeout'))
})

test('malformed JSON after a successful stream is a protocol failure', async () => {
  await assert.rejects(modelWith([
    { type: 'text-delta', index: 0, text: '{"kind":"sentence","translation":' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]).translate(request(), {}), hasCode('invalid-model-output'))
})

test('stream rejects tool calls, invalid block indices and unsupported completion statuses', async () => {
  const cases: { chunks: DshTranslationChunk[]; code: string }[] = [
    { chunks: [{ type: 'tool-call-delta' }], code: 'invalid-model-output' },
    { chunks: [{ type: 'text-delta', index: -1, text: '{}' }], code: 'invalid-model-output' },
    { chunks: [{ type: 'text-delta', index: 1_000_001, text: '{}' }], code: 'invalid-model-output' },
    { chunks: [{ type: 'finish', reason: { kind: 'unknown' } }], code: 'translation-failed' },
  ]
  for (const { chunks, code } of cases) {
    await assert.rejects(modelWith(chunks).translate(request(), {}), hasCode(code))
  }
})

test('provider failures map credential, provider, quota, and generic errors into stable UI codes', async () => {
  for (const [failureCode, expected] of [
    ['AUTH', 'authentication-failed'],
    ['MISSING_CREDENTIAL', 'authentication-failed'],
    ['INVALID_CREDENTIAL', 'authentication-failed'],
    ['NO_ADAPTER', 'engine-unavailable'],
    ['RATE_LIMIT', 'limit-exceeded'],
    ['QUOTA', 'limit-exceeded'],
    ['ACCOUNT_QUOTA', 'limit-exceeded'],
    ['CONTEXT_WINDOW_EXCEEDED', 'limit-exceeded'],
    ['INTERNAL', 'translation-failed'],
  ]) {
    const engine = modelWith([{ type: 'finish', reason: {
      kind: 'error', failure: { code: failureCode, message: 'Sensitive upstream diagnostic' },
    } }])
    await assert.rejects(engine.translate(request(), {}), (error: unknown) =>
      hasCode(expected)(error) && !String(error).includes('Sensitive upstream diagnostic'))
  }
})

test('a normal translated sentence still succeeds when route includes optional reasoning effort', async () => {
  let sent: DshTranslationGenerateOptions | undefined
  const engine = createDshModelTranslationEngine({
    llm: { async * stream(options) {
      sent = options
      yield { type: 'text-delta', index: 0, text: translatedSentence }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
    resolveContext: () => ({ provider: 'provider', model: 'model', reasoningEffort: 'low' }),
    maxOutputTokens: 128,
  })
  const result = await engine.translate(request(), {})
  assert.equal(result.text, '一个完整的句子。')
  assert.equal(sent?.reasoningEffort, 'low')
})

test('the actual DSH runtime routes one-shot translation requests through a controlled adapter', async () => {
  const root = new Context()
  const fiber = root.plugin(LlmRuntime)
  await fiber
  const runtime = root.llm
  const calls: GenerateOptions[] = []
  const modelText = 'Controlled adapter result; this does not evaluate online translation quality.'
  class ControlledAdapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return { provider, id: model, name: 'Controlled translation model', inputModalities: ['text'] }
    }
    async * stream(options: GenerateOptions) {
      calls.push(options)
      yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
      yield { type: 'text-delta' as const, index: 0, text: JSON.stringify({ kind: 'sentence', translation: modelText }) }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }
  }
  const unregister = runtime.registerAdapter(['controlled-provider'], new ControlledAdapter())
  try {
    const engine = createDshModelTranslationEngine({ llm: runtime,
      resolveContext: () => ({ provider: 'controlled-provider', model: 'controlled-model' }), maxOutputTokens: 4096 })
    for (const text of ['reduces a tensor', 'a', '...?!', 'btracti']) {
      const result = await engine.translate({ ...request(), text }, {})
      assert.equal(result.text, modelText)
      const dispatched = calls.at(-1)!
      assert.equal(dispatched.provider, 'controlled-provider')
      assert.equal(dispatched.model, 'controlled-model')
      assert.equal(typeof dispatched.system, 'string')
      assert.match(dispatched.system!, /Return only one JSON object/)
      assert.deepEqual(dispatched.messages, [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({
        source_language: 'auto', target_language: 'zh', text,
      }) }] }])
      assert.equal(dispatched.signal?.aborted, true, 'the adapter request is closed after successful consumption')
    }
    assert.equal(calls.length, 4)
  } finally { unregister(); await fiber.dispose() }
})

test('the actual DSH runtime projects provider throws to finish failures before translation error mapping', async () => {
  const root = new Context()
  const fiber = root.plugin(LlmRuntime)
  await fiber
  let entered = false
  class FailingAdapter extends LlmAdapter {
    async * stream(_options: GenerateOptions): AsyncIterable<never> {
      entered = true
      throw new LlmError('private controlled adapter failure', 'INVALID_CREDENTIAL')
    }
  }
  const unregister = root.llm.registerAdapter(['controlled-provider'], new FailingAdapter())
  try {
    const engine = createDshModelTranslationEngine({ llm: root.llm,
      resolveContext: () => ({ provider: 'controlled-provider', model: 'controlled-model' }), maxOutputTokens: 4096 })
    await assert.rejects(engine.translate(request(), {}), (error: unknown) => hasCode('authentication-failed')(error)
      && !String(error).includes('private controlled adapter failure'))
    assert.equal(entered, true)
  } finally { unregister(); await fiber.dispose() }
})
