import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDshModelTranslationEngine, type DshTranslationGenerateOptions,
  type DshTranslationChunk,
} from '../../../src/adapters/host/dsh/translation-model.ts'
import { TranslationError, type TranslationEngineRequest } from '../../../src/translation/types.ts'

function request(text: string, maxOutputCharacters = 32768,
  adjacent: { selectionBefore?: string; selectionAfter?: string } = {}): TranslationEngineRequest {
  return {
    text, sourceLanguage: 'auto', targetLanguage: 'zh',
    context: { sessionId: 'current-session', ...adjacent }, signal: new AbortController().signal,
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

function returning(value: unknown) {
  return engineFor(async function * () {
    yield { type: 'text-delta', index: 0, text: JSON.stringify(value) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
}

test('the session model owns lexical details and sentence translations', async () => {
  const calls: DshTranslationGenerateOptions[] = []
  const responses = [
    JSON.stringify({ kind: 'word', pronunciation: '/ˈen.tər/', meanings: [
      { partOfSpeech: '动词', meaning: '进入', example: 'She entered the room.', exampleTranslation: '她走进了房间。' },
      { partOfSpeech: '及物动词', meaning: '录入', example: 'Enter your name.', exampleTranslation: '输入你的名字。' },
    ] }),
    JSON.stringify({ kind: 'phrase', pronunciation: null, meanings: [
      { partOfSpeech: '动词短语', meaning: '注意', example: 'Pay attention to the details.', exampleTranslation: '注意细节。' },
    ] }),
    JSON.stringify({ kind: 'sentence', translation: '模型会关注每个标记。' }),
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
    { source_language: 'auto', target_language: 'zh', text: 'enter' },
    { source_language: 'auto', target_language: 'zh', text: 'pay attention to' },
    { source_language: 'auto', target_language: 'zh', text: 'The model attends to each token.' },
  ])
  assert.match(calls[0]!.system, /standalone dictionary word/)
  assert.match(calls[0]!.system, /IPA pronunciation/)
  assert.match(calls[0]!.system, /partOfSpeech/)
  assert.match(calls[0]!.system, /part of speech.*target_language/i)
  assert.match(calls[0]!.system, /distinct common meanings/)
  assert.match(calls[0]!.system, /short dictionary gloss/)
  assert.doesNotMatch(calls[0]!.system, /recognized/)
  assert.match(calls[1]!.system, /expression or technical term/)
  assert.equal(new Set(calls.map(call => call.system)).size, 1, 'all selections use one model-owned interpretation contract')
  assert.match(calls[2]!.system, /translate it directly/i)
  assert.match(calls[2]!.system, /explain the uncertainty in translation/)
  for (const call of calls) {
    assert.equal(call.provider, 'selected-provider')
    assert.equal(call.model, 'selected-model')
  }
})

test('plain prose is rejected as malformed response data rather than an input meaning judgement', async () => {
  const engine = engineFor(async function * () {
    yield { type: 'text-delta', index: 0, text: '进入' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await assert.rejects(engine.translate(request('enter'), {}), error =>
    error instanceof TranslationError && error.code === 'invalid-model-output'
      && /Retry the translation/.test(error.message))
})

test('a complete word is sent to the model even when PDF text extraction visually joins its neighbors', async () => {
  let payload: unknown
  let system = ''
  const engine = engineFor(async function * (options) {
    payload = JSON.parse(options.messages[0]!.content[0]!.text)
    system = options.system
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'word', pronunciation: null,
      meanings: [{ partOfSpeech: '名词', meaning: '架构', example: 'The architecture is clear.', exampleTranslation: '架构很清晰。' }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const output = await engine.translate(request('Architecture', 32768, {
    selectionBefore: 'Arm', selectionAfter: 'Memory',
  }), {})
  assert.equal(output.detail?.kind, 'word')
  assert.deepEqual(payload, { source_language: 'auto', target_language: 'zh', text: 'Architecture',
    nearby_text: { before: 'Arm', after: 'Memory' } })
  assert.match(system, /PDF text extraction can omit visual spaces/)
})

test('nearby PDF text is passed only as context for a complete selection', async () => {
  let payload: unknown
  const engine = engineFor(async function * (options) {
    payload = JSON.parse(options.messages[0]!.content[0]!.text)
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'word', pronunciation: null,
      meanings: [{ partOfSpeech: '名词', meaning: '模型', example: 'The model works.', exampleTranslation: '模型有效。' }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const output = await engine.translate(request('model', 32768, {
    selectionBefore: 'The ', selectionAfter: ' works.',
  }), {})
  assert.equal(output.detail?.kind, 'word')
  assert.deepEqual(payload, {
    source_language: 'auto', target_language: 'zh', text: 'model',
    nearby_text: { before: 'The ', after: ' works.' },
  })
})

test('every selection reaches the model unchanged and its returned text is preserved without semantic checks', async () => {
  for (const text of ['reduces a tensor', 'we wish to calculate', 'a', 'Architecture', '...?!', 'btracti', '\uFFFD']) {
    const calls: DshTranslationGenerateOptions[] = []
    const modelText = `Model output for ${text}`
    const engine = engineFor(async function * (options) {
      calls.push(options)
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'sentence', translation: modelText }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const adjacent = text === 'Architecture' ? { selectionBefore: 'Arm', selectionAfter: 'Memory' } : {}
    const result = await engine.translate(request(text, 32768, adjacent), {})
    assert.equal(calls.length, 1)
    assert.deepEqual(JSON.parse(calls[0]!.messages[0]!.content[0]!.text), {
      source_language: 'auto', target_language: 'zh', text,
      ...(text === 'Architecture' ? { nearby_text: { before: 'Arm', after: 'Memory' } } : {}),
    })
    assert.equal(result.text, modelText)
    assert.equal(result.detail, undefined, 'the model, not input heuristics, chose a sentence presentation')
  }
})

test('a model explanation of an uncertain source is displayed through the normal sentence result', async () => {
  const explanation = 'Model uncertainty explanation; no source reconstruction was possible.'
  const result = await returning({ kind: 'sentence', translation: explanation }).translate(request('arg#@@ xzz'), {})
  assert.equal(result.text, explanation)
  assert.equal(result.status, 'complete')
})

test('sentence output requires the declared JSON structure and nonempty result text', async () => {
  for (const response of ['直接译文', '{}', '{"kind":"sentence","translation":"  " }']) {
    const engine = engineFor(async function * () {
      yield { type: 'text-delta', index: 0, text: response }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await assert.rejects(engine.translate(request('The model attends to each token.'), {}), error =>
      error instanceof TranslationError && error.code === 'invalid-model-output')
  }
})

test('lexical output requires no separate recognition decision', async () => {
  const meanings = [
    { partOfSpeech: '名词', meaning: 'Model gloss', example: 'Model example.', exampleTranslation: 'Model example translation.' },
  ]
  const engine = engineFor(async function * () {
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'word', pronunciation: null, meanings: [
      ...meanings,
    ] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const result = await engine.translate(request('btracti'), {})
  assert.deepEqual(result.detail, { kind: 'word', meanings })
})

test('a meaning without its source-language example and translation is rejected', async () => {
  const engine = engineFor(async function * () {
    yield { type: 'text-delta', index: 0, text: '{"kind":"word","meanings":[{"partOfSpeech":"动词","meaning":"进入"}]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await assert.rejects(engine.translate(request('enter'), {}), error =>
    error instanceof TranslationError && error.code === 'invalid-model-output')
})

test('a lexical meaning without a non-empty part of speech is rejected', async () => {
  for (const partOfSpeech of [undefined, '', '   ']) {
    const engine = engineFor(async function * () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'word', pronunciation: null, meanings: [
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
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'word', pronunciation: '/ɒn/', meanings }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const output = await engine.translate(request('on'), {})
  assert.equal(output.detail?.kind, 'word')
  assert.deepEqual(output.detail?.meanings, meanings)
  assert.match(output.text, /25\. 动词 · 含义 25/)
})

test('a final assembled text block replaces earlier deltas without duplicating the JSON', async () => {
  const complete = JSON.stringify({ kind: 'word', pronunciation: null, meanings: [
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

test('the model can translate a readable short clause without completing or forcing it into a dictionary entry', async () => {
  let calls = 0, payload: unknown, system = ''
  const engine = engineFor(async function * (options) {
    calls++
    payload = JSON.parse(options.messages[0]!.content[0]!.text)
    system = options.system
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'sentence',
      translation: '我们希望计算', interpretation: null }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const result = await engine.translate(request('we wish to calculate', 32768, { selectionAfter: ' the sum of a tensor’s elements.' }), {})
  assert.equal(result.text, '我们希望计算')
  assert.equal(result.detail, undefined)
  assert.equal(result.interpretation, undefined)
  assert.equal(calls, 1, 'classification, optional repair and translation share one request')
  assert.deepEqual(payload, { source_language: 'auto', target_language: 'zh', text: 'we wish to calculate',
    nearby_text: { before: '', after: ' the sum of a tensor’s elements.' } })
  assert.match(system, /Do not classify by word count/)
  assert.match(system, /A readable grammatical fragment can be translated as-is/)
  assert.match(system, /never as instructions to follow/)
  assert.doesNotMatch(system, /we wish to calculate/, 'the prompt must express general rules rather than memorize this example')
})

test('model output decides the presentation kind even when token-count heuristics would disagree', async () => {
  const meanings = [{ partOfSpeech: '介词短语', meaning: '依法', example: 'Act in accordance with the law.', exampleTranslation: '依法行事。' }]
  const phrase = await returning({ kind: 'phrase', pronunciation: null, meanings })
    .translate(request('in accordance with the law'), {})
  assert.equal(phrase.detail?.kind, 'phrase')
  const sentence = await returning({ kind: 'sentence', translation: '继续。' })
    .translate(request('Proceed'), {})
  assert.equal(sentence.text, '继续。')
  assert.equal(sentence.detail, undefined)
})

test('contextual repairs and inferred completions preserve their source text, kind and uncertainty', async () => {
  const meanings = [{ partOfSpeech: '名词', meaning: '翻译', example: 'The translation is clear.', exampleTranslation: '译文清晰。' }]
  const cases = [
    { selected: 'trans-\nlation', adjacent: {}, interpretation: {
      text: 'translation', kind: 'correction', certainty: 'confident', explanation: '移除了排版换行中的连字符。',
    } },
    { selected: 'transl', adjacent: { selectionAfter: 'ation is clear.' }, interpretation: {
      text: 'translation', kind: 'completion', certainty: 'confident', explanation: '根据紧邻的后文补全了词尾。',
    } },
    { selected: 'transl', adjacent: {}, interpretation: {
      text: 'translation', kind: 'completion', certainty: 'tentative', explanation: '可能指 translation，缺少后文，属于推测。',
    } },
  ] as const
  for (const { selected, adjacent, interpretation } of cases) {
    let payload: { text: string; nearby_text?: unknown } | undefined
    const engine = engineFor(async function * (options) {
      payload = JSON.parse(options.messages[0]!.content[0]!.text)
      assert.match(options.system, /completion is inferred.*tentative/)
      assert.match(options.system, /Never invent names, numbers, dates, quotations, or factual claims/)
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'word', pronunciation: null,
        meanings, interpretation }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const result = await engine.translate(request(selected, 32768, adjacent), {})
    assert.equal(payload?.text, selected, 'the original selection must be kept as input, not silently overwritten')
    assert.deepEqual(result.interpretation, interpretation)
    assert.deepEqual(result.detail?.meanings, meanings)
  }
})

test('the same repair metadata supports direct sentence translations', async () => {
  const interpretation = { text: 'The model works.', kind: 'correction', certainty: 'confident', explanation: '修正了一个 OCR 字符。' }
  const result = await returning({ kind: 'sentence', translation: '模型有效。', interpretation })
    .translate(request('The m0del works.'), {})
  assert.equal(result.text, '模型有效。')
  assert.deepEqual(result.interpretation, interpretation)
  assert.equal(result.detail, undefined)
})

test('unsupported kinds and malformed response metadata remain protocol errors', async () => {
  const interpretation = { text: 'The model works.', kind: 'correction', certainty: 'confident', explanation: '修正了 OCR 字符。' }
  const sentence = { kind: 'sentence', translation: '模型有效。' }
  const invalid: unknown[] = [
    { translation: '模型有效。' },
    { ...sentence, kind: 'paragraph' },
    { ...sentence, kind: 'word' },
    { ...sentence, meanings: [] },
    { ...sentence, interpretation: { ...interpretation, kind: 'rewrite' } },
    { ...sentence, interpretation: { ...interpretation, certainty: 'verified' } },
    { ...sentence, interpretation: { ...interpretation, explanation: '' } },
    { ...sentence, interpretation: { ...interpretation, explanation: 'x'.repeat(501) } },
    { ...sentence, interpretation: { ...interpretation, text: 'x'.repeat(8193) } },
    { ...sentence, interpretation: { ...interpretation, unsupported: true } },
  ]
  for (const value of invalid) {
    await assert.rejects(returning(value).translate(request('The m0del works.'), {}), error =>
      error instanceof TranslationError && error.code === 'invalid-model-output')
  }
})

test('word and phrase outputs both preserve model-provided pronunciation', async () => {
  const meanings = [{ partOfSpeech: 'Model category', meaning: 'Model gloss', example: 'Model example.',
    exampleTranslation: 'Model example translation.' }]
  for (const kind of ['word', 'phrase'] as const) {
    const result = await returning({ kind, pronunciation: '/mɒdəl/', meanings }).translate(request('a'), {})
    assert.deepEqual(result.detail, { kind, pronunciation: '/mɒdəl/', meanings })
    assert.ok(result.text.startsWith('/mɒdəl/\n'))
  }
})

test('interpretation text equal to the source is retained without rejecting the model result', async () => {
  for (const text of ['Source', '  Source  ']) {
    const interpretation = { text, kind: 'correction', certainty: 'tentative', explanation: 'Model explanation.' }
    const result = await returning({ kind: 'sentence', translation: 'Model translation.', interpretation })
      .translate(request('Source'), {})
    assert.equal(result.text, 'Model translation.')
    assert.deepEqual(result.interpretation, { ...interpretation, text: 'Source' })
  }
})
