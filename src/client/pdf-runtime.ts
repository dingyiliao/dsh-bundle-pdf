import { getDocument, PDFWorker, type PDFDocumentProxy } from 'pdfjs-dist'
import { beginPdfSpan } from '../shared/performance.js'

type AssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'
type BinaryAssets = Readonly<Record<AssetKind, Readonly<Record<string, string>>>>

/** Injected by this plugin's build; worker and binary resources share one PDF.js version. */
declare const __PDF_PLUGIN_WORKER_SOURCE__: string
declare const __PDF_PLUGIN_BINARY_ASSETS__: BinaryAssets

class BundledBinaryDataFactory {
  async fetch({ kind, filename }: { kind: AssetKind; filename: string }): Promise<Uint8Array> {
    const files = __PDF_PLUGIN_BINARY_ASSETS__[kind]
    if (!files || !Object.hasOwn(files, filename)) throw new Error(`Missing local PDF resource: ${kind}/${filename}`)
    // Every call owns independent bytes: PDF.js may transfer/detach the result.
    return Uint8Array.from(atob(files[filename]!), (character) => character.charCodeAt(0))
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export interface OpenPdf {
  document: PDFDocumentProxy
  dispose(): Promise<void>
}

interface DocumentLifetime {
  fail(reason: unknown): void
  dispose(): Promise<void>
}

interface WorkerGeneration {
  readonly dead: boolean
  ready: Promise<PDFWorker>
  failure: Promise<never>
  broken: Promise<void>
  closed: Promise<void>
  documents: Set<DocumentLifetime>
  dispose(reason?: unknown, broken?: boolean): Promise<void>
}

/** One native worker can host several independent PDF.js document transports. */
function createWorkerGeneration(): WorkerGeneration {
  const ready = deferred<void>()
  const failure = deferred<never>()
  const broken = deferred<void>()
  const closed = deferred<void>()
  const documents = new Set<DocumentLifetime>()
  const readyMessage = 'dsh-pdf-plugin-worker-ready'
  // An owner may close before any document has attached its failure handler.
  void failure.promise.catch(() => undefined)
  let dead = false
  let url: string | undefined
  let worker: Worker | undefined
  let bridge: PDFWorker | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let closing: Promise<void> | undefined

  const onReady = (event: MessageEvent<unknown>) => {
    const data = event.data
    if (typeof data === 'object' && data !== null && 'type' in data && data.type === readyMessage) ready.resolve()
  }
  const onWorkerError = () => {
    void dispose(new Error('The PDF worker failed. Reopen the document to retry.'), true)
  }
  const dispose = (reason: unknown = new DOMException('PDF worker disposed.', 'AbortError'), isBroken = false): Promise<void> => {
    if (isBroken) broken.resolve()
    if (closing) return closing
    dead = true
    failure.reject(reason)
    closing = Promise.resolve().then(async () => {
      if (startupTimer) clearTimeout(startupTimer)
      const attached = [...documents]
      for (const document of attached) document.fail(reason)
      try {
        // Each document teardown is bounded independently, and they run in parallel.
        await Promise.allSettled(attached.map(document => document.dispose()))
      } finally {
        worker?.removeEventListener('message', onReady)
        worker?.removeEventListener('error', onWorkerError)
        worker?.removeEventListener('messageerror', onWorkerError)
        try { bridge?.destroy() } finally {
          // PDFWorker created from a caller-owned port does not terminate that native worker.
          worker?.terminate()
          if (url) URL.revokeObjectURL(url)
          documents.clear()
          closed.resolve()
        }
      }
    }).catch(() => { closed.resolve() })
    return closing
  }

  const initialize = async (): Promise<PDFWorker> => {
    url = URL.createObjectURL(new Blob([
      __PDF_PLUGIN_WORKER_SOURCE__,
      `\nself.postMessage({type:${JSON.stringify(readyMessage)}});\n`,
    ], { type: 'text/javascript' }))
    worker = new Worker(url, { type: 'module', name: 'dsh-pdf-plugin' })
    worker.addEventListener('message', onReady)
    worker.addEventListener('error', onWorkerError)
    worker.addEventListener('messageerror', onWorkerError)
    startupTimer = setTimeout(() => {
      void dispose(new Error('The PDF worker did not start within 15 seconds.'), true)
    }, 15_000)
    await Promise.race([ready.promise, failure.promise])
    clearTimeout(startupTimer)
    worker.removeEventListener('message', onReady)
    if (dead) throw new DOMException('PDF worker disposed.', 'AbortError')
    bridge = PDFWorker.create({ port: worker })
    await bridge.promise
    if (dead) throw new DOMException('PDF worker disposed.', 'AbortError')
    return bridge
  }
  const initialized = initialize().catch((error) => { void dispose(error, true); throw error })
  void initialized.catch(() => undefined)
  return { get dead() { return dead }, ready: initialized, failure: failure.promise,
    broken: broken.promise, closed: closed.promise, documents, dispose }
}

/** Caller owns this runtime; revisions reuse its worker while each document owns its loading task. */
export function createPdfRuntime(ownerSignal?: AbortSignal) {
  const generations = new Set<WorkerGeneration>()
  const documents = new Set<DocumentLifetime>()
  let current: WorkerGeneration | undefined
  let closing: Promise<void> | undefined
  let disposed = false

  const generation = (): WorkerGeneration => {
    if (!current || current.dead) {
      const next = createWorkerGeneration()
      generations.add(next)
      current = next
      void next.closed.then(() => generations.delete(next))
    }
    return current
  }

  const dispose = (): Promise<void> => {
    if (closing) return closing
    disposed = true
    ownerSignal?.removeEventListener('abort', onOwnerAbort)
    const reason = ownerSignal?.aborted ? ownerSignal.reason : new DOMException('PDF reader disposed.', 'AbortError')
    // Abort pending initialization immediately, before waiting for document teardown.
    const workers = [...generations]
    const pending = [...documents]
    for (const document of pending) document.fail(reason)
    closing = Promise.allSettled([
      ...workers.map(worker => worker.dispose(reason)),
      ...pending.map(document => document.dispose()),
    ]).then(() => { generations.clear(); documents.clear(); current = undefined })
    return closing
  }
  const onOwnerAbort = () => { void dispose() }
  ownerSignal?.addEventListener('abort', onOwnerAbort, { once: true })
  if (ownerSignal?.aborted) void dispose()

  const openPdf = async (bytes: Uint8Array, signal?: AbortSignal): Promise<OpenPdf> => {
    ownerSignal?.throwIfAborted()
    signal?.throwIfAborted()
    if (disposed) throw new DOMException('PDF reader disposed.', 'AbortError')
    if (typeof Worker === 'undefined') throw new Error('PDF reading requires browser worker support.')
    if (!bytes.byteLength) throw new Error('The PDF file is empty.')
    const worker = generation()
    const lifetime = new AbortController()
    const stopped = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const failure = deferred<never>()
    void failure.promise.catch(() => undefined)
    let task: ReturnType<typeof getDocument> | undefined
    let documentClosing: Promise<void> | undefined

    const fail = (reason: unknown) => {
      failure.reject(reason)
      void disposeDocument(reason)
    }
    const onAbort = () => { fail(stopped.reason) }
    const disposeDocument = (reason: unknown = new DOMException('PDF view disposed.', 'AbortError')): Promise<void> => {
      if (documentClosing) return documentClosing
      documentClosing = Promise.resolve().then(async () => {
        let teardownTimer: ReturnType<typeof setTimeout> | undefined
        try {
          if (task) {
            const outcome = await Promise.race([
              task.destroy().then(() => 'done' as const, () => 'failed' as const),
              worker.broken.then(() => 'broken' as const),
              new Promise<'timeout'>((resolve) => { teardownTimer = setTimeout(() => resolve('timeout'), 3000) }),
            ])
            if (outcome === 'timeout' || outcome === 'failed') {
              // An unresponsive transport must not be reused by another revision.
              void worker.dispose(new Error('The PDF worker could not close a document. Reopen it to retry.'), true)
            }
          }
        } finally {
          if (teardownTimer) clearTimeout(teardownTimer)
          stopped.removeEventListener('abort', onAbort)
          worker.documents.delete(documentLifetime)
          documents.delete(documentLifetime)
        }
      }).catch(() => undefined)
      lifetime.abort(reason)
      return documentClosing
    }
    const documentLifetime: DocumentLifetime = { fail, dispose: disposeDocument }
    worker.documents.add(documentLifetime)
    documents.add(documentLifetime)
    stopped.addEventListener('abort', onAbort, { once: true })

    const initialize = async (): Promise<PDFDocumentProxy> => {
      const bridge = await worker.ready
      stopped.throwIfAborted()
      if (worker.dead) throw new Error('The PDF worker failed. Reopen the document to retry.')
      // Retain the caller's bytes. PDF.js transfers only this independent copy.
      task = getDocument({
        data: bytes.slice(), worker: bridge, BinaryDataFactory: BundledBinaryDataFactory,
        cMapPacked: true, useWorkerFetch: false, enableXfa: false, stopAtErrors: true,
      })
      return task.promise
    }
    const span = beginPdfSpan('client.worker-open', { inputBytes: bytes.byteLength })
    try {
      const document = await Promise.race([initialize(), failure.promise, worker.failure])
      stopped.throwIfAborted()
      span.end('ok', { pageCount: document.numPages })
      return { document, dispose: disposeDocument }
    } catch (error) {
      span.end(stopped.aborted ? 'cancelled' : 'error')
      await disposeDocument()
      throw error
    }
  }
  return { openPdf, dispose }
}

/** Compatibility helper for callers that want a worker owned by just one document. */
export async function openPdf(bytes: Uint8Array, signal?: AbortSignal): Promise<OpenPdf> {
  const runtime = createPdfRuntime(signal)
  try {
    const opened = await runtime.openPdf(bytes, signal)
    return { document: opened.document, dispose: runtime.dispose }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}
