import { Worker } from 'node:worker_threads'
import { PdfDocumentError } from '../../../core/pdf-types.js'
import type { PdfDocumentPort } from '../../../modules/working-copy/index.js'
import { measurePdfAsync } from '../../../shared/performance.js'
import type { PdfDocumentWorkerRequest, PdfDocumentWorkerReply } from './document-worker-protocol.js'

const workerUrl = new URL(import.meta.url.endsWith('.ts')
  ? '../../../../dist/pdf-document-worker.mjs' : './pdf-document-worker.mjs', import.meta.url)

type Result = Extract<PdfDocumentWorkerReply, { ok: true }>
const unavailable = (cause?: unknown) =>
  Object.assign(new Error('The PDF document worker is unavailable.', { cause }), { code: 'pdf/unavailable' })

/** A single lazy worker owns pdf-lib's parser, fingerprints and writer. */
export function createPdfLibDocumentAdapter(url = workerUrl): PdfDocumentPort & { dispose(): Promise<void> } {
  let worker: Worker | undefined
  let pending: { resolve(result: Result): void; reject(error: unknown): void } | undefined
  let tail = Promise.resolve()
  let disposal: Promise<void> | undefined

  function start(): Worker {
    let thread: Worker
    try { thread = new Worker(url, { execArgv: [] }) }
    catch (error) { throw unavailable(error) }
    const failed = (error?: unknown) => {
      if (worker !== thread) return
      worker = undefined
      pending?.reject(unavailable(error))
      pending = undefined
    }
    thread.on('error', failed)
    thread.on('messageerror', error => {
      failed(error)
      void thread.terminate().catch(() => undefined)
    })
    thread.once('exit', () => failed())
    thread.on('message', (reply: PdfDocumentWorkerReply) => {
      if (worker !== thread || !pending) return
      const job = pending
      pending = undefined
      thread.unref()
      if (reply.ok) {
        // Structured clone copies the array but does not preserve its freeze.
        if (reply.document.indexPageDigests) Object.freeze(reply.document.indexPageDigests)
        job.resolve(reply)
      } else {
        const { code, message } = reply.error
        job.reject(code ? new PdfDocumentError(code, message) : new Error(message))
      }
    })
    return thread
  }

  function run(request: PdfDocumentWorkerRequest): Promise<Result> {
    const task = tail.then(() => {
      if (disposal) throw unavailable()
      const thread = worker ??= start()
      return new Promise<Result>((resolve, reject) => {
        pending = { resolve, reject }
        thread.ref()
        try {
          const { bytes } = request
          if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
            // The Host still owns these immutable bytes. Structured clone
            // copies them into the worker without detaching the working copy.
            thread.postMessage(request)
          } else {
            // A Buffer view may share a larger slab. Transfer only its bytes.
            const copy = Uint8Array.from(bytes)
            thread.postMessage({ ...request, bytes: copy }, [copy.buffer])
          }
        } catch (error) {
          pending = undefined
          thread.unref()
          reject(error)
        }
      })
    })
    tail = task.then(() => undefined, () => undefined)
    return task
  }

  return {
    inspect: bytes => measurePdfAsync('host.inspect', { inputBytes: bytes.byteLength }, async () =>
      (await run({ action: 'inspect', bytes })).document),
    materialize: (bytes, operations, operationDates) => measurePdfAsync('host.materialize',
      { inputBytes: bytes.byteLength, operationCount: operations.length }, async () => {
        const result = await run({ action: 'materialize', bytes, operations, operationDates })
        if (!result.bytes) throw unavailable()
        return { bytes: result.bytes, document: result.document }
      }),
    dispose() {
      if (disposal) return disposal
      const thread = worker
      worker = undefined
      pending?.reject(unavailable())
      pending = undefined
      disposal = (async () => {
        if (thread) await thread.terminate()
        await tail
      })()
      return disposal
    },
  }
}
