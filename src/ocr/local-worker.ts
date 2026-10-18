import { recognizeLocally } from './local.js'
import { OcrError } from './types.js'
import type { LocalOcrWorkerRequest, LocalOcrWorkerResponse } from './bridge.js'

// Kept structural so the plugin's main DOM TypeScript project need not load the
// incompatible duplicate WebWorker lib declarations.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<LocalOcrWorkerRequest>) => void) | null
  postMessage(message: LocalOcrWorkerResponse): void
}

/** Keep the browser Worker entry and the tested message path identical. */
export function createLocalWorkerMessageHandler(
  recognize: typeof recognizeLocally,
  postMessage: (message: LocalOcrWorkerResponse) => void,
): (event: MessageEvent<LocalOcrWorkerRequest>) => Promise<void> {
  return async ({ data }) => {
    try {
      const result = await recognize({
        ...data.request,
        onProgress: (progress) => postMessage({ type: 'progress', progress }),
      }, data.assets)
      postMessage({ type: 'result', result })
    } catch (error) {
      postMessage({
        type: 'error',
        error: error instanceof OcrError ? { code: error.code, message: error.message }
          : { code: 'recognition-failed', message: 'LocalOCR could not recognize the image.' },
      })
    }
  }
}

scope.onmessage = createLocalWorkerMessageHandler(recognizeLocally, (message) => scope.postMessage(message))
