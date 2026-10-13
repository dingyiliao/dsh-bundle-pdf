/** Keep OCR unavailable until its Desktop and model-facing paths are ready. */
export const OCR_AVAILABLE = false

export function effectiveOcrEngine(configured: string): string {
  return OCR_AVAILABLE ? configured : 'none'
}
