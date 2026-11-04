import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NativeDocument, openNativeDocument } from '../../../src/modules/viewer/rendering/document.ts'
import type { NativeDocumentEvents } from '../../../src/modules/viewer/rendering/document.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import type { NativeReaderApi, NativeTextContent, NativeTile, NativeTileRequest } from '../../../src/shared/native.ts'

function snapshot(): WorkspaceSnapshot {
  return { id: 'document', path: '/tmp/recovery.pdf', sourceVersion: 'source', contentVersion: 'content',
    revision: 1, dirty: false, canUndo: false, canRedo: false, conflict: false,
    reader: { bytesHash: `sha256:${'a'.repeat(64)}`, generation: 1, protocolVersion: 1 },
    document: { pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }],
      annotations: [], signed: false, encrypted: false, readOnly: false } }
}

const text: NativeTextContent = { items: [], styles: {}, lang: null }
const tile: NativeTileRequest = { page: 1, rotation: 0, rasterWidth: 400, rasterHeight: 600,
  x: 0, y: 0, width: 100, height: 100, annotations: true }
const raster: NativeTile = { bytes: new Uint8Array([1]), mime: 'image/png', width: 100, height: 100 }

function api(overrides: Partial<NativeReaderApi> = {}): NativeReaderApi {
  return { text: async () => text, tile: async () => raster, links: async () => [],
    outline: async () => null, destination: async () => [0, 'Fit'], ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const paths = [
  { name: 'text', method: 'text', run: (document: NativeDocument) => document.text(1) },
  { name: 'raw text', method: 'text', run: (document: NativeDocument) => document.text(1, undefined, { recover: false }) },
  { name: 'bitmap', method: 'tile', run: (document: NativeDocument) => document.bitmap(tile, new AbortController().signal) },
  { name: 'page links', method: 'links', run: async (document: NativeDocument) => (await document.getPage(1)).getAnnotations() },
  { name: 'outline', method: 'outline', run: (document: NativeDocument) => document.getOutline() },
  { name: 'destination', method: 'destination', run: (document: NativeDocument) => document.getDestination('chapter') },
] as const

for (const path of paths) {
  test(`${path.name}: stale snapshots delegate recovery with document identity, then cancel the read`, async () => {
    const failure = Object.assign(new Error('baseline changed'), { code: 'pdf/stale-reader' })
    let stale = 0, ready = 0
    const document: NativeDocument = new NativeDocument(snapshot(), 'session', api({ [path.method]: async () => { throw failure } }), {
      async onStale(owner, error) { assert.equal(owner, document); assert.equal(error, failure); stale++; owner.retire() },
      onReady() { ready++ },
    })
    await assert.rejects(path.run(document), { name: 'AbortError' })
    assert.equal(stale, 1)
    assert.equal(ready, 0)
    assert.equal(document.diagnostics().bitmapCacheBytes, 0)
    assert.equal(document.diagnostics().textCacheBytes, 0)
  })

  test(`${path.name}: typed stale errors remain intact without a recovery owner`, async () => {
    const failure = Object.assign(new Error('baseline changed'), { code: 'pdf/stale-reader' })
    const document = new NativeDocument(snapshot(), 'session', api({ [path.method]: async () => { throw failure } }))
    await assert.rejects(path.run(document), error => error === failure)
  })

  test(`${path.name}: non-stale errors are not recovered or changed`, async () => {
    const failure = Object.assign(new Error('native worker unavailable'), { code: 'pdf/native-error' })
    let stale = 0
    const document = new NativeDocument(snapshot(), 'session', api({ [path.method]: async () => { throw failure } }), {
      async onStale() { stale++ },
    })
    await assert.rejects(path.run(document), error => error === failure)
    assert.equal(stale, 0)
  })

  test(`${path.name}: retirement promptly cancels an uncooperative native request and ignores its late rejection`, async () => {
    const pending = deferred<never>()
    let receivedSignal: AbortSignal | undefined, stale = 0, ready = 0
    const document = new NativeDocument(snapshot(), 'session', api({ [path.method]: async (...args: unknown[]) => {
      receivedSignal = (path.method === 'text' ? args[4] : args.at(-1)) as AbortSignal
      return pending.promise
    } }), { async onStale() { stale++ }, onReady() { ready++ } })
    const read = path.run(document)
    // getAnnotations first awaits its page proxy.
    await Promise.resolve()
    assert.ok(receivedSignal)
    document.retire()
    await assert.rejects(read, { name: 'AbortError' })
    assert.equal(receivedSignal.aborted, true)
    pending.reject(Object.assign(new Error('old baseline'), { code: 'pdf/stale-reader' }))
    await Promise.resolve()
    assert.equal(stale, 0)
    assert.equal(ready, 0)
  })
}

test('one stale response retires every concurrent read without duplicate stale callbacks', async () => {
  const pendingText = deferred<NativeTextContent>(), pendingLinks = deferred<unknown[]>()
  let calls = 0
  const document = new NativeDocument(snapshot(), 'session', api({
    text: () => pendingText.promise, links: () => pendingLinks.promise,
  }), { async onStale(owner) { calls++; owner.retire() } })
  const reads = [document.text(1), document.links(1)]
  const rejected = Promise.all(reads.map(read => assert.rejects(read, { name: 'AbortError' })))
  pendingText.reject(Object.assign(new Error('baseline changed'), { code: 'pdf/stale-reader' }))
  await rejected
  pendingLinks.reject(Object.assign(new Error('late stale links'), { code: 'pdf/stale-reader' }))
  await Promise.resolve()
  assert.equal(calls, 1)
})

test('onReady waits for a successful native read and runs only once for the document', async () => {
  const ready: NativeDocument[] = []
  const events: NativeDocumentEvents = { onReady(owner) { ready.push(owner) } }
  const opened = await openNativeDocument(snapshot(), 'session', api(), events)
  await opened.document.getPage(1)
  assert.deepEqual(ready, [], 'construction and page proxies do not verify the native baseline')
  await opened.document.text(1)
  await opened.document.text(1)
  await opened.document.links(1)
  await opened.document.getOutline()
  await opened.document.getDestination('chapter')
  assert.deepEqual(ready, [opened.document])
  await opened.dispose()
})

test('a caller abort wins over late successful text and never populates the cache or reports readiness', async () => {
  const pending = deferred<NativeTextContent>(), caller = new AbortController()
  let ready = 0, reads = 0
  const document = new NativeDocument(snapshot(), 'session', api({ async text(_session, _id, _reader, _page, signal) {
    assert.notEqual(signal, caller.signal, 'the caller and document lifetimes are combined')
    reads++
    return reads === 1 ? pending.promise : text
  } }), { onReady() { ready++ } })
  const read = document.text(1, caller.signal)
  caller.abort()
  await assert.rejects(read, { name: 'AbortError' })
  pending.resolve(text)
  await Promise.resolve()
  assert.equal(document.diagnostics().textCacheBytes, 0)
  assert.equal(ready, 0)
  await document.text(1)
  assert.equal(reads, 2, 'the cancelled value is read again rather than cached')
  assert.equal(ready, 1)
})

test('raw native validation and default/explicit OCR repair retain separate per-page cache entries in either order', async () => {
  const raw: NativeTextContent = { ...text, quality: { unmappedCharacters: 2 } }
  const repaired: NativeTextContent = { ...text, extraction: 'local-ocr', warnings: ['Approximate OCR text'] }
  for (const rawFirst of [true, false]) {
    const modes: boolean[] = []
    const document = new NativeDocument(snapshot(), 'session', api({ async text(_session, _id, _reader, _page, _signal, options) {
      modes.push(options?.recover !== false)
      return options?.recover === false ? raw : repaired
    } }))
    try {
      if (rawFirst) assert.deepEqual(await document.text(1, undefined, { recover: false }), raw)
      else assert.deepEqual(await document.text(1), repaired)
      assert.deepEqual(await document.text(1, undefined, { recover: false }), raw)
      assert.deepEqual(await document.text(1), repaired)
      assert.deepEqual(await document.text(1, undefined, { recover: true }), repaired)
      assert.deepEqual(await document.text(1, undefined, {}), repaired)
      assert.deepEqual(await (await document.getPage(1)).getTextContent(), repaired, 'ordinary page text keeps automatic repair after exact native validation')
      assert.deepEqual(modes, rawFirst ? [false, true] : [true, false])
    } finally { await document.dispose() }
  }
})

test('concurrent raw/repaired reads completing out of order cannot overwrite the other representation cache', async () => {
  const raw: NativeTextContent = { ...text, quality: { unmappedCharacters: 1 } }
  const repaired: NativeTextContent = { ...text, extraction: 'local-ocr', warnings: ['OCR is approximate'] }
  for (const delayedRaw of [true, false]) {
    const delayed = deferred<NativeTextContent>(), modes: boolean[] = []
    const document = new NativeDocument(snapshot(), 'session', api({ async text(_session, _id, _reader, _page, _signal, options) {
      const recover = options?.recover !== false
      modes.push(recover)
      return delayedRaw === !recover ? delayed.promise : recover ? repaired : raw
    } }))
    try {
      const pending = document.text(1, undefined, { recover: !delayedRaw })
      assert.deepEqual(await document.text(1, undefined, { recover: delayedRaw }), delayedRaw ? repaired : raw)
      delayed.resolve(delayedRaw ? raw : repaired)
      await pending
      assert.deepEqual(await document.text(1), repaired)
      assert.deepEqual(await document.text(1, undefined, { recover: false }), raw)
      assert.equal(modes.length, 2)
    } finally { delayed.resolve(raw); await document.dispose() }
  }
})

test('a tile arriving after cancellation is never decoded', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  const pending = deferred<NativeTile>(), caller = new AbortController()
  let decoded = 0, ready = 0
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { decoded++; throw new Error('unexpected decode') } })
  try {
    const document = new NativeDocument(snapshot(), 'session', api({ tile: () => pending.promise }), { onReady() { ready++ } })
    const read = document.bitmap(tile, caller.signal)
    caller.abort()
    await assert.rejects(read, { name: 'AbortError' })
    pending.resolve(raster)
    await Promise.resolve()
    assert.equal(decoded, 0)
    assert.equal(ready, 0)
    assert.equal(document.diagnostics().bitmapCacheBytes, 0)
  } finally {
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original)
    else Reflect.deleteProperty(globalThis, 'createImageBitmap')
  }
})

