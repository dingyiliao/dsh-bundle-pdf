import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeTesseractOutput } from '../../../ocr/local.js'
import type { OcrOutput } from '../../../ocr/types.js'

export interface TextRecovery {
  recognize(png: Uint8Array, width: number, height: number, signal: AbortSignal): Promise<OcrOutput>
  dispose(): Promise<void>
}

/** Lazy, local-only recognition. The PDF service serializes admission and caches positioned results. */
export function createLocalTextRecovery(root = fileURLToPath(new URL(import.meta.url.endsWith('.ts')
  ? '../../../../dist/assets/ocr/' : './assets/ocr/', import.meta.url))): TextRecovery {
  const active = new Set<AbortController>()
  const threads = new Set<Promise<number>>()
  let closed = false
  return {
    async recognize(png, width, height, signal) {
      signal.throwIfAborted()
      if (closed) throw new Error('PDF text recovery is closed')
      const stop = new AbortController(); active.add(stop)
      const abort = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(60000)])
      let worker: Worker
      try {
        worker = new Worker(join(root, 'text-recovery.mjs'), { execArgv: [],
          workerData: { core: join(root, 'core', 'tesseract-core-lstm.js') }, stdout: true, stderr: true })
      } catch {
        active.delete(stop)
        throw new Error('Local PDF text recovery could not start')
      }
      worker.stdout?.resume(); worker.stderr?.resume()
      const exited = new Promise<number>(resolve => { worker.once('exit', resolve) })
      threads.add(exited)
      let sequence = 0
      const request = (action: string, payload: object): Promise<unknown> => new Promise((resolve, reject) => {
        const jobId = String(++sequence)
        const cleanup = () => {
          worker.off('message', message); worker.off('error', error); worker.off('exit', exit)
          abort.removeEventListener('abort', cancel)
        }
        const error = () => { cleanup(); reject(new Error('Local PDF text recovery failed')) }
        const exit = () => error()
        const cancel = () => { cleanup(); reject(abort.reason) }
        const message = (value: { jobId?: string; status?: string; data?: unknown }) => {
          if (value.jobId !== jobId || value.status === 'progress') return
          cleanup()
          if (value.status === 'resolve') resolve(value.data)
          else reject(new Error('Local PDF text recovery failed'))
        }
        worker.on('message', message); worker.once('error', error); worker.once('exit', exit)
        abort.addEventListener('abort', cancel, { once: true })
        if (abort.aborted) { cancel(); return }
        worker.postMessage({ workerId: 'pdf-text-recovery', jobId, action, payload })
      })
      try {
        await request('load', { options: { lstmOnly: true, logging: false } })
        await request('loadLanguage', { langs: ['eng', 'chi_sim'], options: {
          langPath: join(root, 'lang'), cacheMethod: 'none', gzip: true, lstmOnly: true } })
        await request('initialize', { langs: ['eng', 'chi_sim'], oem: 1, config: {} })
        const output = await request('recognize', { image: png, options: {}, output: { text: true, blocks: true } })
        return normalizeTesseractOutput(output, width, height)
      } finally {
        active.delete(stop)
        await worker.terminate()
        await exited
        threads.delete(exited)
      }
    },
    async dispose() {
      closed = true
      for (const controller of active) controller.abort(new Error('PDF text recovery is unloading'))
      await Promise.allSettled([...threads])
    },
  }
}
