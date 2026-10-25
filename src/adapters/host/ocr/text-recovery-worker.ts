import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
// @ts-expect-error Pinned Tesseract internal dispatcher has no declaration file.
import tesseractDispatcher from 'tesseract.js/src/worker-script/index.js'

const loadCore = createRequire(import.meta.url)
interface Dispatcher {
  setAdapter(adapter: { getCore(): Promise<unknown>; gunzip: typeof gunzipSync;
    readCache: typeof readFile; fetch(): Promise<never> }): void
  dispatchHandlers(packet: unknown, send: (message: unknown) => void): void
}
interface Port {
  on(event: 'message', listener: (packet: unknown) => void): void
  postMessage(message: unknown): void
}

// The pinned Tesseract dispatcher runs directly in this one owned thread (no
// child workers). Its core and language data are shipped, never downloaded.
export function attachTextRecoveryWorker(port: Port, core: string, dispatcher: Dispatcher = tesseractDispatcher): void {
  dispatcher.setAdapter({
    getCore: async () => loadCore(core),
    gunzip: gunzipSync,
    readCache: readFile,
    fetch: async () => { throw new Error('Network access is disabled for PDF text recovery') },
  })
  port.on('message', packet => {
    dispatcher.dispatchHandlers(packet, message => port.postMessage(message))
  })
}
if (parentPort) attachTextRecoveryWorker(parentPort, workerData.core)
