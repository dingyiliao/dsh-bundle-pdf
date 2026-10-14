import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyTranslationSelection, createDshModelTranslationEngine, type DshTranslationGenerateOptions,
  type DshTranslationChunk,
} from '../src/host/translation-model.ts'
import { TranslationError, type TranslationEngineRequest } from '../src/translation/types.ts'

function request(text: string, maxOutputCharacters = 32768): TranslationEngineRequest {
  return {
    text, sourceLanguage: 'auto', targetLanguage: 'zh',
    context: { sessionId: 'current-session' }, signal: new AbortController().signal,
    timeoutMs: 30000, maxOutputCharacters,
  }
}

function engineFor(stream: (options: DshTranslationGenerateOptions) => AsyncIterable<DshTranslationChunk>) {
  return createDshModelTranslationEngine({
    llm: { stream },
    resolveContext: () => ({ provider: 'selected-provider', model: 'selected-model' }),
    maxOutputTokens: 4096,
  })
}

test('selection classification separates words, phrases, and sentences', () => {
  assert.equal(classifyTranslationSelection('enter'), 'word')
  assert.equal(classifyTranslationSelection("don't"), 'word')
  assert.equal(classifyTranslationSelection('机器学习'), 'word')
  assert.equal(classifyTranslationSelection('pay attention to'), 'phrase')
  assert.equal(classifyTranslationSelection('The model attends to each token.'), 'sentence')
  assert.equal(classifyTranslationSelection('The model attends to each token'), 'sentence')
})

test('the session model returns validated lexical detail for words and phrases, but direct text for sentences', async () => {
  const calls: DshTranslationGenerateOptions[] = []
  const responses = [
    JSON.stringify({ pronunciation: '/ˈen.tər/', meanings: [
      { partOfSpeech: '动词', meaning: '进入', example: 'She entered the room.', exampleTranslation: '她走进了房间。' },
      { partOfSpeech: '及物动词', meaning: '录入', example: 'Enter your name.', exampleTranslation: '输入你的名字。' },
    ] }),
    JSON.stringify({ pronunciation: null, meanings: [
      { partOfSpeech: '动词短语', meaning: '注意', example: 'Pay attention to the details.', exampleTranslation: '注意细节。' },
    ] }),
    '模型会关注每个标记。',
  ]
  const engine = engineFor(async function * (options) {
    calls.push(options)
    yield { type: 'text-delta', index: 0, text: responses[calls.length - 1] }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const word = await engine.translate(request('enter'), {})
  const phrase = await engine.translate(request('pay attention to'), {})
  const sentence = await engine.translate(request('The model attends to each token.'), {})

  assert.deepEqual(word.detail, {
    kind: 'word', pronunciation: '/ˈen.tər/', meanings: [
      { partOfSpeech: '动词', meaning: '进入', example: 'She entered the room.', exampleTranslation: '她走进了房间。' },
      { partOfSpeech: '及物动词', meaning: '录入', example: 'Enter your name.', exampleTranslation: '输入你的名字。' },
    ],
  })
  assert.match(word.text, /She entered the room\.\n她走进了房间。/)
  assert.deepEqual(phrase.detail, { kind: 'phrase', meanings: [
    { partOfSpeech: '动词短语', meaning: '注意', example: 'Pay attention to the details.', exampleTranslation: '注意细节。' },
  ] })
  assert.equal(sentence.text, '模型会关注每个标记。')
  assert.equal(sentence.detail, undefined)
  assert.deepEqual(calls.map(call => JSON.parse(call.messages[0]!.content[0]!.text)), [
    { source_language: 'auto', target_language: 'zh', text: 'enter', mode: 'word' },
    { source_language: 'auto', target_language: 'zh', text: 'pay attention to', mode: 'phrase' },
    { source_language: 'auto', target_language: 'zh', text: 'The model attends to each token.', mode: 'sentence' },
  ])
  assert.match(calls[0]!.system, /standalone word/)
  assert.match(calls[0]!.system, /IPA pronunciation/)
  assert.match(calls[0]!.system, /partOfSpeech/)
  assert.match(calls[0]!.system, /part of speech.*target_language/i)
  assert.match(calls[0]!.system, /each distinct relevant meaning/)
  assert.match(calls[1]!.system, /phrase or technical term/)
  assert.match(calls[2]!.system, /Translate it directly/)
  for (const call of calls) {
    assert.equal(call.provider, 'selected-provider')
    assert.equal(call.model, 'selected-model')
  }
})

test('a bare translated word cannot masquerade as a successful word explanation', async () => {
  const engine = engineFor(async function * () {
    yield { type: 'text-delta', index: 0, text: '进入' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await assert.rejects(engine.translate(request('enter'), {}), error =>
    error instanceof TranslationError && error.code === 'invalid-model-output'
      && /Retry the translation/.test(error.message))
})

test('a meaning without its source-language example and translation is rejected', async () => {
  const engine = engineFor(async function * () {
    yield { type: 'text-delta', index: 0, text: '{"meanings":[{"meaning":"进入"}]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await assert.rejects(engine.translate(request('enter'), {}), error =>
    error instanceof TranslationError && error.code === 'invalid-model-output')
})

test('a lexical meaning without a non-empty part of speech is rejected', async () => {
  for (const partOfSpeech of [undefined, '', '   ']) {
    const engine = engineFor(async function * () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ pronunciation: null, meanings: [
        { partOfSpeech, meaning: '进入', example: 'Enter the room.', exampleTranslation: '进入房间。' },
      ] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await assert.rejects(engine.translate(request('enter'), {}), error =>
      error instanceof TranslationError && error.code === 'invalid-model-output')
  }
})

test('a polysemous word preserves every valid meaning without a fixed count cap', async () => {
  const meanings = Array.from({ length: 25 }, (_, index) => ({
    partOfSpeech: index % 2 ? '名词' : '动词',
    meaning: `含义 ${index + 1}`, example: `Use on in example ${index + 1}.`, exampleTranslation: `例句 ${index + 1}。`,
  }))
  const engine = engineFor(async function * () {
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ pronunciation: '/ɒn/', meanings }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const output = await engine.translate(request('on'), {})
  assert.equal(output.detail?.kind, 'word')
  assert.deepEqual(output.detail?.meanings, meanings)
  assert.match(output.text, /25\. 动词 · 含义 25/)
})

test('a final assembled text block replaces earlier deltas without duplicating the JSON', async () => {
  const complete = JSON.stringify({ pronunciation: null, meanings: [
    { partOfSpeech: '动词', meaning: '进入', example: 'Enter the room.', exampleTranslation: '进入房间。' },
  ] })
  const engine = engineFor(async function * () {
    yield { type: 'text-delta', index: 0, text: complete.slice(0, 12) }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: complete } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const output = await engine.translate(request('enter'), {})
  assert.equal(output.detail?.meanings[0]?.example, 'Enter the room.')
  assert.equal(output.text.match(/Enter the room\./g)?.length, 1)
})

test('an incomplete or over-limit lexical stream cannot be shown as a completed explanation', async () => {
  const incomplete = engineFor(async function * () {
    yield { type: 'text-delta', index: 0, text: '{"meanings":[]}' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })
  await assert.rejects(incomplete.translate(request('enter'), {}), error =>
    error instanceof TranslationError && error.code === 'incomplete-model-output')

  const tooLong = engineFor(async function * () {
    yield { type: 'text-delta', index: 0, text: 'x'.repeat(80) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await assert.rejects(tooLong.translate(request('enter', 40), {}), error =>
    error instanceof TranslationError && error.code === 'limit-exceeded')
})
