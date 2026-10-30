import assert from 'node:assert/strict'
import test from 'node:test'
import { EngineCatalog, EngineDirectory } from '../../../src/modules/engines/index.ts'
import { createEngineCatalogStore } from '../../../src/adapters/client/remote/engine-catalog.ts'
import { createTranslationDirectoryMirror } from '../../../src/adapters/client/remote/translation-directory.ts'
import { createPdfInfoRoute } from '../../../src/adapters/host/dsh/info-route.ts'
import { TranslationRegistry } from '../../../src/translation/index.ts'

const descriptor = { id: 'fixture.engine', name: 'Fixture engine', version: '1', execution: 'local' as const,
  capabilities: ['ocr-text' as const] }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2500
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Engine directory did not synchronize')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('directory changes cross the real RPC envelope without client restart; disconnect retains the last list', async () => {
  const catalog = new EngineCatalog(), directory = new EngineDirectory<{ descriptor: typeof descriptor }>(value => value.descriptor)
  catalog.attach('ocr', directory)
  const lifetime = new AbortController()
  let offline = false, calls = 0
  const route = createPdfInfoRoute((payload, signal) => catalog.wait((payload as { revision?: string }).revision, signal!), 'pdf.engines')
  const store = createEngineCatalogStore({ rpc: { async call(_path, method, payload, signal) {
    calls++
    if (offline) throw new Error('Connection unavailable')
    const response = await route.fetch(new Request(`https://example.test/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', method, rpcId: 'engines-fixture', payload }),
    }))
    if (offline) throw new Error('Reply lost during disconnect')
    return (await response.json() as { result: unknown }).result
  } } }, lifetime.signal, catalog.read())
  const stop = store.subscribe(() => {})
  try {
    const remove = directory.register({ descriptor })
    await until(() => store.getSnapshot().engines.ocr.length === 1)
    assert.equal(store.getSnapshot().engines.ocr[0]?.id, descriptor.id)
    assert.deepEqual(store.getSnapshot().engines.ocr[0]?.capabilities, ['ocr-text'])
    remove()
    await until(() => store.getSnapshot().engines.ocr.length === 0)
    const removeAgain = directory.register({ descriptor })
    await until(() => store.getSnapshot().engines.ocr.length === 1)
    const callsAtDisconnect = calls
    offline = true
    removeAgain()
    // Lost replies retain the last directory, even if the Host changed meanwhile.
    await until(() => calls > callsAtDisconnect)
    const last = store.getSnapshot()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(store.getSnapshot(), last)
    offline = false
    await until(() => store.getSnapshot().engines.ocr.length === 0)
  } finally { stop(); store.dispose(); lifetime.abort(); catalog.dispose(); directory.dispose() }
})

test('translation mirror leaves unchanged providers running and unload aborts their proxy requests', async () => {
  const lifetime = new AbortController(), registry = new TranslationRegistry({ timeoutMs: 1000, maxInputCharacters: 100, maxOutputCharacters: 100 })
  let started!: () => void, signal: AbortSignal | undefined
  const entered = new Promise<void>(resolve => { started = resolve })
  const mirror = createTranslationDirectoryMirror(registry, { rpc: { async call(_path, _method, _payload, requestSignal) {
    signal = requestSignal; started()
    return new Promise(() => {})
  } } }, lifetime.signal)
  try {
    mirror.update([descriptor])
    registry.select({ id: 'fixture', engineId: descriptor.id, configurationRevision: '1', config: {} })
    const request = registry.translate({ text: 'Fixture', targetLanguage: 'zh', context: { sessionId: 'fixture-session' } })
    const rejected = assert.rejects(request, { code: 'engine-unavailable' })
    await entered
    mirror.update([structuredClone(descriptor)])
    assert.equal(signal?.aborted, false)
    mirror.update([])
    await rejected
    assert.equal(signal?.aborted, true)
    assert.equal(registry.getSelection()?.engineId, descriptor.id)
    await assert.rejects(registry.translate({ text: 'Fixture', targetLanguage: 'zh' }), { code: 'engine-unavailable' })
    mirror.update([{ ...descriptor, version: '2' }])
    assert.equal(registry.list()[0]?.version, '2')
  } finally { mirror.dispose(); registry.dispose(); lifetime.abort() }
})
