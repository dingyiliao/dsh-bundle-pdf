import type { HostOcrBackend } from '../../../modules/ocr/index.js'
import { OcrError } from '../../../ocr/types.js'
import type { TextRecovery } from './local-text-recovery.js'

/** The owner disposes the shared local worker adapter after unregistering this backend. */
export function createLocalTesseractOcrBackend(recovery: TextRecovery): HostOcrBackend {
  return {
    descriptor: { id: 'local-tesseract', name: 'Local Tesseract OCR', version: 'tesseract.js/7.0.0;eng/1.0.0;chi_sim/1.0.0',
      execution: 'local', capabilities: ['ocr-text'], languages: ['auto', 'en', 'eng', 'zh', 'chi_sim'], geometry: ['block', 'line', 'word'], confidence: true },
    async availability(_sessionId, signal) { signal.throwIfAborted(); return { status: 'available' } },
    async cacheIdentity(_sessionId, signal) { signal.throwIfAborted(); return 'bundled-tesseract-7.0.0-eng-chi_sim-1.0.0-v1' },
    async recognize(request) {
      const signal = request.signal ?? new AbortController().signal
      signal.throwIfAborted()
      if (request.mediaType !== 'image/png') throw new OcrError('invalid-request', 'Local Tesseract OCR requires a PNG image.')
      if (request.languages.some(language => !['auto', 'en', 'eng', 'zh', 'chi_sim'].includes(language))) {
        throw new OcrError('not-configured', 'Local Tesseract OCR includes English and Simplified Chinese only.')
      }
      const bytes = request.image instanceof Uint8Array ? request.image : new Uint8Array(await request.image.arrayBuffer())
      signal.throwIfAborted()
      return recovery.recognize(bytes, request.width, request.height, signal)
    },
  }
}
