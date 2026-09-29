import { recognizeLocally } from './local.js'
import { OcrError } from './types.js'
import type { LocalOcrWorkerRequest, LocalOcrWorkerResponse } from './bridge.js'

// Kept structural so the plugin's main DOM TypeScript project need not load the
// incompatible duplicate WebWorker lib declarations.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<LocalOcrWorkerRequest>) => void) | null
  postMessage(message: LocalOcrWorkerResponse): void
}

scope.onmessage = async ({ data }) => {
  try {
    const result = await recognizeLocally({
      ...data.request,
      onProgress: (progress) => scope.postMessage({ type: 'progress', progress }),
    }, data.assets)
    scope.postMessage({ type: 'result', result })
  } catch (error) {
    scope.postMessage({
      type: 'error',
      error: error instanceof OcrError ? { code: error.code, message: error.message }
        : { code: 'recognition-failed', message: 'LocalOCR could not recognize the image.' },
    })
  }
}
