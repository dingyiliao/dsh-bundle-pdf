import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { OcrError } from '../ocr/types.js'
import { createSessionLlmOcrBackend, registerOcrAgentTool, resolveSessionModel, SessionModelRouteError,
  type SessionModelRouteContext, type SessionOcrAttachmentStore, type SessionOcrLlm } from '../adapters/host/dsh/index.js'
import { HostOcrService } from '../modules/ocr/index.js'
import { createLocalTextRecovery } from '../adapters/host/ocr/local-text-recovery.js'
import { createLocalTesseractOcrBackend } from '../adapters/host/ocr/local-backend.js'
import { pdfCapabilities } from '../modules/capabilities/index.js'
import { defaultSettings } from '../shared/contracts.js'

export type { HostOcrBackend, HostOcrRequest, HostOcrResult, HostOcrService } from '../modules/ocr/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ocr: HostOcrService
  }
}

/** Separate Cordis entry. Other OCR backends can inject `ocr` and register themselves. */
export const name = 'image-ocr'
export const provide = 'ocr'
export const inject = ['tools']
export const Config = z.object({ backend: z.string().min(1).default(defaultSettings.ocrEngine!) })
  .default({ backend: defaultSettings.ocrEngine! })
export type Config = z.infer<typeof Config>

export function apply(ctx: Context, config: Config): void {
  const service = new HostOcrService(() => config.backend)
  ctx.reflect.provide('ocr', service)
  ctx.effect(() => () => service.dispose(), 'ocr: dispose in-flight recognition')
  const unregister = service.register(createSessionLlmOcrBackend({
    getLlm: () => ctx.get('llm') as SessionOcrLlm | undefined,
    getAttachments: () => ctx.get('attachments') as SessionOcrAttachmentStore | undefined,
    async resolveModel(sessionId, signal) {
      const sessionController = ctx.get('sessionController') as SessionModelRouteContext['sessionController'] | undefined
      if (!sessionController) throw new OcrError('engine-unavailable', 'The DSH session controller is unavailable.')
      const routeCtx: SessionModelRouteContext = {
        sessionController,
        get: ctx.get.bind(ctx) as SessionModelRouteContext['get'],
      }
      try { return await resolveSessionModel(routeCtx, sessionId, signal) }
      catch (error) {
        if (!(error instanceof SessionModelRouteError)) throw error
        throw new OcrError('not-configured', error.code === 'session-unavailable'
          ? 'The OCR session is unavailable.' : 'Choose a model for this session before using OCR.', { cause: error.cause })
      }
    },
  }))
  ctx.effect(() => unregister, 'ocr: current-session model backend')
  const local = createLocalTextRecovery()
  const unregisterLocal = service.register(createLocalTesseractOcrBackend(local))
  ctx.effect(() => async () => { unregisterLocal(); await local.dispose() }, 'ocr: bundled local Tesseract backend')
  ctx.effect(() => {
    const fiber = ctx.inject(['pdfCapabilities'], scope => {
      scope.effect(() => scope.pdfCapabilities.register({ id: 'ocr.selected',
        capabilities: [pdfCapabilities.recognizeImage], implementation: service,
        async supports({ sessionId, signal }) {
          if (!sessionId) return { available: false, reason: 'OCR requires a session' }
          const result = await service.availability(sessionId, signal)
          return result.status === 'available' ? { available: true } : {
            available: false, reason: result.reason ?? `OCR is ${result.status}`,
          }
        },
      }), 'ocr: capability catalog')
    })
    return () => fiber.dispose()
  }, 'ocr: optional capability catalog')
  ctx.effect(() => registerOcrAgentTool(ctx, service), 'ocr: atomic image-consumer tools')
}
