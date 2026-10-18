import assert from 'node:assert/strict'
import test from 'node:test'
import { recognizeInLocalWorker, type LocalOcrAssets, type LocalOcrWorkerRequest } from '../src/ocr/bridge.ts'
import { OcrError, type OcrOutput, type OcrRequest } from '../src/ocr/types.ts'

const assets: LocalOcrAssets = { workerPath: '/worker.js', corePath: '/core', langPath: '/lang', gzip: true }
const request = (): OcrRequest => ({ image: new Uint8Array([1, 2]), width: 4, height: 3, languages: ['eng'] })
const output: OcrOutput = { text: 'one', blocks: [], lines: [], words: [], confidence: null, status: 'complete',
  coverage: [{ x0: 0, y0: 0, x1: 4, y1: 3 }], warnings: [] }
const hasCode = (code: string) => (error: unknown) => error instanceof OcrError && error.code === code

function withWorker<T>(worker: typeof Worker | undefined, run: () => Promise<T>): Promise<T> {
  const original = globalThis.Worker
  if (worker) globalThis.Worker = worker
  else Reflect.deleteProperty(globalThis, 'Worker')
  return run().finally(() => {
    if (original) globalThis.Worker = original
    else Reflect.deleteProperty(globalThis, 'Worker')
  })
}

test('browser OCR bridge reports missing Worker APIs and worker construction failures', async () => {
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(recognizeInLocalWorker({ ...request(), signal: aborted.signal }, assets, '/bridge.js'),
    hasCode('cancelled'))
  await withWorker(undefined, async () => {
    await assert.rejects(recognizeInLocalWorker(request(), assets, '/bridge.js'), hasCode('dependency-unavailable'))
  })
  await withWorker(class { constructor() { throw new Error('Worker blocked by CSP') } } as unknown as typeof Worker, async () => {
    await assert.rejects(recognizeInLocalWorker(request(), assets, '/bridge.js'), hasCode('dependency-unavailable'))
  })
})

test('browser OCR bridge copies request bytes, ignores UI progress failures, resolves once and terminates', async () => {
  let current!: StubWorker
  let terminations = 0
  let posted!: LocalOcrWorkerRequest
  let transfer!: Transferable[]
  class StubWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: (() => void) | null = null
    onmessageerror: (() => void) | null = null
    constructor(path: string, options: WorkerOptions) {
      assert.equal(path, '/bridge.js')
      assert.equal(options.type, 'module')
      current = this
    }
    postMessage(value: LocalOcrWorkerRequest, moved: Transferable[]) {
      posted = value
      transfer = moved
      queueMicrotask(() => {
        this.onmessage?.({ data: { type: 'progress', progress: { stage: 'recognition', progress: 0.5 } } })
        this.onmessage?.({ data: { type: 'result', result: output } })
        this.onmessage?.({ data: { type: 'result', result: { ...output, text: 'late' } } })
      })
    }
    terminate() { terminations++ }
  }
  await withWorker(StubWorker as unknown as typeof Worker, async () => {
    const source = request()
    let progress = 0
    source.onProgress = () => { progress++; throw new Error('observer failed') }
    const result = await recognizeInLocalWorker(source, assets, '/bridge.js')
    assert.equal(result.text, 'one')
    assert.equal(progress, 1)
    assert.equal(terminations, 1)
    assert.notEqual(posted.request.image, source.image)
    assert.deepEqual(posted.request.languages, ['eng'])
    assert.deepEqual(transfer, [(posted.request.image as Uint8Array).buffer])
    assert.equal(current.onmessage, null)
  })
})

test('browser OCR bridge returns explicit error events and postMessage failures', async () => {
  type EventSink = { onmessage: ((event: { data: unknown }) => void) | null;
    onerror: (() => void) | null; onmessageerror: (() => void) | null }
  const testEvent = async (emit: (worker: EventSink) => void, expected: string) => {
    let worker!: StubWorker
    class StubWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror: (() => void) | null = null
      onmessageerror: (() => void) | null = null
      constructor() { worker = this }
      postMessage() { queueMicrotask(() => emit(this)) }
      terminate() {}
    }
    await withWorker(StubWorker as unknown as typeof Worker, async () => {
      await assert.rejects(recognizeInLocalWorker(request(), assets, '/bridge.js'), hasCode(expected))
      assert.equal(worker.onmessage, null)
    })
  }
  await testEvent(worker => worker.onerror?.(), 'dependency-unavailable')
  await testEvent(worker => worker.onmessageerror?.(), 'recognition-failed')
  await testEvent(worker => worker.onmessage?.({ data: { type: 'error', error: { code: 'recognition-failed', message: 'bad output' } } }), 'recognition-failed')

  class ThrowingWorker {
    postMessage() { throw new Error('Cannot clone image') }
    terminate() {}
  }
  await withWorker(ThrowingWorker as unknown as typeof Worker, async () => {
    await assert.rejects(recognizeInLocalWorker(request(), assets, '/bridge.js'), hasCode('recognition-failed'))
  })
})
