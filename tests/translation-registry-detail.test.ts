import assert from 'node:assert/strict'
import test from 'node:test'
import { TranslationError, TranslationRegistry, type TranslationLimits, type TranslationOutput } from '../src/translation/index.ts'

function registryWith(output: TranslationOutput, limits: Partial<TranslationLimits> = {}): TranslationRegistry {
  const registry = new TranslationRegistry({ timeoutMs: 30_000, maxInputCharacters: 8192, maxOutputCharacters: 32768, ...limits })
  registry.register({
    descriptor: { id: 'mock', name: 'Mock', version: '1', execution: 'local' },
    translate: async () => output,
  })
  registry.select({ id: 'mock-instance', engineId: 'mock', configurationRevision: '1', config: {} })
  return registry
}

const request = { text: 'enter', sourceLanguage: 'auto', targetLanguage: 'zh' }

test('translation registry preserves validated lexical detail for the reader', async () => {
  const registry = registryWith({
    text: '/ˈentər/\n进入\nEnter the room. — 走进房间。', status: 'complete', warnings: [],
    detail: { kind: 'word', pronunciation: '/ˈentər/',
      meanings: [{ partOfSpeech: '动词', meaning: '进入', example: 'Enter the room.', exampleTranslation: '走进房间。' }] },
  })
  const result = await registry.translate(request)
  assert.deepEqual(result.detail, { kind: 'word', pronunciation: '/ˈentər/',
    meanings: [{ partOfSpeech: '动词', meaning: '进入', example: 'Enter the room.', exampleTranslation: '走进房间。' }] })
  assert.equal(result.source.engineId, 'mock')
  registry.dispose()
})

test('translation registry preserves more than 24 individually valid meanings', async () => {
  const meanings = Array.from({ length: 25 }, (_, index) => ({
    partOfSpeech: index % 2 ? '名词' : '动词',
    meaning: `含义 ${index + 1}`,
    example: `Use on in example ${index + 1}.`,
    exampleTranslation: `例句 ${index + 1}。`,
  }))
  const registry = registryWith({
    text: meanings.map(item => item.meaning).join('\n'), status: 'complete', warnings: [],
    detail: { kind: 'word', pronunciation: '/ɒn/', meanings },
  })
  const result = await registry.translate({ ...request, text: 'on' })
  assert.deepEqual(result.detail?.meanings, meanings)
  registry.dispose()
})

test('translation registry rejects incomplete lexical detail', async () => {
  const registry = registryWith({
    text: '进入', status: 'complete', warnings: [],
    detail: { kind: 'word', meanings: [{ partOfSpeech: '动词', meaning: '进入', example: '', exampleTranslation: '' }] },
  })
  await assert.rejects(registry.translate(request), (error: unknown) =>
    error instanceof TranslationError && error.code === 'translation-failed')
  registry.dispose()
})

test('translation registry rejects lexical meanings with a missing, blank, or oversized part of speech', async () => {
  for (const partOfSpeech of [undefined, '', '   ', 'x'.repeat(65)]) {
    const registry = registryWith({
      text: '进入', status: 'complete', warnings: [],
      detail: { kind: 'word', meanings: [{
        partOfSpeech: partOfSpeech as string, meaning: '进入',
        example: 'Enter the room.', exampleTranslation: '进入房间。',
      }] },
    })
    await assert.rejects(registry.translate(request), (error: unknown) =>
      error instanceof TranslationError && error.code === 'translation-failed')
    registry.dispose()
  }
})

test('translation engines can return isolated correction and completion metadata without changing the input contract', async () => {
  for (const kind of ['correction', 'completion'] as const) for (const certainty of ['confident', 'tentative'] as const) {
    const interpretation = { text: 'calculate', kind, certainty, explanation: 'Restored the selected source text.' }
    const output: TranslationOutput = { text: '计算', status: 'complete', warnings: [], interpretation }
    const registry = registryWith(output)
    try {
      const result = await registry.translate({ ...request, text: 'calcuiate' })
      assert.deepEqual(result.interpretation, interpretation)
      assert.notEqual(result.interpretation, interpretation)
      interpretation.text = 'changed by provider'
      assert.equal(result.interpretation?.text, 'calculate')
      result.interpretation!.explanation = 'changed by consumer'
      assert.equal(interpretation.explanation, 'Restored the selected source text.')
    } finally { registry.dispose() }
  }
  const registry = registryWith({ text: '旧引擎译文', status: 'complete', warnings: [] })
  try { assert.equal((await registry.translate(request)).interpretation, undefined) }
  finally { registry.dispose() }
})

test('translation registry rejects malformed or partial source interpretations', async () => {
  const valid = { text: 'calculate', kind: 'correction', certainty: 'confident', explanation: 'OCR correction.' }
  const invalid: unknown[] = [null, {}, { ...valid, text: '' }, { ...valid, text: ' '.repeat(3) },
    { ...valid, text: 'x'.repeat(8193) }, { ...valid, kind: 'normalization' }, { ...valid, certainty: 0.9 },
    { ...valid, certainty: 'certain' }, { ...valid, explanation: '' }, { ...valid, explanation: 'x'.repeat(501) },
    { ...valid, extra: 'unrecognized metadata' }]
  for (const interpretation of invalid) {
    const registry = registryWith({ text: '译文', status: 'complete', warnings: [], interpretation } as unknown as TranslationOutput)
    try {
      await assert.rejects(registry.translate(request), error => error instanceof TranslationError && error.code === 'translation-failed')
    } finally { registry.dispose() }
  }
  const partial = registryWith({ text: '译文', status: 'partial', warnings: [], interpretation: valid } as TranslationOutput)
  try { await assert.rejects(partial.translate(request), error => error instanceof TranslationError && error.code === 'translation-failed') }
  finally { partial.dispose() }
})

test('translation registry preserves same-text interpretation and phrase IPA without a semantic veto', async () => {
  const interpretation = { text: 'reduces a tensor', kind: 'completion' as const, certainty: 'tentative' as const,
    explanation: 'A model-supplied explanation of the selected fragment.' }
  const registry = registryWith({ text: '对张量进行归约', status: 'complete', warnings: [], interpretation,
    detail: { kind: 'phrase', pronunciation: '/rɪˈdjuːsɪz ə ˈtensə/', meanings: [{ partOfSpeech: '动词短语',
      meaning: '对张量进行归约', example: 'The operation reduces a tensor.', exampleTranslation: '此操作对张量进行归约。' }] } })
  try {
    const result = await registry.translate({ ...request, text: interpretation.text })
    assert.deepEqual(result.interpretation, interpretation)
    assert.equal(result.detail?.pronunciation, '/rɪˈdjuːsɪz ə ˈtensə/')
  } finally { registry.dispose() }
})

test('source interpretation shares the configured translation input and output budgets', async () => {
  for (const limits of [{ maxInputCharacters: 8 }, { maxOutputCharacters: 20 }]) {
    const registry = registryWith({ text: '计算', status: 'complete', warnings: [], interpretation: {
      text: 'calculate', kind: 'completion', certainty: 'tentative', explanation: 'A plausible completion.',
    } }, limits)
    try {
      await assert.rejects(registry.translate({ ...request, text: 'calc' }),
        error => error instanceof TranslationError && error.code === 'limit-exceeded')
    } finally { registry.dispose() }
  }
})
