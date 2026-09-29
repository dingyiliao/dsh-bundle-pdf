import assert from 'node:assert/strict'
import test from 'node:test'
import { NavigationHistory, type NavigationPosition } from '../src/navigation/index.js'
import {
  createLocalOcrEngine, createNoneOcrEngine, mapImageBoxToPdf, normalizeTesseractOutput,
  OcrError, OcrRegistry, type LocalOcrDependencies, type OcrEngine, type OcrOutput, type OcrRequest,
} from '../src/ocr/index.js'

const imageRequest = (): OcrRequest => ({ image: new Uint8Array([1, 2, 3]), width: 100, height: 200, languages: ['eng'] })
const emptyOutput = (): OcrOutput => ({
  text: '', blocks: [], lines: [], words: [], confidence: null, status: 'complete',
  coverage: [{ x0: 0, y0: 0, x1: 100, y1: 200 }], warnings: [],
})
const cacheIdentity = { documentId: 'doc', contentVersion: 'v1', page: 1, region: null, renderRevision: 'base/144dpi' } as const
const localAssets = { origin: 'https://dsh.example', workerPath: '/pdf/worker.min.js', corePath: '/pdf/core', langPath: '/pdf/lang' }
const hasCode = (code: string) => (error: unknown) => error instanceof OcrError && error.code === code
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fakeEngine(id: string, recognize: OcrEngine['recognize']): OcrEngine {
  return { descriptor: { id, name: id, version: '1', execution: 'local', geometry: ['word'], confidence: false }, recognize }
}

test('NoneOCR is disabled, never a successful empty page', async () => {
  const registry = new OcrRegistry()
  registry.register(createNoneOcrEngine())
  registry.select({ id: 'off', engineId: 'none', configurationRevision: '1', config: {} })
  assert.equal((await registry.availability()).status, 'disabled')
  await assert.rejects(registry.recognize(imageRequest()), hasCode('disabled'))
})

test('an in-flight request keeps its instance and configuration snapshot after switching', async () => {
  const started = deferred<void>(), finish = deferred<OcrOutput>()
  const registry = new OcrRegistry()
  registry.register(fakeEngine('first', async (_, config) => { assert.equal(config.value, 'old'); started.resolve(); return finish.promise }))
  registry.register(fakeEngine('second', async () => emptyOutput()))
  const config = { value: 'old' }
  registry.select({ id: 'first-account', engineId: 'first', configurationRevision: 'r1', config })
  config.value = 'mutated'
  const oldTask = registry.recognize(imageRequest())
  await started.promise
  registry.select({ id: 'second-account', engineId: 'second', configurationRevision: 'r2', config: {} })
  const next = await registry.recognize(imageRequest())
  finish.resolve({ ...emptyOutput(), text: 'first response' })
  const old = await oldTask
  assert.equal(old.source.engineId, 'first')
  assert.equal(old.source.configurationRevision, 'r1')
  assert.equal(next.source.engineId, 'second')
})

test('cache keys distinguish engine instance, configuration, source and rendering versions', async () => {
  const registry = new OcrRegistry()
  let calls = 0
  registry.register(fakeEngine('a', async () => { calls++; return emptyOutput() }))
  const select = (revision: string) => registry.select({ id: 'account', engineId: 'a', configurationRevision: revision, config: {} })
  select('r1')
  assert.equal((await registry.recognize(imageRequest(), { cacheIdentity })).cached, false)
  assert.equal((await registry.recognize(imageRequest(), { cacheIdentity })).cached, true)
  select('r2')
  await registry.recognize(imageRequest(), { cacheIdentity })
  await registry.recognize(imageRequest(), { cacheIdentity: { ...cacheIdentity, contentVersion: 'v2' } })
  await registry.recognize(imageRequest(), { cacheIdentity: { ...cacheIdentity, renderRevision: 'base/288dpi' } })
  assert.equal(calls, 4)
})

test('removing an engine cancels work and preserves an unavailable selection', async () => {
  const registry = new OcrRegistry()
  const started = deferred<void>()
  const unregister = registry.register(fakeEngine('a', async () => { started.resolve(); return new Promise(() => undefined) }))
  registry.select({ id: 'account', engineId: 'a', configurationRevision: '1', config: {} })
  const task = registry.recognize(imageRequest())
  await started.promise
  unregister()
  await assert.rejects(task, hasCode('engine-unavailable'))
  assert.equal((await registry.availability()).status, 'unavailable')
  assert.equal(registry.getSelection()?.engineId, 'a')
})

test('registry timeout is distinct from an OCR failure and does not silently switch engines', async () => {
  const registry = new OcrRegistry()
  registry.register(fakeEngine('slow', async () => new Promise(() => undefined)))
  registry.select({ id: 'account', engineId: 'slow', configurationRevision: '1', config: {} })
  await assert.rejects(registry.recognize({ ...imageRequest(), timeoutMs: 5 }), hasCode('timeout'))
})

