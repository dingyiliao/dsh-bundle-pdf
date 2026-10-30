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
  for (const code of ['invalid-model-output', 'incomplete-model-output', 'empty-model-output'] as const satisfies readonly TranslationErrorCode[]) {
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

test('translation wire preserves validated interpreted source text independently from the original request', async () => {
  const interpretation = { text: 'calculate', kind: 'correction' as const, certainty: 'confident' as const,
    explanation: 'Corrected a character recognized incorrectly.' }
  let captured: unknown
  const engine = createHostTranslationEngine({ rpc: { async call(_path, _method, payload) {
    captured = payload
    return { ok: true, value: { text: '计算', status: 'complete', warnings: [], interpretation } }
  } } }, new AbortController().signal,
  { id: 'dsh-model', name: 'DSH Model', version: '1', execution: 'remote' })
  const result = await engine.translate({ text: 'calcuiate', sourceLanguage: 'auto', targetLanguage: 'zh',
    context: { sessionId: 'session' }, signal: new AbortController().signal, timeoutMs: 30_000, maxOutputCharacters: 32768 }, {})
  assert.equal((captured as { text: string }).text, 'calcuiate')
  assert.deepEqual(result.interpretation, interpretation)
  assert.notEqual(result.interpretation, interpretation)
  interpretation.text = 'mutated after the response'
  assert.equal(result.interpretation?.text, 'calculate')
})

test('translation wire rejects malformed and incomplete recovery metadata', async () => {
  const valid = { text: 'calculate', kind: 'correction', certainty: 'confident', explanation: 'OCR correction.' }
  for (const interpretation of [null, {}, { ...valid, text: '' }, { ...valid, text: 'x'.repeat(8193) },
    { ...valid, kind: 'normalized' }, { ...valid, certainty: 0.9 }, { ...valid, explanation: 'x'.repeat(501) },
    { ...valid, extra: true }]) {
    const engine = createHostTranslationEngine({ rpc: { async call() {
      return { ok: true, value: { text: '计算', status: 'complete', warnings: [], interpretation } }
    } } }, new AbortController().signal,
    { id: 'dsh-model', name: 'DSH Model', version: '1', execution: 'remote' })
    await assert.rejects(engine.translate({ text: 'calcuiate', sourceLanguage: 'auto', targetLanguage: 'zh',
      context: { sessionId: 'session' }, signal: new AbortController().signal, timeoutMs: 30_000, maxOutputCharacters: 32768 }, {}))
  }
  const partial = createHostTranslationEngine({ rpc: { async call() {
    return { ok: true, value: { text: '计算', status: 'partial', warnings: [], interpretation: valid } }
  } } }, new AbortController().signal,
  { id: 'dsh-model', name: 'DSH Model', version: '1', execution: 'remote' })
  await assert.rejects(partial.translate({ text: 'calcuiate', sourceLanguage: 'auto', targetLanguage: 'zh',
    context: { sessionId: 'session' }, signal: new AbortController().signal, timeoutMs: 30_000, maxOutputCharacters: 32768 }, {}),
  error => error instanceof TranslationError && error.code === 'invalid-model-output')
})

test('translation wire preserves same-text interpretation and phrase pronunciation without semantic classification', async () => {
  const interpretation = { text: 'reduces a tensor', kind: 'completion' as const, certainty: 'tentative' as const,
    explanation: 'A model-supplied explanation of this fragment.' }
  const detail = { kind: 'phrase' as const, pronunciation: '/rɪˈdjuːsɪz ə ˈtensə/', meanings: [{ partOfSpeech: '动词短语',
    meaning: '对张量进行归约', example: 'The operation reduces a tensor.', exampleTranslation: '此操作对张量进行归约。' }] }
  const engine = createHostTranslationEngine({ rpc: { async call() {
    return { ok: true, value: { text: '对张量进行归约', status: 'complete', warnings: [], interpretation, detail } }
  } } }, new AbortController().signal,
  { id: 'dsh-model', name: 'DSH Model', version: '1', execution: 'remote' })
  const result = await engine.translate({ text: interpretation.text, sourceLanguage: 'auto', targetLanguage: 'zh',
    context: { sessionId: 'session' }, signal: new AbortController().signal, timeoutMs: 30_000, maxOutputCharacters: 32768 }, {})
  assert.deepEqual(result.interpretation, interpretation)
  assert.deepEqual(result.detail, detail)
})
