import { createHash } from 'node:crypto'
import { EngineDirectory, engineProbe, engineCacheIdentity, validateEngineConfiguration,
  type BackendCacheIdentity, type EngineCacheIdentity, type EngineBinding, type EngineConfiguration,
  type EngineDescriptor } from '../engines/index.js'

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 24_000_000
export const MAX_IMAGE_PROMPT_CHARACTERS = 4_096
export const MAX_DERIVED_TEXT_CHARACTERS = 32_768

export class ImageUnderstandingError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImageUnderstandingError'
  }
}

export interface ImageUnderstandingImage {
  mediaType: 'image/png'
  data: Uint8Array
  width: number
  height: number
}

export interface ImageUnderstandingRequest {
  sessionId: string
  image: ImageUnderstandingImage
  prompt: string
  signal: AbortSignal
  binding?: EngineBinding
}

export type ImageUnderstandingAvailability =
  | { status: 'available'; backendId: string }
  | { status: 'unavailable'; reason: string }

export interface ImageUnderstandingOutput {
  text: string
  model?: string
  limitations?: string
}

export interface ImageUnderstandingResult {
  text: string
  source: { backendId: string; backendVersion: string; model?: string }
  limitations?: string
}

/** One execution contract: an image and prompt produce a textual interpretation. */
export interface ImageUnderstandingBackend {
  readonly descriptor: EngineDescriptor
  availability(sessionId: string, signal: AbortSignal, config?: EngineConfiguration): Promise<
    { available: true } | { available: false; reason: string }
  >
  cacheIdentity?(sessionId: string, signal: AbortSignal, config?: EngineConfiguration): Promise<BackendCacheIdentity>
  understand(request: ImageUnderstandingRequest, config?: EngineConfiguration): Promise<ImageUnderstandingOutput>
}

/** Selected backend is profile configuration; the caller supplies only Session identity. */
export class HostImageUnderstandingService {
  private readonly backends = new EngineDirectory<ImageUnderstandingBackend>(backend => ({
    ...backend.descriptor, capabilities: ['image-description'],
  }))
  private readonly tasks = new Map<AbortController, ImageUnderstandingBackend>()
  private disposed = false

  constructor(private readonly selectedBackend: () => string | EngineBinding) {}

  /** Contributors own the returned disposer through their own Fiber's ctx.effect(). */
  register(backend: ImageUnderstandingBackend): () => void {
    if (this.disposed) throw new ImageUnderstandingError('pdf/image-unavailable', 'Image understanding is disposed.')
    const id = backend.descriptor?.id
    if (!id || this.backends.has(id)) {
      throw new ImageUnderstandingError('pdf/image-invalid-backend', 'Image backend ID is invalid or already registered.')
    }
    return this.backends.register(backend, () => {
      for (const [controller, active] of this.tasks) {
        if (active === backend) controller.abort(new ImageUnderstandingError('pdf/image-unavailable', 'Image backend was removed.'))
      }
    })
  }

  list(): EngineDescriptor[] { return this.backends.list() }

  subscribe(listener: () => void): () => void { return this.backends.subscribe(listener) }

  private selection(binding?: EngineBinding): EngineBinding {
    const selected = binding ?? this.selectedBackend()
    return structuredClone(typeof selected === 'string' ? { engineId: selected, config: {} } : selected)
  }

  selectedDescriptor(binding?: EngineBinding): EngineDescriptor | undefined {
    return this.disposed ? undefined : this.backends.descriptor(this.selection(binding).engineId)
  }

  async availability(sessionId: string, signal: AbortSignal, binding?: EngineBinding): Promise<ImageUnderstandingAvailability> {
    const selected = this.selection(binding)
    const backend = this.backends.get(selected.engineId)
    if (this.disposed || !backend) return { status: 'unavailable', reason: 'The selected image backend is not installed.' }
    if (!sessionId.trim() || sessionId.length > 512) return { status: 'unavailable', reason: 'A valid session is required.' }
    signal.throwIfAborted()
    try {
      const config = validateEngineConfiguration(this.backends.descriptor(backend.descriptor.id)!, selected.config)
      const result = await engineProbe(this.tasks, backend, signal, {
        cancelled: () => new ImageUnderstandingError('pdf/image-cancelled', 'Image availability was cancelled.'),
        timeout: () => new ImageUnderstandingError('pdf/image-timeout', 'Image availability timed out.'),
      }, probe => backend.availability(sessionId, probe, config))
      signal.throwIfAborted()
      if (this.disposed || this.backends.get(backend.descriptor.id) !== backend) {
        return { status: 'unavailable', reason: 'The selected image backend was removed.' }
      }
      return result.available
        ? { status: 'available', backendId: backend.descriptor.id }
        : { status: 'unavailable', reason: result.reason }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (this.disposed || this.backends.get(backend.descriptor.id) !== backend) {
        return { status: 'unavailable', reason: 'The selected image backend was removed.' }
      }
      return { status: 'unavailable', reason: error instanceof ImageUnderstandingError
        ? error.message : 'The image backend is unavailable.' }
    }
  }

  /** Synchronous fence for consumers retaining an asynchronous identity snapshot. */
  generation(binding?: EngineBinding): string | undefined {
    return this.disposed ? undefined : this.backends.generation(this.selection(binding).engineId)
  }