test('LocalOCR refuses external assets before starting a worker', async () => {
  let starts = 0
  const engine = createLocalOcrEngine({ ...localAssets, langPath: 'https://cdn.example/lang' }, {
    async createWorker() { starts++; throw new Error('must not run') },
  })
  await assert.rejects(engine.recognize(imageRequest(), {}), hasCode('not-configured'))
  assert.equal(starts, 0)
})

test('LocalOCR requests structured text geometry and terminates its worker on success', async () => {
  let terminations = 0
  const engine = createLocalOcrEngine(localAssets, {
    async createWorker(languages, mode, options) {
      assert.deepEqual(languages, ['eng'])
      assert.equal(mode, 1)
      assert.equal(options.workerPath, 'https://dsh.example/pdf/worker.min.js')
      assert.equal(options.cacheMethod, 'none')
      assert.equal(options.workerBlobURL, false)
      return {
        async recognize(image, _, output) {
          assert.ok(image instanceof Blob)
          assert.deepEqual(output, { text: true, blocks: true })
          return { data: { text: '', confidence: -1, blocks: null } }
        },
        async terminate() { terminations++ },
      }
    },
  })
  const result = await engine.recognize(imageRequest(), {})
  assert.equal(result.status, 'complete')
  assert.equal(result.confidence, null)
  assert.equal(terminations, 1)
})

test('LocalOCR cancels an active worker once and reports cancellation', async () => {
  let terminations = 0
  const started = deferred<void>(), controller = new AbortController()
  const engine = createLocalOcrEngine(localAssets, {
    async createWorker() {
      return {
        async recognize() { started.resolve(); return new Promise(() => undefined) },
        async terminate() { terminations++ },
      }
    },
  })
  const task = engine.recognize({ ...imageRequest(), signal: controller.signal }, {})
  await started.promise
  controller.abort()
  await assert.rejects(task, hasCode('cancelled'))
  assert.equal(terminations, 1)
})

test('a worker completing initialization after cancellation is still terminated', async () => {
  const ready = deferred<Awaited<ReturnType<LocalOcrDependencies['createWorker']>>>()
  const controller = new AbortController(), terminated = deferred<void>()
  const engine = createLocalOcrEngine(localAssets, { createWorker: async () => ready.promise })
  const task = engine.recognize({ ...imageRequest(), signal: controller.signal }, {})
  controller.abort()
  await assert.rejects(task, hasCode('cancelled'))
  ready.resolve({ async recognize() { throw new Error('should never recognize') }, async terminate() { terminated.resolve() } })
  await terminated.promise
})

test('the browser bridge terminates immediately when cancellation arrives during initialization', async () => {
  const originalWorker = globalThis.Worker
  let terminations = 0
  class BrowserWorker {
    onmessage: unknown = null
    onerror: unknown = null
    onmessageerror: unknown = null
    constructor(path: string, options: WorkerOptions) {
      assert.equal(path, 'https://dsh.example/pdf/bridge.js')
      assert.equal(options.type, 'module')
    }
    postMessage() { /* Simulate Tesseract initialization that never settles. */ }
    terminate() { terminations++ }
  }
  globalThis.Worker = BrowserWorker as unknown as typeof Worker
  try {
    const controller = new AbortController()
    const engine = createLocalOcrEngine({ ...localAssets, bridgePath: '/pdf/bridge.js' })
    const task = engine.recognize({ ...imageRequest(), signal: controller.signal }, {})
    controller.abort()
    await assert.rejects(task, hasCode('cancelled'))
    assert.equal(terminations, 1)
  } finally {
    if (originalWorker) globalThis.Worker = originalWorker
    else Reflect.deleteProperty(globalThis, 'Worker')
  }
})

test('the browser bridge terminates a stuck initialization on timeout', async () => {
  const originalWorker = globalThis.Worker
  let terminations = 0
  class BrowserWorker {
    postMessage() {}
    terminate() { terminations++ }
  }
  globalThis.Worker = BrowserWorker as unknown as typeof Worker
  try {
    const engine = createLocalOcrEngine({ ...localAssets, bridgePath: '/pdf/bridge.js' })
    await assert.rejects(engine.recognize({ ...imageRequest(), timeoutMs: 5 }, {}), hasCode('timeout'))
    assert.equal(terminations, 1)
  } finally {
    if (originalWorker) globalThis.Worker = originalWorker
    else Reflect.deleteProperty(globalThis, 'Worker')
  }
})

