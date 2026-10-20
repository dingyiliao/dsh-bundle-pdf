import type { PdfRect } from '../../../core/pdf-types.js'

export interface HostOcrAvailability {
  status: 'available' | 'disabled' | 'not-configured' | 'unavailable'
  reason?: string
}

export interface HostOcrRecognition {
  documentId: string
  page: number
  revision: number
  contentVersion: string
  text: string
  status: 'complete' | 'partial'
  source: { backendId: string; backendVersion: string }
  geometry: { status: 'none' | 'partial' | 'complete' }
  warnings: string[]
}

/** Viewer-facing OCR port; transport and model selection remain outside Viewer. */
export interface HostOcrApi {
  availability(sessionId: string, signal?: AbortSignal): Promise<HostOcrAvailability>
  recognize(request: { sessionId: string; documentId: string; page: number; region?: PdfRect },
    signal?: AbortSignal): Promise<HostOcrRecognition>
}
