import type { Context } from '@deepseek-ai/cordis'
import { engineBinding } from '../../../modules/engines/index.js'
import type { AgentImageUnderstandingPort, AgentOcrPort } from '../../../modules/evidence/index.js'

/** PDF UI and tools bind the same Host-owned settings; other consumers keep their own defaults. */
export function createPdfEngineRouting(ctx: Pick<Context, 'get'>) {
  const bindings = () => {
    const settings = ctx.get('pdfAiSettings')?.()
    return settings ? {
      binding: engineBinding('image', settings.imageEngine ?? 'dsh-vision', settings.engineConfigurations),
      ocrBinding: engineBinding('ocr', settings.ocrEngine ?? 'session-llm', settings.engineConfigurations),
    } : undefined
  }
  return {
    bindings,
    ocr(): AgentOcrPort | undefined {
      const service = ctx.get('ocr'), binding = bindings()?.ocrBinding
      if (!service) return undefined
      return {
        selectedDescriptor: () => service.selectedDescriptor(binding),
        availability: (sessionId, signal) => service.availability(sessionId, signal, binding),
        recognize: request => service.recognize({ ...request, binding }),
        stageImage: (request, hooks) => service.stageImage({ ...request, binding }, hooks),
      }
    },
    image(): AgentImageUnderstandingPort | undefined {
      const service = ctx.get('imageUnderstanding'), selected = bindings()
      if (!service) return undefined
      return {
        availability: (sessionId, signal) => service.availability(sessionId, signal, selected?.binding),
      }
    },
  }
}
