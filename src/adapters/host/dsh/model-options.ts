import { z } from 'zod'
import { engineProbe } from '../../../modules/engines/index.js'
import { modelOptionsRequestSchema, visionModelCatalogSchema,
  type VisionModelCatalog, type VisionModelOption } from '../../../contracts/model-options.js'

const identifier = z.string().min(1).max(512)
const name = z.string().min(1).max(512)
const reasoningSchema = z.object({
  efforts: z.array(z.object({ id: identifier, name })).max(32),
  defaultEffort: identifier.optional(),
})
// DSH's public catalog contains additional display/default fields. Read only
// the documented provider/model/effort projection; never return connection data.
const catalogSchema = z.object({
  groups: z.array(z.object({ id: identifier, name,
    models: z.array(z.object({ id: identifier, name,
      reasoning: reasoningSchema.optional(),
    })).max(1024).refine(models => new Set(models.map(model => model.id)).size === models.length),
  })).max(64).refine(groups => new Set(groups.map(group => group.id)).size === groups.length),
  failures: z.array(z.object({ id: identifier, name, message: z.string().min(1).max(2048) })).max(64),
}).refine(value => value.groups.reduce((total, group) => total + group.models.length, 0) <= 1024)
const modalitiesSchema = z.object({ inputModalities: z.array(z.string().min(1).max(64)).min(1).max(16) })
const failure = (code: string, message: string) => Object.assign(new Error(message), { code })

export interface PdfModelOptionsController { modelCatalog?(): Promise<unknown> }
export interface PdfModelOptionsLlm {
  resolveModelInfo(provider: string, model: string, signal: AbortSignal): Promise<unknown>
}

/** Read the official DSH catalog without selecting a conversation model or running inference. */
export function createPdfModelOptions(controller: PdfModelOptionsController,
  llm: () => PdfModelOptionsLlm | undefined, lifetime: AbortSignal) {
  const tasks = new Map<AbortController, PdfModelOptionsController>()
  return async (payload: unknown, signal: AbortSignal): Promise<VisionModelCatalog> => {
    modelOptionsRequestSchema.parse(payload)
    const active = AbortSignal.any([signal, lifetime])
    active.throwIfAborted()
    const runtime = llm()
    if (!controller.modelCatalog || !runtime) {
      throw failure('pdf/model-catalog-unavailable', 'This Host cannot list configured visual models.')
    }
    return engineProbe(tasks, controller, active, {
      cancelled: () => failure('pdf/model-catalog-cancelled', 'Model loading was cancelled.'),
      timeout: () => failure('pdf/model-catalog-timeout', 'Model loading timed out.'),
    }, async probe => {
      let catalog: z.infer<typeof catalogSchema>
      try { catalog = catalogSchema.parse(await controller.modelCatalog!()) }
      catch {
        probe.throwIfAborted()
        throw failure('pdf/model-catalog-unavailable', 'The configured model catalog is unavailable.')
      }
      probe.throwIfAborted()
      const errors = new Map(catalog.failures.map(item => [item.id, { id: item.id, name: item.name,
        message: 'This model provider is currently unavailable.' }]))
      const accepted = new Map<string, VisionModelOption[]>()
      const entries = catalog.groups.flatMap(group => group.models.map(model => ({ group, model })))
      // Bound metadata fan-out even when a provider advertises a large catalog.
      for (let offset = 0; offset < entries.length; offset += 4) {
        probe.throwIfAborted()
        await Promise.all(entries.slice(offset, offset + 4).map(async ({ group, model }) => {
          try {
            const info = modalitiesSchema.parse(await runtime.resolveModelInfo(group.id, model.id, probe))
            probe.throwIfAborted()
            if (!info.inputModalities.includes('image')) return
            const models = accepted.get(group.id) ?? []
            models.push(model)
            accepted.set(group.id, models)
          } catch {
            probe.throwIfAborted()
            // Provider errors can contain connection details. Report a bounded
            // generic failure while keeping independently verified models.
            if (!errors.has(group.id)) errors.set(group.id, { id: group.id, name: group.name,
              message: 'Some models could not be verified for image input.' })
          }
        }))
      }
      probe.throwIfAborted()
      return visionModelCatalogSchema.parse({
        groups: catalog.groups.flatMap(group => {
          const models = accepted.get(group.id)
          if (!models?.length) return []
          // Promise completion order must not reshuffle the official catalog.
          const ids = new Set(models.map(model => model.id))
          return [{ id: group.id, name: group.name, models: group.models.filter(model => ids.has(model.id)) }]
        }), failures: [...errors.values()],
      })
    })
  }
}
