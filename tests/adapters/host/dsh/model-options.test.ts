import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfModelOptions } from '../../../../src/adapters/host/dsh/model-options.ts'
import { modelOptionsRequestSchema, visionModelCatalogSchema } from '../../../../src/contracts/model-options.ts'

const signal = new AbortController().signal
const model = (id: string) => ({ id, name: `Model ${id}` })
const group = (id: string, ids: string[]) => ({ id, name: `Provider ${id}`, models: ids.map(model) })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

test('model options reuse the official catalog, retain provider order and only expose declared visual models', async () => {
  let catalogReads = 0
  const controller = {
    async modelCatalog() {
      catalogReads++
      return { default: { provider: 'a', model: 'text' }, groups: [
        { ...group('a', ['text', 'vision']), endpoint: 'not returned', models: [model('text'),
          { ...model('vision'), apiKey: 'not returned', reasoning: { defaultEffort: 'medium',
            efforts: [{ id: 'medium', name: 'Medium', description: 'Extra advisory copy' }] } }] },
        group('b', ['other-vision']),
      ], failures: [], arbitraryData: 'not returned' }
    },
    selectModel() { assert.fail('selecting a PDF engine model must not change the conversation') },
  }
  const seen: string[] = []
  const read = createPdfModelOptions(controller, () => ({ async resolveModelInfo(provider, id, active) {
    seen.push(`${provider}/${id}`); assert.equal(active.aborted, false)
    return { inputModalities: id === 'text' ? ['text'] : ['text', 'image'], credentials: 'not returned' }
  } }), signal)
  const result = await read({}, signal)
  assert.equal(catalogReads, 1)
  assert.deepEqual(seen, ['a/text', 'a/vision', 'b/other-vision'])
  assert.deepEqual(result, { groups: [{ id: 'a', name: 'Provider a', models: [{ ...model('vision'),
    reasoning: { defaultEffort: 'medium', efforts: [{ id: 'medium', name: 'Medium' }] } }] },
  group('b', ['other-vision'])], failures: [] })
  assert.doesNotMatch(JSON.stringify(result), /not returned|apiKey|credentials|endpoint|description/)
  assert.deepEqual(visionModelCatalogSchema.parse(result), result)
})

test('independently verified models survive partial failures and unknown capability never becomes visual support', async () => {
  const read = createPdfModelOptions({ async modelCatalog() { return {
    groups: [group('a', ['vision', 'unknown', 'broken']), group('text', ['plain'])],
    failures: [{ id: 'offline', name: 'Offline provider', message: 'Provider is unavailable: token=private' }],
  } } }, () => ({ async resolveModelInfo(_provider, id) {
    if (id === 'broken') throw new Error('Private URL and token must not reach the Client')
    if (id === 'unknown') return {}
    return { inputModalities: id === 'vision' ? ['image'] : ['text'] }
  } }), signal)
  const result = await read(undefined, signal)
  assert.deepEqual(result.groups, [group('a', ['vision'])])
  assert.deepEqual(result.failures.map(item => item.id), ['offline', 'a'])
  assert.doesNotMatch(JSON.stringify(result), /Private URL|token/)
})

test('metadata fan-out is bounded and completion order cannot reorder the displayed model catalog', async () => {
  const gates = new Map<string, ReturnType<typeof deferred<{ inputModalities: string[] }>>>()
  for (let i = 0; i < 9; i++) gates.set(String(i), deferred())
  let active = 0, peak = 0
  const read = createPdfModelOptions({ async modelCatalog() { return {
    groups: [group('a', [...gates.keys()])], failures: [],
  } } }, () => ({ async resolveModelInfo(_provider, id) {
    active++; peak = Math.max(peak, active)
    try { return await gates.get(id)!.promise } finally { active-- }
  } }), signal)
  const pending = read({}, signal)
  await Promise.resolve(); await Promise.resolve()
  for (const ids of [['3', '2', '1', '0'], ['7', '6', '5', '4'], ['8']]) {
    for (const id of ids) gates.get(id)!.resolve({ inputModalities: ['image'] })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  }
  const result = await pending
  assert.ok(peak > 1 && peak <= 4)
  assert.deepEqual(result.groups[0]!.models.map(item => item.id), [...gates.keys()])
})

