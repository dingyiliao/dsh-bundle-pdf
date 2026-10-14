import assert from 'node:assert/strict'
import test from 'node:test'
import { TranslationError, TranslationRegistry, type TranslationOutput } from '../src/translation/index.ts'

function registryWith(output: TranslationOutput): TranslationRegistry {
  const registry = new TranslationRegistry({ timeoutMs: 30_000, maxInputCharacters: 8192, maxOutputCharacters: 32768 })
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
