import { z } from 'zod'
import type { PdfDispatch } from './transport.js'
import { ImageUnderstandingError, MAX_IMAGE_BYTES, MAX_QUESTION_CHARACTERS,
  type HostImageUnderstandingService } from './image-understanding-service.js'

export const MAX_IMAGE_BASE64_CHARACTERS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
export const MAX_IMAGE_REQUEST_BYTES = MAX_IMAGE_BASE64_CHARACTERS + 16_384

const identity = z.string().min(1).max(512)
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('availability'), sessionId: identity }).strict(),
  z.object({ action: z.literal('prepare'), sessionId: identity,
    image: z.object({ mediaType: z.literal('image/png'), data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARACTERS),
      width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) }).strict(),
    question: z.string().min(1).max(MAX_QUESTION_CHARACTERS) }).strict(),
])

/** Connection authenticates the RPC before this dispatch verifies its Session identity. */
export function createImageUnderstandingDispatch(service: HostImageUnderstandingService): PdfDispatch {
  return async (sessionId, input, agent, signal) => {
    const parsed = request.safeParse(input)
    if (!parsed.success) throw new ImageUnderstandingError('pdf/image-invalid-request', 'Invalid image request.')
    const args = parsed.data
    if (args.sessionId !== sessionId || agent.session.id !== sessionId) {
      throw new ImageUnderstandingError('pdf/session-mismatch', 'Session identity mismatch.')
    }
    signal.throwIfAborted()
    if (args.action === 'availability') return service.availability(sessionId, signal)
    const { data, width, height, mediaType } = args.image
    if (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new ImageUnderstandingError('pdf/image-invalid-request', 'Image data must be canonical Base64.')
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.byteLength > MAX_IMAGE_BYTES || bytes.toString('base64') !== data) {
      throw new ImageUnderstandingError('pdf/image-invalid-request', 'Image data exceeds the limit or is not canonical Base64.')
    }
    return service.prepare({ sessionId, image: { mediaType, data: bytes, width, height },
      question: args.question, signal })
  }
}
