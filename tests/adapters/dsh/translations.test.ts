import assert from 'node:assert/strict'
import test from 'node:test'
import { createHostTranslations, type TranslationHostContext } from '../../../src/adapters/host/dsh/index.ts'
import { defaultSettings } from '../../../src/shared/contracts.ts'
import { TranslationError } from '../../../src/translation/types.ts'
import { createHostTranslationEngine } from '../../../src/adapters/client/remote/translation-api.ts'

const input = { sessionId: 'session', engineId: 'dsh-model', text: 'A complete sentence.',
  sourceLanguage: 'auto', targetLanguage: 'zh', timeoutMs: 30_000 }
const agent = { session: { id: 'session', header: {} } }
const signal = () => new AbortController().signal
const hasCode = (code: string) => (error: unknown) => error instanceof TranslationError && error.code === code

/** Real Host/registry/Client composition, with a controlled model stream rather
 * than a semantic-quality assertion about any actual model. */
function controlledModelHost(outputs: readonly object[]) {
  const requests: Array<{ text: string; nearby_text?: { before: string; after: string }; mode?: unknown }> = []
  const context = {
    get(key: string) {
      if (key !== 'llm') return undefined
      return { async *stream(options: { messages: Array<{ content: Array<{ text: string }> }> }) {
        const response = outputs[requests.length]
        assert.ok(response, 'the controlled stream has a response for every request')
        requests.push(JSON.parse(options.messages[0]!.content[0]!.text))
        yield { type: 'text-delta', index: 0, text: JSON.stringify(response) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    },
    sessionController: { async resolveAgent() { return { agent: { session: {
      requestHeader: () => ({ config: { provider: 'test', model: 'test' } }),
    } } } } },
  } as unknown as TranslationHostContext
  const host = createHostTranslations(context, 'test', () => defaultSettings)
  const client = createHostTranslationEngine({ rpc: { async call(_path, method, payload, active) {
    assert.equal(method, 'pdf.translation')
    assert.ok(active)
    return { ok: true, value: await host.dispatch('session', payload as Record<string, unknown>, agent, active) }
  } } }, signal(), { id: 'dsh-model', name: 'DSH Model', version: '1', execution: 'remote' })
  return { host, client, requests }
}

test('Host translation dispatch rejects payloads attempting to borrow a different session', async () => {
  const translations = createHostTranslations({ get() { return undefined },
    sessionController: { async resolveAgent() { throw new Error('must not resolve') } },
  } as unknown as TranslationHostContext, 'test', () => defaultSettings)
  try {
    await assert.rejects(translations.dispatch('session', { ...input, sessionId: 'other' }, agent, signal()),
      hasCode('invalid-request'))
    await assert.rejects(translations.dispatch('session', { ...input,
      context: { sessionId: 'other' } }, agent, signal()), hasCode('invalid-request'))
  } finally { translations.registry.dispose() }
})

test('Host translation does not return output after its active model settings change', async () => {
  let settings = { ...defaultSettings }
  const context = {
    get(key: string) {
      if (key !== 'llm') return undefined
      return { async *stream() {
        yield { type: 'text-delta', index: 0, text: '{"kind":"sentence","translation":"译文。"}' }
        settings = { ...settings, translationTimeoutMs: 31_000 }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    },
    sessionController: { async resolveAgent() { return { agent: { session: {
      requestHeader: () => ({ config: { provider: 'test', model: 'test' } }),
    } } } } },
  } as unknown as TranslationHostContext
  const translations = createHostTranslations(context, 'test', () => settings)
  try {
    await assert.rejects(translations.dispatch('session', input, agent, signal()), hasCode('stale-result'))
  } finally { translations.registry.dispose() }
})

test('Host translation resolves a session without a header through the configured default model', async () => {
  let called = false
  const context = {
    get(key: string) {
      if (key === 'agentDefaultModel') return { currentSelection() {
        called = true
        return { provider: 'default-provider', model: 'default-model' }
      } }
      if (key === 'llm') return { async *stream(options: { provider: string; model: string }) {
        assert.equal(options.provider, 'default-provider')
        assert.equal(options.model, 'default-model')
        yield { type: 'text-delta', index: 0, text: '{"kind":"sentence","translation":"译文。"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
      return undefined
    },
    sessionController: { async resolveAgent() { return { agent: { session: {} } } } },
  } as unknown as TranslationHostContext
  const translations = createHostTranslations(context, 'test', () => defaultSettings)
  try {
    const result = await translations.dispatch('session', input, agent, signal())
    assert.equal((result as { text: string }).text, '译文。')
    assert.equal(called, true)
  } finally { translations.registry.dispose() }
})

test('Host translation reports absent or failing default model selection as not configured', async () => {
  for (const selection of [undefined, { currentSelection() { throw new Error('private model lookup') } }]) {
    const context = {
      get(key: string) {
        if (key === 'agentDefaultModel') return selection
        if (key === 'llm') return { async *stream() { throw new Error('must not stream') } }
        return undefined
      },
      sessionController: { async resolveAgent() { return { agent: { session: {} } } } },
    } as unknown as TranslationHostContext
    const translations = createHostTranslations(context, 'test', () => defaultSettings)
    try {
      await assert.rejects(translations.dispatch('session', input, agent, signal()), hasCode('not-configured'))
    } finally { translations.registry.dispose() }
  }
})

test('model repair metadata crosses the authenticated Host, registry and Client boundary without replacing the selected text', async () => {
  const interpretation = { text: 'abstraction', kind: 'completion' as const, certainty: 'tentative' as const,
    explanation: 'The nearby discussion makes this a plausible completion.' }
  const { host, client, requests } = controlledModelHost([{ kind: 'word', pronunciation: null,
    meanings: [{ partOfSpeech: '名词', meaning: '抽象',
      example: 'Abstraction hides detail.', exampleTranslation: '抽象隐藏细节。' }], interpretation }])
  try {
    const result = await client.translate({ text: 'btracti', sourceLanguage: 'auto', targetLanguage: 'zh',
      context: { sessionId: 'session', selectionBefore: 'A useful ', selectionAfter: ' hides implementation details.' },
      signal: signal(), timeoutMs: 30_000, maxOutputCharacters: 32768 }, {})
    assert.deepEqual(result.interpretation, interpretation)
    assert.equal(result.detail?.kind, 'word')
    assert.equal(result.detail?.meanings[0]!.meaning, '抽象')
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.text, 'btracti', 'the original selection remains the request source')
    assert.equal(requests[0]!.mode, undefined, 'the Client must not force a lexical mode')
    assert.deepEqual(requests[0]!.nearby_text, { before: 'A useful ', after: ' hides implementation details.' })
  } finally { host.registry.dispose() }
})

test('a controlled fragment translation crosses Host and wire without a recognition gate or source rewrite', async () => {
  const selected = 'reduces a tensor'
  const interpretation = { text: selected, kind: 'completion' as const, certainty: 'tentative' as const,
    explanation: 'A model-supplied explanation is carried without rejudging the source.' }
  const pronunciation = '/rɪˈdjuːsɪz ə ˈtensə/'
  const { host, client, requests } = controlledModelHost([
    { kind: 'sentence', translation: '对张量进行归约', interpretation },
    { kind: 'phrase', pronunciation, meanings: [{ partOfSpeech: '动词短语', meaning: '对张量进行归约',
      example: 'The operation reduces a tensor.', exampleTranslation: '此操作对张量进行归约。' }] },
  ])
  const request = { text: selected, sourceLanguage: 'auto', targetLanguage: 'zh',
    context: { sessionId: 'session' }, signal: signal(), timeoutMs: 30_000, maxOutputCharacters: 32768 }
  try {
    const sentence = await client.translate(request, {})
    assert.equal(sentence.text, '对张量进行归约')
    assert.deepEqual(sentence.interpretation, interpretation, 'SDK passes even same-text metadata without a semantic veto')
    assert.equal(sentence.detail, undefined)
    const phrase = await client.translate(request, {})
    assert.equal(phrase.detail?.kind, 'phrase')
    assert.equal(phrase.detail?.pronunciation, pronunciation)
    assert.deepEqual(requests.map(value => value.text), [selected, selected])
    assert.ok(requests.every(value => value.mode === undefined))
  } finally { host.registry.dispose() }
})
