import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPageOcrArtifacts, pageOcrArtifactKey, type PageOcrArtifactRequest, type PageOcrInput,
  type OcrProducerIdentity } from '../../../../src/adapters/host/ocr/page-ocr-artifacts.ts'
import { createRetrievalStore } from '../../../../src/adapters/host/filesystem/retrieval-store.ts'
import type { OcrOutput } from '../../../../src/ocr/types.ts'

const digest = `sha256:${'a'.repeat(64)}`
const input: PageOcrInput = { path: '/authorized.pdf', sourceDigest: digest, page: 1, render: {
  renderer: 'pdfium/test', profile: 'clean-2048', geometry: { page: 1, cropBox: [0, 0, 100, 200], rotation: 0, userUnit: 1 },
  width: 100, height: 200, annotations: false, forms: false,
} }
const producer: OcrProducerIdentity = { id: 'fixture', version: '1', fingerprint: 'configuration-one', reusable: true }
const output: OcrOutput = { text: 'Recognized label', blocks: [], lines: [], words: [{ id: 'word', text: 'Recognized',
  box: { x0: 1, y0: 2, x1: 40, y1: 20 }, confidence: null }], confidence: null,
  status: 'complete', coverage: [{ x0: 0, y0: 0, x1: 100, y1: 200 }], warnings: [] }
