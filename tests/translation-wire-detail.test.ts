import assert from 'node:assert/strict'
import test from 'node:test'
import { createHostTranslationEngine } from '../src/adapters/client/remote/translation-api.ts'
import { TranslationError, type TranslationErrorCode } from '../src/translation/types.ts'

test('the authenticated translation wire preserves lexical details', async () => {
  const calls: object[] = []
  const engine = createHostTranslationEngine({ rpc: { async call(_path, _method, payload) {
    calls.push(payload)
    return { ok: true, value: {
      text: '/ˈentər/\n进入\nEnter the room. — 走进房间。', status: 'complete', warnings: [],
      detail: { kind: 'word', pronunciation: '/ˈentər/',
        meanings: [{ partOfSpeech: '动词', meaning: '进入', example: 'Enter the room.', exampleTranslation: '走进房间。' }] },
      source: { engineId: 'dsh-model', engineVersion: '1', instanceId: 'session', configurationRevision: '1' },
    } }
  } } }, new AbortController().signal,
  { id: 'dsh-model', name: 'DSH Model', version: '1', execution: 'remote' })
  const result = await engine.translate({ text: 'enter', sourceLanguage: 'auto', targetLanguage: 'zh',
    context: { sessionId: 'session' }, signal: new AbortController().signal,
    timeoutMs: 30_000, maxOutputCharacters: 32768 }, {})
  assert.deepEqual(result.detail, { kind: 'word', pronunciation: '/ˈentər/',
    meanings: [{ partOfSpeech: '动词', meaning: '进入', example: 'Enter the room.', exampleTranslation: '走进房间。' }] })
  assert.equal(calls.length, 1)
})

test('the authenticated translation wire preserves an unbounded list of valid meanings', async () => {
  const meanings = Array.from({ length: 25 }, (_, index) => ({
    partOfSpeech: index % 2 ? '名词' : '动词',
    meaning: `含义 ${index + 1}`,
    example: `Use on in example ${index + 1}.`,
    exampleTranslation: `例句 ${index + 1}。`,
  }))
  const engine = createHostTranslationEngine({ rpc: { async call() {
    return { ok: true, value: {
      text: meanings.map(item => item.meaning).join('\n'), status: 'complete', warnings: [],
      detail: { kind: 'word', pronunciation: '/ɒn/', meanings },
      source: { engineId: 'dsh-model', engineVersion: '1', instanceId: 'session', configurationRevision: '1' },
    } }
  } } }, new AbortController().signal,
  { id: 'dsh-model', name: 'DSH Model', version: '1', execution: 'remote' })
  const result = await engine.translate({ text: 'on', sourceLanguage: 'auto', targetLanguage: 'zh',
    context: { sessionId: 'session' }, signal: new AbortController().signal,
    timeoutMs: 30_000, maxOutputCharacters: 32768 }, {})
  assert.deepEqual(result.detail?.meanings, meanings)
})

test('the authenticated translation wire rejects an omitted part of speech', async () => {
  const engine = createHostTranslationEngine({ rpc: { async call() {
    return { ok: true, value: {
      text: '进入', status: 'complete', warnings: [],
      detail: { kind: 'word', meanings: [{
        meaning: '进入', example: 'Enter the room.', exampleTranslation: '进入房间。',
      }] },
    } }
  } } }, new AbortController().signal,
  { id: 'dsh-model', name: 'DSH Model', version: '1', execution: 'remote' })
  await assert.rejects(engine.translate({ text: 'enter', sourceLanguage: 'auto', targetLanguage: 'zh',
    context: { sessionId: 'session' }, signal: new AbortController().signal,
    timeoutMs: 30_000, maxOutputCharacters: 32768 }, {}))
})

test('the authenticated translation wire preserves model-output failure codes for the UI', async () => {
  for (const code of ['invalid-model-output', 'incomplete-model-output', 'empty-model-output',
    'incomplete-selection', 'unrecognized-selection'] as const satisfies readonly TranslationErrorCode[]) {
    const engine = createHostTranslationEngine({ rpc: { async call() {
      return { ok: false, error: { code, message: 'Sensitive provider diagnostic; do not show in the UI.' } }
    } } }, new AbortController().signal,
    { id: 'dsh-model', name: 'DSH Model', version: '1', execution: 'remote' })

    await assert.rejects(engine.translate({ text: 'on', sourceLanguage: 'auto', targetLanguage: 'zh',
      context: { sessionId: 'session' }, signal: new AbortController().signal,
      timeoutMs: 30_000, maxOutputCharacters: 32768 }, {}), error =>
      error instanceof TranslationError && error.code === code)
  }
})
