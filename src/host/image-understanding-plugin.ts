import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { createOcrTextBackend, createSessionVisionBackend, HostImageUnderstandingService } from './image-understanding-service.js'
import { createAuxiliaryVisionBackend } from './image-understanding-auxiliary.js'
import type { SessionOcrAttachmentStore, SessionOcrLlm } from './ocr-session-llm.js'
import { createImageUnderstandingDispatch, MAX_IMAGE_REQUEST_BYTES } from './image-understanding-transport.js'
import { registerPdfTransport } from './transport.js'

export type { ImageUnderstandingBackend, ImageUnderstandingAvailability, ImageUnderstandingPreparation,
  ImageUnderstandingRequest } from './image-understanding-service.js'
export { HostImageUnderstandingService } from './image-understanding-service.js'

/** Independent Host extension. Other plugins may register a derived-text backend. */
export const name = 'image-understanding'
export const provide = 'imageUnderstanding'
export const inject = ['connection', 'sessionController']
export const Config = z.object({
  backend: z.string().min(1).max(128).default('session-vision'),
  auxiliaryVision: z.object({
    provider: z.string().min(1).max(128), model: z.string().min(1).max(256),
    reasoningEffort: z.string().min(1).max(128).optional(),
    maxOutputTokens: z.number().int().min(1).max(16_384).optional(),
  }).optional(),
})
  .default({ backend: 'session-vision' })
export type Config = z.infer<typeof Config>

export function apply(ctx: Context, config: Config): void {
  const service = new HostImageUnderstandingService(ctx, () => config.backend)
  ctx.effect(() => () => service.dispose(), 'image-understanding: dispose requests')
  ctx.effect(() => service.register(createSessionVisionBackend(ctx)), 'image-understanding: session vision backend')
  ctx.effect(() => service.register(createOcrTextBackend(ctx)), 'image-understanding: OCR text backend')
  ctx.effect(() => service.register(createAuxiliaryVisionBackend({
    selectedModel: () => config.auxiliaryVision,
    getLlm: () => ctx.get('llm') as SessionOcrLlm | undefined,
    getAttachments: () => ctx.get('attachments') as SessionOcrAttachmentStore | undefined,
    maxOutputTokens: config.auxiliaryVision?.maxOutputTokens,
  })), 'image-understanding: optional auxiliary vision backend')
  ctx.effect(() => registerPdfTransport(ctx as unknown as Parameters<typeof registerPdfTransport>[0],
    createImageUnderstandingDispatch(service), { endpoint: 'pdf.image', maxRequestBytes: MAX_IMAGE_REQUEST_BYTES }),
  'image-understanding: authenticated PDF image route')
}
