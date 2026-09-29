import {
  TranslationError, type TranslationAvailability, type TranslationEngine,
  type TranslationEngineDescriptor, type TranslationInstance, type TranslationLimits,
  type TranslationRequest, type TranslationResult,
} from './types.js'

/** A shared engine directory. Requests capture their engine/configuration before starting. */
export class TranslationRegistry {
  private readonly engines = new Map<string, TranslationEngine>()
  private readonly tasks = new Map<AbortController, TranslationEngine>()
  private selected?: TranslationInstance
  private selectionKey?: string
  private disposed = false
  private readonly limits: TranslationLimits

  constructor(limits: TranslationLimits) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Translation limits must be positive integers.')
    }
    if (limits.timeoutMs > 2_147_483_647) throw new RangeError('Translation deadline exceeds the timer limit.')
    this.limits = { ...limits }
  }

  register(engine: TranslationEngine): () => void {
    this.assertLive()
    if (this.engines.has(engine.descriptor.id)) throw new Error(`Translation engine already registered: ${engine.descriptor.id}`)
    this.engines.set(engine.descriptor.id, engine)
    return () => {
      if (this.engines.get(engine.descriptor.id) !== engine) return
      this.engines.delete(engine.descriptor.id)
      for (const [controller, active] of this.tasks) {
        if (active === engine) controller.abort(new TranslationError('engine-unavailable', 'The translation engine was removed.'))
      }
    }
  }

  list(): TranslationEngineDescriptor[] {
    return [...this.engines.values()].map(engine => structuredClone(engine.descriptor))
  }

  select(instance: TranslationInstance): void {
    this.assertLive()
    if (!instance.id || !instance.engineId || !instance.configurationRevision) {
      throw new TranslationError('not-configured', 'Translation instance identity and configuration revision are required.')
    }
    const next = structuredClone(instance)
    const key = JSON.stringify(next)
    if (key === this.selectionKey) return
    this.selected = next
    this.selectionKey = key
    for (const controller of this.tasks.keys()) {
      controller.abort(new TranslationError('cancelled', 'Translation settings changed.'))
    }
  }

  getSelection(): TranslationInstance | undefined {
    return this.selected ? structuredClone(this.selected) : undefined
  }

  async availability(): Promise<TranslationAvailability> {
    if (this.disposed) return { status: 'unavailable', reason: 'Translation registry is disposed.' }
    if (!this.selected) return { status: 'not-configured', reason: 'No translation engine is selected.' }
    const engine = this.engines.get(this.selected.engineId)
    if (!engine) return { status: 'unavailable', reason: 'The selected translation engine is not installed.' }
    return engine.availability?.(structuredClone(this.selected.config)) ?? { status: 'available' }
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    this.assertLive()
    if (!request.text.trim() || !request.targetLanguage.trim() || request.targetLanguage.length > 100
        || (request.sourceLanguage !== undefined && (!request.sourceLanguage.trim() || request.sourceLanguage.length > 100))) {
      throw new TranslationError('invalid-request', 'Translation needs text and a target language.')
    }
    if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
      throw new TranslationError('invalid-request', 'The translation deadline must be a positive integer.')
    }
    const instance = this.selected
    if (!instance) throw new TranslationError('not-configured', 'Select a translation engine in PDF settings.')
    const engine = this.engines.get(instance.engineId)
    if (!engine) throw new TranslationError('engine-unavailable', 'The selected translation engine is not installed.')
    const maximum = Math.min(this.limits.maxInputCharacters, engine.descriptor.maxInputCharacters ?? Infinity)
    if (request.text.length > maximum) throw new TranslationError('limit-exceeded', 'The selected text exceeds the translation input limit.')

    const controller = new AbortController()
    this.tasks.set(controller, engine)
    const cancel = () => controller.abort(request.signal?.reason instanceof TranslationError
      ? request.signal.reason : new TranslationError('cancelled', 'Translation was cancelled.'))
    request.signal?.addEventListener('abort', cancel, { once: true })
    if (request.signal?.aborted) cancel()
    const timeoutMs = Math.min(request.timeoutMs ?? this.limits.timeoutMs, this.limits.timeoutMs)
    const timer = setTimeout(() => controller.abort(new TranslationError('timeout', 'Translation exceeded its time limit.')), timeoutMs)
    let abortListener: (() => void) | undefined
    const cancellation = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abortListener, { once: true })
      if (controller.signal.aborted) abortListener()
    })
    const run = async (): Promise<TranslationResult> => {
      controller.signal.throwIfAborted()
      const output = await engine.translate({
        text: request.text, sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage,
        signal: controller.signal, timeoutMs, maxOutputCharacters: this.limits.maxOutputCharacters,
        ...(request.context ? { context: structuredClone(request.context) } : {}),
      }, structuredClone(instance.config))
      controller.signal.throwIfAborted()
      if (!output || typeof output.text !== 'string' || !output.text.trim()
          || (output.status !== 'complete' && output.status !== 'partial')
          || !Array.isArray(output.warnings) || output.warnings.length > 20
          || output.warnings.some(warning => typeof warning !== 'string' || warning.length > 200)
          || (output.detectedSourceLanguage !== undefined && (typeof output.detectedSourceLanguage !== 'string' || output.detectedSourceLanguage.length > 100))) {
        throw new TranslationError('translation-failed', 'The translation engine returned an invalid or empty result.')
      }
      if (output.text.length > this.limits.maxOutputCharacters) {
        throw new TranslationError('limit-exceeded', 'The translation exceeds the output limit.')
      }
      return {
        text: output.text,
        status: output.status, warnings: [...output.warnings],
        ...(output.detectedSourceLanguage === undefined ? {} : { detectedSourceLanguage: output.detectedSourceLanguage }),
        source: { engineId: engine.descriptor.id, engineVersion: engine.descriptor.version,
          instanceId: instance.id, configurationRevision: instance.configurationRevision },
      }
    }
    try {
      return await Promise.race([run(), cancellation])
    } catch (error) {
      if (error instanceof TranslationError) throw error
      throw new TranslationError('translation-failed', 'The selected text could not be translated.', { cause: error })
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', cancel)
      if (abortListener) controller.signal.removeEventListener('abort', abortListener)
      this.tasks.delete(controller)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.tasks.keys()) controller.abort(new TranslationError('cancelled', 'Translation was disposed.'))
    this.engines.clear()
    this.selected = undefined
  }

  private assertLive(): void {
    if (this.disposed) throw new TranslationError('engine-unavailable', 'Translation registry is disposed.')
  }
}
