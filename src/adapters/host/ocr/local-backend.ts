import type { HostOcrBackend } from '../../../modules/ocr/index.js'
import { OcrError } from '../../../ocr/types.js'
import type { TextRecovery } from './local-text-recovery.js'
import { BUNDLED_LOCAL_OCR_PRODUCER, LOCAL_OCR_ATTESTATION, LOCAL_OCR_VERSION } from './local-identity.js'

/** The owner disposes the shared local worker adapter after unregistering this backend. */
export function createLocalTesseractOcrBackend(recovery: TextRecovery): HostOcrBackend {
  return {
    descriptor: { id: 'local-tesseract', name: 'Local Tesseract OCR', version: LOCAL_OCR_VERSION,
      execution: 'local', capabilities: ['ocr-text'], languages: ['auto', 'en', 'eng', 'zh', 'chi_sim'], geometry: ['block', 'line', 'word'], confidence: true },
    async availability(_sessionId, signal) { signal.throwIfAborted(); return { status: 'available' } },
    async cacheIdentity(_sessionId, signal) {
      signal.throwIfAborted()
      const producer = recovery.producer
      return producer?.reusable && producer.id === BUNDLED_LOCAL_OCR_PRODUCER.id
        && producer.version === BUNDLED_LOCAL_OCR_PRODUCER.version
        && producer.fingerprint === BUNDLED_LOCAL_OCR_PRODUCER.fingerprint ? LOCAL_OCR_ATTESTATION
        : { identity: recovery.producer?.fingerprint ?? 'unattested-text-recovery', reusable: false }
    },
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
