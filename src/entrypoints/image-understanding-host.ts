import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { createImageUnderstandingDispatch, MAX_IMAGE_REQUEST_BYTES, registerPdfTransport,
  type PdfImageEvidenceResolver, type SessionOcrAttachmentStore, type SessionOcrLlm } from '../adapters/host/dsh/index.js'
import { createDshVisionBackend, resolveSessionVisionModel, supportsSessionImages } from '../adapters/host/dsh/image-backends.js'
import { HostImageUnderstandingService, ImageUnderstandingError } from '../modules/image-understanding/index.js'
import { pdfCapabilities } from '../modules/capabilities/index.js'
import { createPdfEngineRouting } from '../adapters/host/dsh/engine-routing.js'

export type { ImageUnderstandingBackend, ImageUnderstandingAvailability, ImageUnderstandingResult,
  ImageUnderstandingRequest } from '../modules/image-understanding/index.js'
export { HostImageUnderstandingService } from '../modules/image-understanding/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    imageUnderstanding: HostImageUnderstandingService
    pdfImageEvidence: PdfImageEvidenceResolver
  }
}

/** Independent Host extension. Other plugins register image-to-text implementations. */
export const name = 'image-understanding'
export const provide = 'imageUnderstanding'
export const inject = ['connection', 'sessionController']
export const Config = z.object({ backend: z.string().min(1).max(128).default('dsh-vision') })
  .default({ backend: 'dsh-vision' })
export type Config = z.infer<typeof Config>

export function apply(ctx: Context, config: Config): void {
  const service = new HostImageUnderstandingService(() => config.backend)
  const routing = createPdfEngineRouting(ctx)
  const references: PdfImageEvidenceResolver = {
    resolve(sessionId, documentId, refId, signal) {
      const mounted = ctx.get('pdfImageEvidence')
      if (!mounted) {
        throw new ImageUnderstandingError('pdf/reference-unavailable', 'PDF image references are not mounted.')
      }
      return mounted.resolve(sessionId, documentId, refId, signal)
    },
  }
  ctx.reflect.provide('imageUnderstanding', service)
  ctx.effect(() => () => service.dispose(), 'image-understanding: dispose requests')
  ctx.effect(() => service.register(createDshVisionBackend({
    selectedModel: (sessionId, signal) => resolveSessionVisionModel(ctx, sessionId, signal),
    getLlm: () => ctx.get('llm') as SessionOcrLlm | undefined,
    getAttachments: () => ctx.get('attachments') as SessionOcrAttachmentStore | undefined,
  })), 'image-understanding: DSH visual-model backend')
  ctx.effect(() => {
    const fiber = ctx.inject(['pdfCapabilities'], scope => {
      scope.effect(() => scope.pdfCapabilities.register({ id: 'image.selected',
        capabilities: [pdfCapabilities.understandImage], implementation: service,
        async supports({ sessionId, signal }) {
          if (!sessionId) return { available: false, reason: 'Image understanding requires a session' }
          const result = await service.availability(sessionId, signal ?? new AbortController().signal)
          return result.status === 'available' ? { available: true } : { available: false, reason: result.reason }
        },
      }), 'image-understanding: capability catalog')
    })
    return () => fiber.dispose()
  }, 'image-understanding: optional capability catalog')
  ctx.effect(() => registerPdfTransport(ctx as unknown as Parameters<typeof registerPdfTransport>[0],
    createImageUnderstandingDispatch(service, references, {
      binding: () => routing.bindings()?.binding,
      canDeliverImage: (sessionId, signal) => supportsSessionImages(ctx, sessionId, signal),
    }),
    { endpoint: 'pdf.image', maxRequestBytes: MAX_IMAGE_REQUEST_BYTES }),
  'image-understanding: authenticated PDF image route')
}
