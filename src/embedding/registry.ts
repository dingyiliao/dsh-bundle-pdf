import { EngineDirectory, validateEngineConfiguration, type EngineBinding, type EngineConfiguration } from '../modules/engines/index.js'
import { EmbeddingError, type EmbeddingAvailability, type EmbeddingEngine, type EmbeddingLimits,
  type EmbeddingModel, type EmbeddingRequest, type EmbeddingResult } from './types.js'

const defaults: EmbeddingLimits = { timeoutMs: 120_000, maxBatchSize: 16, maxInputCharacters: 16_000, maxDimensions: 8192 }

/** Typed provider directory; selection is captured per request, never process-global. */
export class EmbeddingRegistry {
  private readonly engines = new EngineDirectory<EmbeddingEngine>(engine => engine.descriptor)
  private readonly tasks = new Map<AbortController, EmbeddingEngine>()
  private readonly registrations = new Map<string, string>()
  private readonly limits: EmbeddingLimits
  private disposed = false

  constructor(limits: Partial<EmbeddingLimits> = {}) {
    this.limits = { ...defaults, ...limits }
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value <= 0)
        || this.limits.timeoutMs > 2_147_483_647) throw new RangeError('Invalid embedding limits.')
  }

  register(engine: EmbeddingEngine): () => void {
    this.assertLive()
    const id = engine.descriptor.id
    if (this.registrations.has(id)) throw new EmbeddingError('invalid-request', 'The embedding engine is already registered.')
    this.registrations.set(id, crypto.randomUUID())
    try {
      return this.engines.register(engine, () => {
        this.registrations.delete(id)
        for (const [controller, current] of this.tasks) {
          if (current === engine) controller.abort(new EmbeddingError('engine-unavailable', 'The embedding engine was removed.'))
        }
      })
    } catch (error) { this.registrations.delete(id); throw error }
  }
  list() { return this.engines.list() }
  subscribe(listener: () => void): () => void { return this.engines.subscribe(listener) }
  /** Ephemeral registration lease; deliberately separate from persistent model identity. */
  generation(binding: EngineBinding): string {
    this.provider(binding)
    return this.registrations.get(binding.engineId)!
  }

  describe(binding: EngineBinding): EmbeddingModel {
    const { engine, config } = this.provider(binding)
    return this.model(engine, config)
  }

  async availability(binding: EngineBinding, signal?: AbortSignal): Promise<EmbeddingAvailability> {
    const { engine, config } = this.provider(binding)
    if (engine.descriptor.execution === 'disabled') return { status: 'disabled' }
    this.model(engine, config)
    return this.run(engine, signal, undefined, async active => {
      const result = engine.availability ? await engine.availability(config, active) : { status: 'available' as const }
      if (!['available', 'disabled', 'not-configured', 'unavailable'].includes(result?.status)) {
        throw new EmbeddingError('invalid-result', 'The embedding engine returned invalid availability.')
      }
      // Arbitrary provider errors/reasons can contain request text or credentials.
      return { status: result.status, ...(result.status === 'available' ? {} : { reason: 'The selected embedding engine is unavailable.' }) }
    })
  }

  async embed(request: EmbeddingRequest, binding: EngineBinding): Promise<EmbeddingResult> {
    const { engine, config } = this.provider(binding)
    const model = this.model(engine, config)
    if (!Array.isArray(request.texts) || !request.texts.length || request.texts.length > model.maxBatchSize
        || !['query', 'document'].includes(request.purpose)
        || request.texts.some(text => typeof text !== 'string' || !text.trim() || text.length > model.maxInputCharacters)) {
      throw new EmbeddingError('invalid-request', 'Embedding inputs exceed the configured batch or text limits.')
    }
    // Copy before awaiting: callers cannot mutate inputs/configuration during a request.
    const texts = [...request.texts]
    return this.run(engine, request.signal, request.timeoutMs, async (signal, timeoutMs) => {
      const output = await engine.embed({ texts, purpose: request.purpose, signal, timeoutMs }, config)
      signal.throwIfAborted()
      let resultModel = model
      let returned: unknown = output
      const currentModel = this.model(engine, config)
      if (output && typeof output === 'object' && 'vectors' in output && 'model' in output) {
        const reported = output.model
        const identity = ['engineId', 'engineVersion', 'model', 'modelRevision', 'dimensions', 'encoding', 'fingerprint'] as const
        if (!reported || identity.some(key => reported[key] !== currentModel[key])) {
          throw new EmbeddingError('invalid-result', 'The embedding response has an unverified model identity.')
        }
        returned = output.vectors
        resultModel = currentModel
      } else if (currentModel.fingerprint !== model.fingerprint) {
        throw new EmbeddingError('invalid-result', 'The embedding model changed during the request.')
      }
      if (!Array.isArray(returned) || returned.length !== texts.length
          || texts.length > resultModel.maxBatchSize || texts.some(text => text.length > resultModel.maxInputCharacters)) {
        throw new EmbeddingError('invalid-result', 'The embedding response has an incorrect vector count.')
      }
      const vectors = returned.map(vector => {
        if (!Array.isArray(vector) || vector.length !== resultModel.dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
          throw new EmbeddingError('invalid-result', 'The embedding response has invalid vector dimensions or values.')
        }
        const norm = Math.hypot(...vector)
        if (!Number.isFinite(norm) || norm < 1e-12) throw new EmbeddingError('invalid-result', 'The embedding response contains an empty vector.')
        return vector.map(value => value / norm)
      })
      if (this.model(engine, config).fingerprint !== resultModel.fingerprint) {
        throw new EmbeddingError('invalid-result', 'The embedding model changed during the request.')
      }
      return { vectors, model: resultModel }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.tasks.keys()) controller.abort(new EmbeddingError('cancelled', 'Embedding was disposed.'))
    this.registrations.clear()
    this.engines.dispose()
  }

  private provider(binding: EngineBinding): { engine: EmbeddingEngine; config: EngineConfiguration } {
    this.assertLive()
    if (!binding?.engineId) throw new EmbeddingError('not-configured', 'Select an embedding engine in PDF settings.')
    const engine = this.engines.get(binding.engineId)
    if (!engine) throw new EmbeddingError('engine-unavailable', 'The selected embedding engine is not installed.')
    try {
      return { engine, config: structuredClone(validateEngineConfiguration(engine.descriptor, binding.config)) }
    } catch { throw new EmbeddingError('invalid-request', 'The embedding engine configuration is invalid.') }
  }

  private model(engine: EmbeddingEngine, config: EngineConfiguration): EmbeddingModel {
    let model: EmbeddingModel
    try { model = engine.describe(config) } catch (error) {
      if (error instanceof EmbeddingError) throw error
      throw new EmbeddingError('invalid-request', 'The embedding engine configuration is invalid.')
    }
    if (!model || model.engineId !== engine.descriptor.id || model.engineVersion !== engine.descriptor.version
        || [model.model, model.modelRevision, model.encoding, model.fingerprint].some(value => typeof value !== 'string' || !value || value.length > 512)
        || !Number.isSafeInteger(model.dimensions) || model.dimensions < 1 || model.dimensions > this.limits.maxDimensions
        || !Number.isSafeInteger(model.maxBatchSize) || model.maxBatchSize < 1
        || !Number.isSafeInteger(model.maxInputCharacters) || model.maxInputCharacters < 1) {
      throw new EmbeddingError('invalid-result', 'The embedding engine returned an invalid model description.')
    }
    return { ...model, maxBatchSize: Math.min(model.maxBatchSize, this.limits.maxBatchSize),
      maxInputCharacters: Math.min(model.maxInputCharacters, this.limits.maxInputCharacters) }
  }

  private async run<T>(engine: EmbeddingEngine, signal: AbortSignal | undefined, requestedTimeout: number | undefined,
    operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>): Promise<T> {
    if (requestedTimeout !== undefined && (!Number.isSafeInteger(requestedTimeout) || requestedTimeout <= 0)) {
      throw new EmbeddingError('invalid-request', 'The embedding deadline is invalid.')
    }
    const timeoutMs = Math.min(requestedTimeout ?? this.limits.timeoutMs, this.limits.timeoutMs)
    const controller = new AbortController()
    this.tasks.set(controller, engine)
    const cancel = () => controller.abort(new EmbeddingError('cancelled', 'Embedding was cancelled.'))
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const timer = setTimeout(() => controller.abort(new EmbeddingError('timeout', 'Embedding exceeded its time limit.')), timeoutMs)
    let onAbort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
    })
    try {
      controller.signal.throwIfAborted()
      const result = await Promise.race([operation(controller.signal, timeoutMs), cancelled])
      controller.signal.throwIfAborted()
      return result
    } catch (error) {
      if (error instanceof EmbeddingError) throw error
      throw new EmbeddingError('engine-unavailable', 'The embedding engine request failed.')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      controller.signal.removeEventListener('abort', onAbort)
      this.tasks.delete(controller)
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new EmbeddingError('engine-unavailable', 'The embedding registry is disposed.')
  }
}