test('Tesseract geometry preserves hierarchy and raw confidence without inventing missing boxes', () => {
  const box = { x0: 1, y0: 2, x1: 15, y1: 20 }
  const result = normalizeTesseractOutput({ text: 'hello', confidence: 93, blocks: [{ text: 'hello', bbox: box, paragraphs: [
    { lines: [{ text: 'hello', bbox: box, words: [{ text: 'hello', confidence: 87, bbox: box }, { text: 'unknown' }] }] },
  ] }] }, 100, 200)
  assert.equal(result.words[0]?.parentId, result.lines[0]?.id)
  assert.equal(result.words[0]?.confidence?.value, 87)
  assert.equal(result.words[1]?.box, null)
  assert.equal(result.words[1]?.confidence, null)
})

test('mapping image boxes transforms all four corners, including rotated PDF pages', () => {
  const mapped = mapImageBoxToPdf({ x0: 10, y0: 20, x1: 30, y1: 40 }, (x, y) => [y / 2 + 5, x / 2 + 7])
  assert.deepEqual(mapped.rect, [15, 12, 25, 22])
  assert.deepEqual(mapped.quad, [15, 12, 15, 22, 25, 12, 25, 22])
})

const position = (page: number, y = 700): NavigationPosition => ({
  documentVersion: 'v1', page, x: 0, y, scale: 1.2, rotation: 0, fit: 'custom',
})

test('nested jumps restore the positions at departure in LIFO order; scrolling is not recorded', async () => {
  const history = new NavigationHistory()
  let current = position(1, 350)
  const adapter = { capture: () => current, apply: (target: NavigationPosition) => (current = target) }
  await history.jump(position(7), adapter)
  current = position(7, 210)
  await history.jump({ ...position(9), scale: 2, rotation: 90, fit: 'width' }, adapter)
  assert.equal(history.size, 2)
  await history.back(adapter)
  assert.deepEqual(current, position(7, 210))
  await history.back(adapter)
  assert.deepEqual(current, position(1, 350))
  assert.equal(history.canGoBack, false)
})

test('a no-op or failed jump does not enter history', async () => {
  const history = new NavigationHistory()
  const capture = () => position(1)
  assert.equal((await history.jump(position(1), { capture, apply: () => { throw new Error('should not apply') } })).status, 'noop')
  await assert.rejects(history.jump(position(2), { capture, apply: async () => { throw new Error('broken destination') } }), /broken destination/)
  assert.equal(history.size, 0)
})

test('failed returns retain the record for a later retry', async () => {
  const history = new NavigationHistory()
  let current = position(1)
  const adapter = { capture: () => current, apply: (target: NavigationPosition) => (current = target) }
  await history.jump(position(4), adapter)
  await assert.rejects(history.back({ apply: async () => { throw new Error('render unavailable') } }), /render unavailable/)
  assert.equal(history.size, 1)
  await history.back(adapter)
  assert.equal(current.page, 1)
  assert.equal(history.size, 0)
})

test('a return that reaches the page but loses the original anchor retains history', async () => {
  const history = new NavigationHistory()
  await history.jump(position(4), { capture: () => position(1, 120), apply: (target) => target })
  await assert.rejects(history.back({ apply: (target) => ({ ...target, y: 700 }) }), /restore/)
  assert.equal(history.size, 1)
})

test('cancelled asynchronous jumps cannot commit history when the viewport settles late', async () => {
  const history = new NavigationHistory(), controller = new AbortController()
  const started = deferred<void>(), finish = deferred<NavigationPosition>()
  const jump = history.jump(position(8), { capture: () => position(1), apply: async () => { started.resolve(); return finish.promise } }, controller.signal)
  await started.promise
  controller.abort()
  finish.resolve(position(8))
  assert.equal((await jump).status, 'cancelled')
  assert.equal(history.size, 0)
})

test('queued jumps capture the viewport in navigation order', async () => {
  const history = new NavigationHistory()
  let current = position(1)
  const adapter = { capture: () => current, apply: async (target: NavigationPosition) => { await Promise.resolve(); return current = target } }
  await Promise.all([history.jump(position(4), adapter), history.jump(position(8), adapter)])
  await history.back(adapter)
  assert.equal(current.page, 4)
  await history.back(adapter)
  assert.equal(current.page, 1)
})

test('capacity evicts the oldest return position and source reload clears remaining history', async () => {
  const history = new NavigationHistory({ capacity: 2 })
  let current = position(1)
  const adapter = { capture: () => current, apply: (target: NavigationPosition) => current = target }
  await history.jump(position(2), adapter)
  await history.jump(position(3), adapter)
  await history.jump(position(4), adapter)
  assert.equal(history.size, 2)
  await history.back(adapter)
  await history.back(adapter)
  assert.equal(current.page, 2)
  await history.jump(position(5), adapter)
  assert.equal(history.resetForDocument('v2'), true)
  assert.equal(history.canGoBack, false)
})
