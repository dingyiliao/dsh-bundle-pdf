import type { Context } from '@deepseek-ai/cordis'
import { resolveOcrSessionModel, type OcrModelRouteContext } from './ocr-model-route.js'
import type { SessionOcrLlm } from './ocr-session-llm.js'
import type { HostOcrService } from '../../../modules/ocr/index.js'
import { ImageUnderstandingError, type ImageUnderstandingBackend } from '../../../modules/image-understanding/index.js'

export function createSessionVisionBackend(ctx: Pick<Context, 'get'>): ImageUnderstandingBackend {
  const check = async (sessionId: string, signal: AbortSignal) => {
    const llm = ctx.get('llm') as Pick<SessionOcrLlm, 'resolveModelInfo'> | undefined
    const sessionController = ctx.get('sessionController') as OcrModelRouteContext['sessionController'] | undefined
    if (!llm || !sessionController) return { available: false as const, reason: 'The session model is unavailable.' }
    let route
    try {
      route = await resolveOcrSessionModel({ sessionController,
        get: ctx.get.bind(ctx) as OcrModelRouteContext['get'] }, sessionId, signal)
      signal.throwIfAborted()
      const info = await llm.resolveModelInfo(route.provider, route.model, signal)
      signal.throwIfAborted()
      if (!info?.inputModalities?.includes('image')) return {
        available: false as const, reason: 'The current session model does not declare image input.',
      }
      return { available: true as const }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      return { available: false as const, reason: error instanceof Error ? error.message : 'The session model is unavailable.' }
    }
  }
  return {
    id: 'session-vision', kind: 'direct-image', availability: check,
    async prepare({ sessionId, signal }) {
      const result = await check(sessionId, signal)
      if (!result.available) throw new ImageUnderstandingError('pdf/image-unavailable', result.reason)
      return { kind: 'direct-image', mode: 'session-vision' }
    },
  }
}

/** OCR is a lossy text derivation, never a substitute for visual semantics. */
export function createOcrTextBackend(ctx: Pick<Context, 'get'>): ImageUnderstandingBackend {
  const getOcr = () => ctx.get('ocr') as HostOcrService | undefined
  return {
    id: 'ocr-text', kind: 'derived-text',
    async availability(sessionId, signal) {
      const ocr = getOcr()
      if (!ocr) return { available: false, reason: 'The OCR plugin is not installed.' }
      const result = await ocr.availability(sessionId, signal)
      return result.status === 'available'
        ? { available: true, limitation: 'OCR extracts visible text only; diagrams and layout are not understood.' }
        : { available: false, reason: result.reason ?? 'The selected OCR backend is unavailable.' }
    },
    async prepare({ sessionId, image, signal }) {
      const ocr = getOcr()
      if (!ocr) throw new ImageUnderstandingError('pdf/image-unavailable', 'The OCR plugin is not installed.')
      const result = await ocr.recognize({ sessionId, image: image.data, mediaType: image.mediaType,
        width: image.width, height: image.height, languages: ['auto'], signal })
      signal.throwIfAborted()
      return { kind: 'derived-text', mode: 'ocr-text', text: result.text,
        limitations: result.status === 'partial'
          ? 'OCR is partial; visual structure, diagrams, and some text may be missing.'
          : 'OCR extracts visible text only; visual structure and diagrams may be missing.',
      }
    },
  }
}
