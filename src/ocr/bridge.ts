import { OcrError, type OcrErrorCode, type OcrOutput, type OcrProgress, type OcrRequest } from './types.js'

export interface LocalOcrAssets {
  workerPath: string
  corePath: string
  langPath: string
  gzip: boolean
}

export interface LocalOcrWorkerRequest {
  request: Pick<OcrRequest, 'image' | 'width' | 'height' | 'languages' | 'timeoutMs' | 'options'>
  assets: LocalOcrAssets
}

export type LocalOcrWorkerResponse =
  | { type: 'progress'; progress: OcrProgress }
  | { type: 'result'; result: OcrOutput }
  | { type: 'error'; error: { code: OcrErrorCode; message: string } }

/** The outer worker owns the Tesseract worker, including its initialization lifetime. */
export function recognizeInLocalWorker(request: OcrRequest, assets: LocalOcrAssets, bridgePath: string): Promise<OcrOutput> {
  if (request.signal?.aborted) return Promise.reject(new OcrError('cancelled', 'LocalOCR was cancelled.'))
  if (typeof Worker === 'undefined') return Promise.reject(new OcrError('dependency-unavailable', 'LocalOCR requires browser workers.'))
  return new Promise((resolve, reject) => {
    let worker: Worker
    try { worker = new Worker(bridgePath, { type: 'module', name: 'dsh-local-ocr' }) } catch (error) {
      reject(new OcrError('dependency-unavailable', 'The LocalOCR worker could not be started.', { cause: error }))
      return
    }
    let finished = false
    const cleanup = () => {
      if (finished) return false
      finished = true
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', cancel)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      // Browser worker termination also terminates its child workers, so even a
      // stuck Tesseract initialization cannot outlive a cancelled OCR request.
      worker.terminate()
      return true
    }
    const fail = (error: OcrError) => { if (cleanup()) reject(error) }
    const cancel = () => fail(request.signal?.reason instanceof OcrError
      ? request.signal.reason : new OcrError('cancelled', 'LocalOCR was cancelled.'))
    const timeout = setTimeout(() => fail(new OcrError('timeout', 'LocalOCR exceeded its time limit.')), request.timeoutMs ?? 120_000)
    request.signal?.addEventListener('abort', cancel, { once: true })
    worker.onerror = () => fail(new OcrError('dependency-unavailable', 'The LocalOCR worker or its local assets could not be loaded.'))
    worker.onmessageerror = () => fail(new OcrError('recognition-failed', 'The LocalOCR worker returned an unreadable result.'))
    worker.onmessage = (event: MessageEvent<LocalOcrWorkerResponse>) => {
      if (finished) return
      const message = event.data
      if (message.type === 'progress') {
        try { request.onProgress?.(message.progress) } catch { /* Ignore UI observer failures. */ }
      } else if (message.type === 'error') {
        fail(new OcrError(message.error.code, message.error.message))
      } else if (message.type === 'result' && cleanup()) resolve(message.result)
    }
    if (request.signal?.aborted) { cancel(); return }
    const image = request.image instanceof Uint8Array ? request.image.slice() : request.image
    const message: LocalOcrWorkerRequest = {
      request: { image, width: request.width, height: request.height, languages: [...request.languages], timeoutMs: request.timeoutMs, options: request.options },
      assets,
    }
    try { worker.postMessage(message, image instanceof Uint8Array ? [image.buffer] : []) } catch (error) {
      fail(new OcrError('recognition-failed', 'The OCR image could not be sent to its local worker.', { cause: error }))
    }
  })
}
