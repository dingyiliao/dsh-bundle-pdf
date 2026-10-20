import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { OcrError } from '../ocr/types.js'
import { createSessionLlmOcrBackend, registerOcrAgentTool, resolveOcrSessionModel,
  type OcrModelRouteContext, type SessionOcrAttachmentStore, type SessionOcrLlm } from '../adapters/host/dsh/index.js'
import { HostOcrService } from '../modules/ocr/index.js'

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
export const Config = z.object({ backend: z.string().min(1).default('session-llm') }).default({ backend: 'session-llm' })
export type Config = z.infer<typeof Config>

export function apply(ctx: Context, config: Config): void {
  const service = new HostOcrService(() => config.backend)
  ctx.reflect.provide('ocr', service)
  ctx.effect(() => () => service.dispose(), 'ocr: dispose in-flight recognition')
  const unregister = service.register(createSessionLlmOcrBackend({
    getLlm: () => ctx.get('llm') as SessionOcrLlm | undefined,
    getAttachments: () => ctx.get('attachments') as SessionOcrAttachmentStore | undefined,
    async resolveModel(sessionId, signal) {
      const sessionController = ctx.get('sessionController') as OcrModelRouteContext['sessionController'] | undefined
      if (!sessionController) throw new OcrError('engine-unavailable', 'The DSH session controller is unavailable.')
      const routeCtx: OcrModelRouteContext = {
        sessionController,
        get: ctx.get.bind(ctx) as OcrModelRouteContext['get'],
      }
      return resolveOcrSessionModel(routeCtx, sessionId, signal)
    },
  }))
  ctx.effect(() => unregister, 'ocr: current-session model backend')
  registerOcrAgentTool(ctx, service)
}