  async cacheIdentity(sessionId: string, signal: AbortSignal, binding?: EngineBinding): Promise<EngineCacheIdentity> {
    signal.throwIfAborted()
    const selected = this.selection(binding)
    const backend = this.backends.get(selected.engineId)
    const generation = this.backends.generation(selected.engineId)
    if (this.disposed || !backend || !generation) throw new ImageUnderstandingError('pdf/image-unavailable', 'The selected image backend is not installed.')
    if (!sessionId?.trim() || sessionId.length > 512) throw new ImageUnderstandingError('pdf/image-invalid-request', 'A valid session is required.')
    let config: EngineConfiguration
    try { config = validateEngineConfiguration(this.backends.descriptor(backend.descriptor.id)!, selected.config) }
    catch (cause) { throw new ImageUnderstandingError('pdf/image-not-configured', 'The selected image configuration is invalid.', { cause }) }
    const identity = await engineProbe(this.tasks, backend, signal, {
      cancelled: () => new ImageUnderstandingError('pdf/image-cancelled', 'Image identity resolution was cancelled.'),
      timeout: () => new ImageUnderstandingError('pdf/image-timeout', 'Image identity resolution timed out.'),
    }, probe => backend.cacheIdentity?.(sessionId, probe, config) ?? Promise.resolve(undefined))
    signal.throwIfAborted()
    if (this.disposed || this.backends.generation(selected.engineId) !== generation) {
      throw new ImageUnderstandingError('pdf/image-unavailable', 'The selected image backend was removed.')
    }
    return engineCacheIdentity(this.backends.descriptor(selected.engineId)!, config, generation, sessionId, identity,
      canonical => createHash('sha256').update(canonical).digest('hex'))
  }

  async understand(request: ImageUnderstandingRequest): Promise<ImageUnderstandingResult> {
    validateImageRequest(request)
    const selected = this.selection(request.binding)
    const backend = this.backends.get(selected.engineId)
    if (this.disposed || !backend) throw new ImageUnderstandingError('pdf/image-unavailable', 'The selected image backend is not installed.')
    let config: EngineConfiguration
    try { config = validateEngineConfiguration(this.backends.descriptor(backend.descriptor.id)!, selected.config) }
    catch (cause) { throw new ImageUnderstandingError('pdf/image-not-configured', 'The selected image configuration is invalid.', { cause }) }
    const controller = new AbortController()
    this.tasks.set(controller, backend)
    const cancel = () => controller.abort(request.signal.reason)
    request.signal.addEventListener('abort', cancel, { once: true })
    if (request.signal.aborted) cancel()
    const timer = setTimeout(() => controller.abort(new ImageUnderstandingError('pdf/image-timeout',
      'Image understanding exceeded its time limit.')), 120_000)
    let onAbort: (() => void) | undefined
    const cancellation = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
    })
    try {
      controller.signal.throwIfAborted()
      const available = await Promise.race([backend.availability(request.sessionId, controller.signal, config), cancellation])
      controller.signal.throwIfAborted()
      if (!available.available) throw new ImageUnderstandingError('pdf/image-unavailable', available.reason)
      // A contributor sees immutable request metadata and a private copy of the image bytes.
      const result = await Promise.race([backend.understand({ ...request, image: {
        ...request.image, data: request.image.data.slice(),
      }, signal: controller.signal }, config), cancellation])
      controller.signal.throwIfAborted()
      if (this.disposed || this.backends.get(backend.descriptor.id) !== backend) {
        throw new ImageUnderstandingError('pdf/image-unavailable', 'The selected image backend was removed.')
      }
      if (!result || typeof result !== 'object') throw new ImageUnderstandingError('pdf/image-invalid-result', 'The image backend returned no result.')
      if (typeof result.text !== 'string' || !result.text.trim()
        || result.text.length > MAX_DERIVED_TEXT_CHARACTERS
        || result.model !== undefined && (typeof result.model !== 'string' || result.model.length > 256)
        || result.limitations !== undefined && (typeof result.limitations !== 'string' || result.limitations.length > 1024)) {
        throw new ImageUnderstandingError('pdf/image-invalid-result', 'The image backend returned invalid or empty text.')
      }
      return { text: result.text,
        source: { backendId: backend.descriptor.id, backendVersion: this.backends.descriptor(backend.descriptor.id)!.version,
          ...(result.model ? { model: result.model } : {}) },
        ...(result.limitations ? { limitations: result.limitations } : {}),
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      if (error instanceof ImageUnderstandingError) throw error
      throw new ImageUnderstandingError('pdf/image-failed', 'The selected image backend could not understand this image.', { cause: error })
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', cancel)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      this.tasks.delete(controller)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.tasks.keys()) controller.abort(new ImageUnderstandingError('pdf/image-unavailable',
      'Image understanding was disposed.'))
    this.backends.dispose()
  }
}

function validateImageRequest(request: ImageUnderstandingRequest): void {
  if (!request.sessionId.trim() || request.sessionId.length > 512
    || !request.prompt.trim() || request.prompt.length > MAX_IMAGE_PROMPT_CHARACTERS
    || request.image.mediaType !== 'image/png'
    || !Number.isSafeInteger(request.image.width) || !Number.isSafeInteger(request.image.height)
    || request.image.width < 1 || request.image.height < 1
    || request.image.width > 8192 || request.image.height > 8192
    || request.image.width * request.image.height > MAX_IMAGE_PIXELS
    || request.image.data.byteLength < 24 || request.image.data.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageUnderstandingError('pdf/image-invalid-request', 'Image request exceeds its format or size limits.')
  }
  const bytes = request.image.data
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (signature.some((value, index) => bytes[index] !== value)
    || Buffer.from(bytes.subarray(12, 16)).toString('ascii') !== 'IHDR'
    || Buffer.from(bytes.subarray(16, 20)).readUInt32BE(0) !== request.image.width
    || Buffer.from(bytes.subarray(20, 24)).readUInt32BE(0) !== request.image.height) {
    throw new ImageUnderstandingError('pdf/image-invalid-request', 'Image bytes do not match the declared PNG dimensions.')
  }
  request.signal.throwIfAborted()
}
