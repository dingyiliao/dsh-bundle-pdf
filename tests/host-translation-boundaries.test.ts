import assert from 'node:assert/strict'
import test from 'node:test'
import { createHostTranslations, type TranslationHostContext } from '../src/host/translations.ts'
import { defaultSettings } from '../src/shared/contracts.ts'
import { TranslationError } from '../src/translation/types.ts'

const input = { sessionId: 'session', engineId: 'dsh-model', text: 'A complete sentence.',
  sourceLanguage: 'auto', targetLanguage: 'zh', timeoutMs: 30_000 }
const agent = { session: { id: 'session', header: {} } }
const signal = () => new AbortController().signal
const hasCode = (code: string) => (error: unknown) => error instanceof TranslationError && error.code === code

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
        yield { type: 'text-delta', index: 0, text: '{"recognized":true,"translation":"译文。"}' }
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