function request(change: Partial<PageOcrArtifactRequest> = {}): PageOcrArtifactRequest {
  return { input: structuredClone(input), producer: { ...producer }, signal: new AbortController().signal,
    check() {}, async produce() { return { inputDigest: digest, output: structuredClone(output) } }, ...change }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
function cache() {
  const data = new Map<string, unknown>()
  return { data, async get(key: string) { return structuredClone(data.get(key)) },
    async set(key: string, value: unknown) { data.set(key, structuredClone(value)) } }
}

test('raw OCR persists in SQLite across coordinator/store reopening without image bytes or session authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-raw-ocr-'))
  let store = createRetrievalStore({ directory, maxMemoryBytes: 0 }), artifacts = createPageOcrArtifacts({ cache: store, maxBytes: 0 })
  let productions = 0, allowed = true
  const read = request({ check() { if (!allowed) throw Object.assign(new Error('Caller denied'), { code: 'pdf/access-denied' }) },
    async produce() { productions++; return { inputDigest: digest, output } } })
  try {
    const first = await artifacts.read(read)
    await artifacts.dispose(); await store.dispose()
    store = createRetrievalStore({ directory, maxMemoryBytes: 0 }); artifacts = createPageOcrArtifacts({ cache: store, maxBytes: 0 })
    assert.deepEqual(await artifacts.read(read), first)
    assert.equal(productions, 1)
    const record = await store.get(pageOcrArtifactKey(input, producer))
    assert.deepEqual(record, first)
    assert.equal(/sessionId|documentId|permission|png|imageBytes/.test(JSON.stringify(record)), false)
    allowed = false
    await assert.rejects(artifacts.read(read), { code: 'pdf/access-denied' })
    assert.equal(productions, 1, 'persistent data never grants a second caller access')
  } finally { await artifacts.dispose(); await store.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('document/page, source, render pixels/geometry and full producer identity partition artifacts', async () => {
  const artifacts = createPageOcrArtifacts(), base = request()
  let productions = 0
  const produce: PageOcrArtifactRequest['produce'] = async () => { productions++; return { inputDigest: digest, output } }
  const variants = [
    { input: { ...input, path: '/other.pdf' } },
    { input: { ...input, sourceDigest: `sha256:${'b'.repeat(64)}` } },
    { input: { ...input, page: 2 } },
    { input: { ...input, render: { ...input.render, profile: 'different-density' } } },
    { input: { ...input, render: { ...input.render, renderer: 'other-pdfium-build' } } },
    { input: { ...input, render: { ...input.render, width: 101 } } },
    { input: { ...input, render: { ...input.render, geometry: { ...input.render.geometry, rotation: 90 } } } },
    { producer: { ...producer, id: 'other-engine' } },
    { producer: { ...producer, version: '2' } },
    { producer: { ...producer, fingerprint: 'other-config-or-model-or-assets' } },
    { producer: { ...producer, requestIdentity: 'other-languages-or-recognize-options' } },
  ]
  try {
    await artifacts.read({ ...base, produce }); await artifacts.read({ ...base, produce })
    assert.equal(productions, 1)
    for (const variant of variants) await artifacts.read(request({ ...variant, produce }))
    assert.equal(productions, variants.length + 1)
  } finally { await artifacts.dispose() }
})

test('same-page subscribers share one producer; cancelling its first subscriber preserves another session and isolated results', async () => {
  const storage = cache(), artifacts = createPageOcrArtifacts({ cache: storage })
  const started = deferred(), finish = deferred(), first = new AbortController()
  let productions = 0, producerSignal!: AbortSignal
  const produce: PageOcrArtifactRequest['produce'] = async signal => {
    productions++; producerSignal = signal; started.resolve(); await finish.promise; signal.throwIfAborted()
    return { inputDigest: digest, output }
  }
  try {
    const abandoned = artifacts.read(request({ produce, signal: first.signal }))
    const abandonedRejected = assert.rejects(abandoned, /First session cancelled/)
    const remaining = artifacts.read(request({ produce })), third = artifacts.read(request({ produce }))
    await started.promise; first.abort(new Error('First session cancelled'))
    await abandonedRejected
    assert.equal(producerSignal.aborted, false)
    finish.resolve()
    const [a, b] = await Promise.all([remaining, third])
    assert.equal(productions, 1); assert.equal(storage.data.size, 1)
    a.output.words[0]!.text = 'mutated by first consumer'
    assert.equal(b.output.words[0]!.text, 'Recognized')
    assert.equal((await artifacts.read(request({ produce }))).output.words[0]!.text, 'Recognized')
  } finally { finish.resolve(); await artifacts.dispose() }
})

test('all-subscriber cancellation aborts production, avoids publishing late work and admits a fresh retry', async () => {
  const storage = cache(), artifacts = createPageOcrArtifacts({ cache: storage })
  const started = deferred(), finish = deferred(), first = new AbortController(), second = new AbortController()
  let producerSignal!: AbortSignal, productions = 0
  const produce: PageOcrArtifactRequest['produce'] = async signal => {
    productions++; producerSignal = signal; started.resolve(); await finish.promise
    return { inputDigest: digest, output }
  }
  try {
    const a = artifacts.read(request({ produce, signal: first.signal })), b = artifacts.read(request({ produce, signal: second.signal }))
    const rejected = Promise.all([assert.rejects(a, /gone/), assert.rejects(b, /gone/)])
    await started.promise; first.abort(new Error('gone')); second.abort(new Error('gone')); await rejected
    assert.equal(producerSignal.aborted, true)
    await artifacts.read(request({ async produce() { productions++; return { inputDigest: digest, output: { ...output, text: 'Fresh result' } } } }))
    finish.resolve(); await artifacts.dispose()
    assert.equal(productions, 2)
    assert.equal((storage.data.get(pageOcrArtifactKey(input, producer)) as { output: OcrOutput }).output.text, 'Fresh result')
  } finally { finish.resolve(); await artifacts.dispose() }
})

test('source/access fences belong to each subscriber, and no valid subscriber means no cached artifact', async () => {
  for (const surviving of [false, true]) {
    const storage = cache(), artifacts = createPageOcrArtifacts({ cache: storage }), started = deferred(), finish = deferred()
    let valid = true
    const produce: PageOcrArtifactRequest['produce'] = async () => { started.resolve(); await finish.promise; return { inputDigest: digest, output } }
    try {
      const stale = artifacts.read(request({ produce, check() { if (!valid) throw Object.assign(new Error('Source changed'), { code: 'pdf/stale-reader' }) } }))
      const rejected = assert.rejects(stale, { code: 'pdf/stale-reader' })
      const other = surviving ? artifacts.read(request({ produce })) : undefined
      await started.promise; valid = false; finish.resolve(); await rejected
      if (other) assert.equal((await other).output.text, output.text)
      assert.equal(storage.data.size, surviving ? 1 : 0)
    } finally { finish.resolve(); await artifacts.dispose() }
  }
})

test('mismatched persisted provenance and invalid image-space coordinates are misses, while storage failures remain explicit', async () => {
  const storage = cache(), key = pageOcrArtifactKey(input, producer)
  for (const corruption of ['producer', 'dimensions', 'coordinates'] as const) {
    storage.data.set(key, { version: 1, input: corruption === 'dimensions' ? { ...input, render: { ...input.render, width: 101 } } : input,
      producer: corruption === 'producer' ? { ...producer, version: 'wrong' } : producer, inputDigest: digest,
      output: corruption === 'coordinates' ? { ...output, coverage: [{ x0: 0, y0: 0, x1: 1000, y1: 200 }] } : output })
    const artifacts = createPageOcrArtifacts({ cache: storage })
    let productions = 0
    try { await artifacts.read(request({ async produce() { productions++; return { inputDigest: digest, output } } })); assert.equal(productions, 1) }
    finally { await artifacts.dispose() }
  }
  const failure = Object.assign(new Error('Storage damaged'), { code: 'pdf/index-storage-corrupt' })
  const artifacts = createPageOcrArtifacts({ cache: { async get() { throw failure }, async set() { assert.fail('must not overwrite damaged storage') } } })
  try { await assert.rejects(artifacts.read(request()), failure) } finally { await artifacts.dispose() }
})

test('oversized raw OCR output is rejected before it can be persisted', async () => {
  const storage = cache(), artifacts = createPageOcrArtifacts({ cache: storage })
  const largeText = 'x'.repeat(200_000)
  try {
    await assert.rejects(artifacts.read(request({ async produce() {
      return { inputDigest: digest, output: { ...output,
        blocks: Array.from({ length: 22 }, (_, index) => ({ id: String(index), text: largeText, box: null, confidence: null })) } }
    } })), /OCR artifact exceeds the output budget/)
    assert.equal(storage.data.size, 0)
  } finally { await artifacts.dispose() }
})

test('disposing during OCR production rejects subscribers and aborts the producer', async () => {
  const storage = cache(), artifacts = createPageOcrArtifacts({ cache: storage }), started = deferred()
  let producerSignal!: AbortSignal
  const pending = artifacts.read(request({ produce(signal) {
    producerSignal = signal
    started.resolve()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } }))
  const rejected = assert.rejects(pending, /PDF OCR artifacts are unloading/)
  await started.promise
  await artifacts.dispose()
  await rejected
  assert.equal(producerSignal.aborted, true)
  assert.equal(storage.data.size, 0)
  await assert.rejects(artifacts.read(request()), /PDF OCR artifacts are unloading/)
})

test('unattested producer outputs stay in bounded runtime memory and never gain restart reuse', async () => {
  const storage = cache(), privateProducer = { ...producer, reusable: false }
  let productions = 0
  const read = request({ producer: privateProducer, async produce() { productions++; return { inputDigest: digest, output } } })
  for (let reopen = 0; reopen < 2; reopen++) {
    const artifacts = createPageOcrArtifacts({ cache: storage, maxBytes: 8 * 1024 * 1024 })
    try { await artifacts.read(read); await artifacts.read(read) } finally { await artifacts.dispose() }
  }
  assert.equal(productions, 2); assert.equal(storage.data.size, 0)
})

test('clearing the persistent derivative store also invalidates OCR reuse without a stale second hot cache', async () => {
  const storage = cache(), artifacts = createPageOcrArtifacts({ cache: storage })
  let productions = 0
  const read = request({ async produce() { productions++; return { inputDigest: digest, output } } })
  try {
    await artifacts.read(read); storage.data.clear(); await artifacts.read(read)
    assert.equal(productions, 2)
  } finally { await artifacts.dispose() }
})
