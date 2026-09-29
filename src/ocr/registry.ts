import { makeOcrCacheKey } from './cache.js'
import { validateOcrOutput, validateOcrRequest } from './validation.js'
import {
  OcrError, type OcrAvailability, type OcrCacheIdentity, type OcrEngine,
  type OcrEngineDescriptor, type OcrInstance, type OcrRequest, type OcrResult, type OcrSource,
} from './types.js'

function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze)
      Object.freeze(item)
    }
  }
  freeze(copy)
  return copy
}

export class OcrRegistry {
  private readonly engines = new Map<string, OcrEngine>()
  private readonly tasks = new Map<AbortController, OcrEngine>()
  private readonly cache = new Map<string, OcrResult>()
  private selected: OcrInstance | undefined
  private disposed = false

  constructor(private readonly cacheCapacity = 24) {
    if (!Number.isInteger(cacheCapacity) || cacheCapacity < 0) throw new RangeError('Invalid OCR cache capacity.')
  }

  register(engine: OcrEngine): () => void {
    if (this.disposed) throw new OcrError('engine-unavailable', 'OCR registry is disposed.')
    if (this.engines.has(engine.descriptor.id)) throw new Error(`OCR engine already registered: ${engine.descriptor.id}`)
    this.engines.set(engine.descriptor.id, engine)
    return () => {
      if (this.engines.get(engine.descriptor.id) !== engine) return
      this.engines.delete(engine.descriptor.id)
      for (const [controller, activeEngine] of this.tasks) {
        if (activeEngine === engine) controller.abort(new OcrError('engine-unavailable', 'The OCR engine was removed.'))
      }
      for (const [key, result] of this.cache) {
        if (result.source.engineId === engine.descriptor.id) this.cache.delete(key)
      }
    }
  }

  list(): OcrEngineDescriptor[] {
    return [...this.engines.values()].map((engine) => structuredClone(engine.descriptor))
  }

  select(instance: OcrInstance): void {
    if (!instance.id || !instance.engineId || !instance.configurationRevision) {
      throw new OcrError('not-configured', 'OCR instance identity and configuration revision are required.')
    }
    // Keep a missing engine selection visible instead of silently falling back.
    this.selected = frozenCopy(instance)
  }

  getSelection(): OcrInstance | undefined {
    return this.selected ? structuredClone(this.selected) : undefined
  }

  async availability(): Promise<OcrAvailability> {
    if (!this.selected) return { status: 'not-configured', reason: 'No OCR engine is selected.' }
    const engine = this.engines.get(this.selected.engineId)
    if (!engine || this.disposed) return { status: 'unavailable', reason: 'The selected OCR engine is not installed.' }
    return engine.availability?.(this.selected.config) ?? { status: 'available' }
  }

  clearCache(): void { this.cache.clear() }

  dispose(): void {
    this.disposed = true
    for (const controller of this.tasks.keys()) controller.abort(new OcrError('cancelled', 'OCR was disposed.'))
    this.engines.clear()
    this.cache.clear()
  }

  async recognize(request: OcrRequest, options: { cacheIdentity?: OcrCacheIdentity; bypassCache?: boolean } = {}): Promise<OcrResult> {
    validateOcrRequest(request)
    if (this.disposed) throw new OcrError('engine-unavailable', 'OCR registry is disposed.')
    const instance = this.selected
    if (!instance) throw new OcrError('not-configured', 'Select an OCR engine in PDF settings.')
    const engine = this.engines.get(instance.engineId)
    if (!engine) throw new OcrError('engine-unavailable', 'The selected OCR engine is not installed.')
    if (engine.descriptor.maxPixels && request.width * request.height > engine.descriptor.maxPixels) {
      throw new OcrError('limit-exceeded', 'The selected image exceeds this OCR engine’s pixel limit.')
    }
    const source: OcrSource = {
      engineId: engine.descriptor.id, engineVersion: engine.descriptor.version,
      instanceId: instance.id, configurationRevision: instance.configurationRevision,
      languages: [...request.languages],
    }
    const controller = new AbortController()
    this.tasks.set(controller, engine)
    const cancel = () => controller.abort(new OcrError('cancelled', 'OCR was cancelled.'))
    request.signal?.addEventListener('abort', cancel, { once: true })
    if (request.signal?.aborted) cancel()
    const timer = setTimeout(() => controller.abort(new OcrError('timeout', 'OCR exceeded its time limit.')), request.timeoutMs ?? 120_000)
    const snapshot: OcrRequest = {
      ...request, image: request.image instanceof Uint8Array ? request.image.slice() : request.image,
      languages: [...request.languages], options: frozenCopy(request.options ?? {}), signal: controller.signal,
      onProgress: (progress) => {
        if (!controller.signal.aborted) {
          try { request.onProgress?.(progress) } catch { /* A UI observer cannot break recognition. */ }
        }
      },
    }
    let abortListener: (() => void) | undefined
    const cancellation = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abortListener, { once: true })
      if (controller.signal.aborted) abortListener()
    })
    const run = async (): Promise<OcrResult> => {
      controller.signal.throwIfAborted()
      const key = options.cacheIdentity ? await makeOcrCacheKey(source, snapshot, options.cacheIdentity) : undefined
      controller.signal.throwIfAborted()
      const cached = key && !options.bypassCache && engine.descriptor.execution !== 'disabled' ? this.cache.get(key) : undefined
      if (cached) {
        this.cache.delete(key!)
        this.cache.set(key!, cached)
        return { ...structuredClone(cached), cached: true }
      }
      const output = validateOcrOutput(await engine.recognize(snapshot, instance.config), snapshot)
      controller.signal.throwIfAborted()
      const result: OcrResult = { ...output, source, image: { width: snapshot.width, height: snapshot.height }, cached: false }
      if (key && this.cacheCapacity && result.status === 'complete') {
        this.cache.set(key, structuredClone(result))
        while (this.cache.size > this.cacheCapacity) this.cache.delete(this.cache.keys().next().value!)
      }
      return result
    }
    try {
      return await Promise.race([run(), cancellation])
    } catch (error) {
      if (error instanceof OcrError) throw error
      throw new OcrError('recognition-failed', 'OCR could not recognize this image.', { cause: error })
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', cancel)
      if (abortListener) controller.signal.removeEventListener('abort', abortListener)
      this.tasks.delete(controller)
    }
  }
}
