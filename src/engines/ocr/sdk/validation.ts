import { OcrError, type OcrBox, type OcrOutput, type OcrRequest } from './types.js'

export function validateOcrRequest(request: OcrRequest): void {
  if (!Number.isInteger(request.width) || !Number.isInteger(request.height) || request.width <= 0 || request.height <= 0) {
    throw new OcrError('invalid-request', 'OCR image dimensions must be positive integers.')
  }
  if (!(request.image instanceof Uint8Array) && !(request.image instanceof Blob)) {
    throw new OcrError('invalid-request', 'OCR requires encoded image bytes or an image Blob.')
  }
  const bytes = request.image instanceof Uint8Array ? request.image.byteLength : request.image.size
  if (!bytes) throw new OcrError('invalid-request', 'The OCR image is empty.')
  if (!request.languages.length || request.languages.some((language) => !/^[a-zA-Z0-9_-]+$/.test(language))) {
    throw new OcrError('invalid-request', 'Select at least one valid OCR language.')
  }
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 600_000)) {
    throw new OcrError('invalid-request', 'OCR timeout must be between 1 and 600000 milliseconds.')
  }
}

export function validateOcrOutput(output: OcrOutput, request: OcrRequest): OcrOutput {
  const validBox = (box: OcrBox) => [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
    && box.x0 >= 0 && box.y0 >= 0 && box.x1 >= box.x0 && box.y1 >= box.y0
    && box.x1 <= request.width && box.y1 <= request.height
  if (typeof output.text !== 'string' || !['complete', 'partial'].includes(output.status)
    || !Array.isArray(output.coverage) || !output.coverage.every(validBox)
    || ![output.words, output.lines, output.blocks].every((parts) => Array.isArray(parts)
      && parts.every((part) => typeof part.text === 'string' && (part.box === null || validBox(part.box))))) {
    throw new OcrError('recognition-failed', 'OCR engine returned malformed text or image coordinates.')
  }
  return output
}
