import assert from 'node:assert/strict'
import test from 'node:test'
import { TranslationRegistry } from '../src/translation/registry.ts'
import { TranslationService } from '../src/translation/service.ts'
import { TranslationError, type TranslationEngine, type TranslationRequest } from '../src/translation/types.ts'

const request = (signal?: AbortSignal): TranslationRequest => ({ text: 'hello', targetLanguage: 'zh', signal })
const hasCode = (code: string) => (error: unknown) => error instanceof TranslationError && error.code === code
const makeService = (translate: TranslationEngine['translate']) => {
  const registry = new TranslationRegistry({ timeoutMs: 1_000, maxInputCharacters: 100, maxOutputCharacters: 100 })
  registry.register({ descriptor: { id: 'fake', name: 'Fake', version: '1', execution: 'local' }, translate })
  registry.select({ id: 'account', engineId: 'fake', configurationRevision: '1', config: {} })
  return { service: new TranslationService(registry), registry }
}

test('translation service validates document identity and waits for a source before translating', async () => {
  const { service, registry } = makeService(async () => ({ text: '你好', status: 'complete', warnings: [] }))
  try {
    await assert.rejects(service.translate(request()), hasCode('invalid-request'))
    assert.throws(() => service.setSource({ documentId: '', contentVersion: 'v1' }), hasCode('invalid-request'))
    assert.throws(() => service.setSource({ documentId: 'doc', contentVersion: '' }), hasCode('invalid-request'))
    const source = { documentId: 'doc', contentVersion: 'v1' }
    service.setSource(source)
    source.documentId = 'mutated'
    service.setSource({ documentId: 'doc', contentVersion: 'v1' })
    const result = await service.translate(request())
    assert.deepEqual(result.document, { documentId: 'doc', contentVersion: 'v1' })
    assert.equal(result.requestId > 0, true)
  } finally { service.dispose(); registry.dispose() }
})

test('translation service cancels in-flight work when the source changes or a newer selection arrives', async () => {
  let started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  const { service, registry } = makeService(async () => {
    started()
    return new Promise(() => undefined)
  })
  try {
    service.setSource({ documentId: 'doc', contentVersion: 'v1' })
    const pending = service.translate(request())
    await began
    service.setSource({ documentId: 'doc', contentVersion: 'v2' })
    await assert.rejects(pending, hasCode('stale-result'))
  } finally { service.dispose(); registry.dispose() }
})

test('translation service propagates caller cancellation, clears source and rejects after disposal', async () => {
  const { service, registry } = makeService(async () => new Promise(() => undefined))
  service.setSource({ documentId: 'doc', contentVersion: 'v1' })
  const controller = new AbortController()
  const pending = service.translate(request(controller.signal))
  controller.abort()
  await assert.rejects(pending, hasCode('cancelled'))
  service.setSource(undefined)
  await assert.rejects(service.translate(request()), hasCode('invalid-request'))
  service.dispose()
  service.dispose()
  assert.throws(() => service.setSource({ documentId: 'doc', contentVersion: 'v2' }), hasCode('cancelled'))
  await assert.rejects(service.translate(request()), hasCode('cancelled'))
  registry.dispose()
})