test('invalid requests, absent public APIs and invalid catalogs fail explicitly before model calls', async () => {
  let reads = 0, probes = 0
  const controller = { async modelCatalog() { reads++; return { groups: [], failures: [] } } }
  const llm = () => ({ async resolveModelInfo() { probes++; return { inputModalities: ['image'] } } })
  const read = createPdfModelOptions(controller, llm, signal)
  await assert.rejects(read({ provider: 'forged' }, signal))
  assert.equal(reads, 0)
  assert.deepEqual(modelOptionsRequestSchema.parse(undefined), {})
  await assert.rejects(createPdfModelOptions({}, llm, signal)({}, signal), { code: 'pdf/model-catalog-unavailable' })
  await assert.rejects(createPdfModelOptions(controller, () => undefined, signal)({}, signal), { code: 'pdf/model-catalog-unavailable' })
  for (const value of [null, { groups: [] }, { groups: [group('a', ['same', 'same'])], failures: [] },
    { groups: [group('a', ['one']), group('a', ['two'])], failures: [] },
    { groups: [group('a', Array.from({ length: 1025 }, (_, i) => String(i)))], failures: [] }]) {
    await assert.rejects(createPdfModelOptions({ async modelCatalog() { return value } }, llm, signal)({}, signal),
      { code: 'pdf/model-catalog-unavailable' })
  }
  assert.equal(probes, 0)
})

test('request cancellation and plugin unload reject noncooperative catalog work without exposing late output', async () => {
  for (const owner of ['request', 'plugin'] as const) {
    const caller = new AbortController(), lifetime = new AbortController(), gate = deferred<unknown>()
    let probes = 0
    const read = createPdfModelOptions({ modelCatalog: () => gate.promise }, () => ({ async resolveModelInfo() {
      probes++; return { inputModalities: ['image'] }
    } }), lifetime.signal)
    const pending = read({}, caller.signal)
    const rejected = assert.rejects(pending, { code: 'pdf/model-catalog-cancelled' })
    if (owner === 'request') caller.abort(); else lifetime.abort()
    await rejected
    gate.resolve({ groups: [group('a', ['late'])], failures: [] })
    await Promise.resolve(); await Promise.resolve()
    assert.equal(probes, 0)
    if (owner === 'plugin') await assert.rejects(read({}, signal), /abort/i)
  }
})

test('cancellation is forwarded to metadata probes and a bounded timeout does not retain a request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lifetime = new AbortController(), entered = deferred<AbortSignal>()
  const read = createPdfModelOptions({ async modelCatalog() { return { groups: [group('a', ['slow'])], failures: [] } } },
    () => ({ async resolveModelInfo(_provider, _model, active) {
      entered.resolve(active)
      return new Promise<never>(() => {})
    } }), lifetime.signal)
  const pending = read({}, signal)
  const rejected = assert.rejects(pending, { code: 'pdf/model-catalog-timeout' })
  const active = await entered.promise
  t.mock.timers.tick(30_000)
  await rejected
  assert.equal(active.aborted, true)
})

test('request abort or unload during metadata inspection cannot publish a late visual model', async () => {
  for (const owner of ['request', 'plugin'] as const) {
    const caller = new AbortController(), lifetime = new AbortController()
    const entered = deferred<AbortSignal>(), gate = deferred<unknown>()
    const read = createPdfModelOptions({ async modelCatalog() { return { groups: [group('a', ['late'])], failures: [] } } },
      () => ({ async resolveModelInfo(_provider, _model, active) { entered.resolve(active); return gate.promise } }), lifetime.signal)
    const pending = read({}, caller.signal)
    const rejected = assert.rejects(pending, { code: 'pdf/model-catalog-cancelled' })
    const active = await entered.promise
    if (owner === 'request') caller.abort(); else lifetime.abort()
    await rejected
    assert.equal(active.aborted, true)
    gate.resolve({ inputModalities: ['image'] })
    await Promise.resolve(); await Promise.resolve()
  }
})