test('cancelling an in-flight bitmap decode closes its late image instead of caching it', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  const pending = deferred<ImageBitmap>(), started = deferred<void>(), caller = new AbortController()
  let closed = 0, ready = 0
  const image = { width: 100, height: 100, close() { closed++ } } as ImageBitmap
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: () => { started.resolve(); return pending.promise } })
  try {
    const document = new NativeDocument(snapshot(), 'session', api(), { onReady() { ready++ } })
    const read = document.bitmap(tile, caller.signal)
    await started.promise
    caller.abort()
    await assert.rejects(read, { name: 'AbortError' })
    pending.resolve(image)
    await Promise.resolve()
    assert.equal(closed, 1)
    assert.equal(ready, 0)
    assert.equal(document.diagnostics().bitmapCacheBytes, 0)
  } finally {
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original)
    else Reflect.deleteProperty(globalThis, 'createImageBitmap')
  }
})

test('retirement preserves the last painted cache until the old document is disposed', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  let closed = 0
  const image = { width: 100, height: 100, close() { closed++ } } as ImageBitmap
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => image })
  try {
    const document = new NativeDocument(snapshot(), 'session', api())
    await document.getPage(1)
    await document.text(1)
    assert.equal(await document.bitmap(tile, new AbortController().signal), image)
    const before = document.diagnostics()
    assert.ok(before.bitmapCacheBytes > 0 && before.textCacheBytes > 0)
    document.retire()
    assert.deepEqual(document.diagnostics(), before)
    assert.equal(closed, 0)
    await assert.rejects(document.bitmap(tile, new AbortController().signal), { name: 'AbortError' })
    await document.dispose()
    assert.equal(closed, 1)
    assert.deepEqual(document.diagnostics(), { bitmapCacheBytes: 0, textCacheBytes: 0, pageProxies: 0 })
  } finally {
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original)
    else Reflect.deleteProperty(globalThis, 'createImageBitmap')
  }
})
