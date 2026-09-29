import { getDocument, PDFWorker, type PDFDocumentProxy } from 'pdfjs-dist'

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

/** Opens one real module worker; never transfers the caller's retained PDF bytes. */
export async function openPdf(bytes: Uint8Array, signal?: AbortSignal): Promise<OpenPdf> {
  signal?.throwIfAborted()
  if (typeof Worker === 'undefined') throw new Error('PDF reading requires browser worker support.')
  if (!bytes.byteLength) throw new Error('The PDF file is empty.')
  const lifetime = new AbortController()
  const stopped = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
  const failure = deferred<never>()
  const broken = deferred<void>()
  const ready = deferred<void>()
  let url: string | undefined
  let worker: Worker | undefined
  let bridge: PDFWorker | undefined
  let task: ReturnType<typeof getDocument> | undefined
  let closing: Promise<void> | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  const readyMessage = 'dsh-pdf-plugin-worker-ready'

  const onReady = (event: MessageEvent<unknown>) => {
    const data = event.data
    if (typeof data === 'object' && data !== null && 'type' in data && data.type === readyMessage) ready.resolve()
  }
  const onWorkerError = () => {
    broken.resolve()
    failure.reject(new Error('The PDF worker failed. Reopen the document to retry.'))
    void dispose()
  }
  const onAbort = () => {
    failure.reject(stopped.reason)
    void dispose()
  }
  const dispose = (): Promise<void> => {
    if (closing) return closing
    closing = Promise.resolve().then(async () => {
      if (startupTimer) clearTimeout(startupTimer)
      let teardownTimer: ReturnType<typeof setTimeout> | undefined
      try {
        if (task) {
          // A crashed/unresponsive worker must not keep a closed tab alive.
          await Promise.race([
            task.destroy().catch(() => undefined), broken.promise,
            new Promise<void>((resolve) => { teardownTimer = setTimeout(resolve, 3000) }),
          ])
        }
      } finally {
        if (teardownTimer) clearTimeout(teardownTimer)
        stopped.removeEventListener('abort', onAbort)
        worker?.removeEventListener('message', onReady)
        worker?.removeEventListener('error', onWorkerError)
        worker?.removeEventListener('messageerror', onWorkerError)
        try { bridge?.destroy() } finally {
          worker?.terminate()
          if (url) URL.revokeObjectURL(url)
        }
      }
    }).catch(() => undefined)
    lifetime.abort(new DOMException('PDF view disposed.', 'AbortError'))
    return closing
  }
  stopped.addEventListener('abort', onAbort, { once: true })

  const initialize = async (): Promise<PDFDocumentProxy> => {
    stopped.throwIfAborted()
    url = URL.createObjectURL(new Blob([
      __PDF_PLUGIN_WORKER_SOURCE__,
      `\nself.postMessage({type:${JSON.stringify(readyMessage)}});\n`,
    ], { type: 'text/javascript' }))
    worker = new Worker(url, { type: 'module', name: 'dsh-pdf-plugin' })
    worker.addEventListener('message', onReady)
    worker.addEventListener('error', onWorkerError)
    worker.addEventListener('messageerror', onWorkerError)
    startupTimer = setTimeout(() => {
      failure.reject(new Error('The PDF worker did not start within 15 seconds.'))
      broken.resolve()
      void dispose()
    }, 15_000)
    await Promise.race([ready.promise, failure.promise])
    clearTimeout(startupTimer)
    worker.removeEventListener('message', onReady)
    stopped.throwIfAborted()
    bridge = PDFWorker.create({ port: worker })
    task = getDocument({
      data: bytes.slice(), worker: bridge, BinaryDataFactory: BundledBinaryDataFactory,
      cMapPacked: true, useWorkerFetch: false, enableXfa: false, stopAtErrors: true,
    })
    return task.promise
  }

  try {
    const document = await Promise.race([initialize(), failure.promise])
    stopped.throwIfAborted()
    return { document, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
