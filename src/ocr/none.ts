import { OcrError, type OcrEngine } from './types.js'

export function createNoneOcrEngine(): OcrEngine {
  return {
    descriptor: {
      id: 'none', name: 'NoneOCR', version: '1', execution: 'disabled',
      geometry: [], confidence: false,
    },
    availability: () => ({ status: 'disabled', reason: 'OCR is disabled in PDF settings.' }),
    async recognize() {
      throw new OcrError('disabled', 'OCR is disabled. Select an OCR engine in PDF settings.')
    },
  }
}
