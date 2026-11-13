import { createRemoteCall } from './request.js'
import { z } from 'zod'
import type { HostOcrApi } from '../../../client/viewer/index.js'
import type { PdfConnection } from './pdf-api.js'

export type { HostOcrApi, HostOcrAvailability, HostOcrRecognition } from '../../../client/viewer/index.js'

const availability = z.object({
  status: z.enum(['available', 'disabled', 'not-configured', 'unavailable']),
  reason: z.string().optional(),
})
const recognition = z.object({
  documentId: z.string(), page: z.number().int().positive(), revision: z.number().int(),
  contentVersion: z.string(), text: z.string().max(32_768), status: z.enum(['complete', 'partial']),
  source: z.object({ backendId: z.string(), backendVersion: z.string() }),
  geometry: z.object({ status: z.enum(['none', 'partial', 'complete']) }),
  warnings: z.array(z.string()).max(64),
})

/** The Host owns model capability, page rendering, OCR execution, and session authorization. */
export function createHostOcrApi(connection: PdfConnection, lifetime: AbortSignal): HostOcrApi {
  const call = createRemoteCall(connection, lifetime, 'pdf.ocr')
  return {
    availability: async (sessionId, signal) => availability.parse(await call({ action: 'availability', sessionId }, signal)),
    recognize: async (request, signal) => recognition.parse(await call({ action: 'recognize', ...request }, signal)),
  }
}
