export const MAX_IMAGE_BYTES = 6 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 24_000_000
export const MAX_QUESTION_CHARACTERS = 4_096
export const MAX_DERIVED_TEXT_CHARACTERS = 32_768

export type ImageUnderstandingKind = 'direct-image' | 'derived-text'
export type ImageUnderstandingMode = 'session-vision' | 'ocr-text' | 'image-description'

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
  question: string
  signal: AbortSignal
}

export type ImageUnderstandingAvailability =
  | { status: 'available'; kind: ImageUnderstandingKind; backendId: string; limitation?: string }
  | { status: 'unavailable'; reason: string }

export type ImageUnderstandingPreparation =
  | { kind: 'direct-image'; backendId: string;
      provenance: { backendId: string; mode: 'session-vision' } }
  | { kind: 'derived-text'; text: string;
      provenance: { backendId: string; mode: 'ocr-text' | 'image-description'; model?: string };
      limitations?: string }

export interface ImageUnderstandingBackend {
  readonly id: string
  readonly kind: ImageUnderstandingKind
  availability(sessionId: string, signal: AbortSignal): Promise<
    { available: true; limitation?: string } | { available: false; reason: string }
  >
  prepare(request: ImageUnderstandingRequest): Promise<
    | { kind: 'direct-image'; mode: 'session-vision' }
    | { kind: 'derived-text'; text: string; mode: 'ocr-text' | 'image-description';
        model?: string; limitations?: string }
  >
}

/** Selected backend is profile configuration; the caller supplies only Session identity. */
export class HostImageUnderstandingService {
  private readonly backends = new Map<string, ImageUnderstandingBackend>()
  private readonly tasks = new Map<AbortController, ImageUnderstandingBackend>()
  private disposed = false

  constructor(private readonly selectedBackend: () => string) {}

  /** Contributors own the returned disposer through their own Fiber's ctx.effect(). */
  register(backend: ImageUnderstandingBackend): () => void {
    if (this.disposed) throw new ImageUnderstandingError('pdf/image-unavailable', 'Image understanding is disposed.')
    if (!backend.id || backend.id.length > 128 || !/^[a-z0-9][a-z0-9.-]*$/.test(backend.id)
      || this.backends.has(backend.id)) {
      throw new ImageUnderstandingError('pdf/image-invalid-backend', 'Image backend ID is invalid or already registered.')
    }
    this.backends.set(backend.id, backend)
    return () => {
      if (this.backends.get(backend.id) !== backend) return
      this.backends.delete(backend.id)
      for (const [controller, active] of this.tasks) {
        if (active === backend) controller.abort(new ImageUnderstandingError('pdf/image-unavailable', 'Image backend was removed.'))
      }
    }
  }

  list(): { id: string; kind: ImageUnderstandingKind }[] {
    return [...this.backends.values()].map(({ id, kind }) => ({ id, kind }))
  }

  async availability(sessionId: string, signal: AbortSignal): Promise<ImageUnderstandingAvailability> {
    const backend = this.backends.get(this.selectedBackend())
    if (this.disposed || !backend) return { status: 'unavailable', reason: 'The selected image backend is not installed.' }
    if (!sessionId.trim() || sessionId.length > 512) return { status: 'unavailable', reason: 'A valid session is required.' }
    signal.throwIfAborted()
    try {
      const result = await backend.availability(sessionId, signal)
      signal.throwIfAborted()
      if (this.disposed || this.backends.get(backend.id) !== backend) {
        return { status: 'unavailable', reason: 'The selected image backend was removed.' }
      }
      return result.available
        ? { status: 'available', kind: backend.kind, backendId: backend.id,
            ...(result.limitation ? { limitation: result.limitation } : {}) }
        : { status: 'unavailable', reason: result.reason }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      return { status: 'unavailable', reason: error instanceof ImageUnderstandingError
        ? error.message : 'The image backend is unavailable.' }
    }
  }

  async prepare(request: ImageUnderstandingRequest): Promise<ImageUnderstandingPreparation> {
    validateImageRequest(request)
    const backend = this.backends.get(this.selectedBackend())
    if (this.disposed || !backend) throw new ImageUnderstandingError('pdf/image-unavailable', 'The selected image backend is not installed.')
    const controller = new AbortController()
    this.tasks.set(controller, backend)
    const cancel = () => controller.abort(request.signal.reason)
    request.signal.addEventListener('abort', cancel, { once: true })
    if (request.signal.aborted) cancel()
    const timer = setTimeout(() => controller.abort(new ImageUnderstandingError('pdf/image-timeout',
      'Image preparation exceeded its time limit.')), 120_000)
    let onAbort: (() => void) | undefined
    const cancellation = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
    })
    try {
      controller.signal.throwIfAborted()
      const available = await Promise.race([backend.availability(request.sessionId, controller.signal), cancellation])
      controller.signal.throwIfAborted()
      if (!available.available) throw new ImageUnderstandingError('pdf/image-unavailable', available.reason)
      // A contributor sees immutable request metadata and a private copy of the image bytes.
      const result = await Promise.race([backend.prepare({ ...request, image: {
        ...request.image, data: request.image.data.slice(),
      }, signal: controller.signal }), cancellation])
      controller.signal.throwIfAborted()
      if (this.disposed || this.backends.get(backend.id) !== backend) {
        throw new ImageUnderstandingError('pdf/image-unavailable', 'The selected image backend was removed.')
      }
      if (result.kind !== backend.kind) {
        throw new ImageUnderstandingError('pdf/image-invalid-result', 'The image backend returned a different result kind.')
      }
      if (result.kind === 'direct-image') return {
        kind: 'direct-image', backendId: backend.id,
        provenance: { backendId: backend.id, mode: result.mode },
      }
      if (typeof result.text !== 'string' || !result.text.trim()
        || result.text.length > MAX_DERIVED_TEXT_CHARACTERS
        || result.model && result.model.length > 256
        || result.limitations && result.limitations.length > 1024) {
        throw new ImageUnderstandingError('pdf/image-invalid-result', 'The image backend returned invalid or empty text.')
      }
      return { kind: 'derived-text', text: result.text,
        provenance: { backendId: backend.id, mode: result.mode,
          ...(result.model ? { model: result.model } : {}) },
        ...(result.limitations ? { limitations: result.limitations } : {}),
      }
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
    this.backends.clear()
  }
}

function validateImageRequest(request: ImageUnderstandingRequest): void {
  if (!request.sessionId.trim() || request.sessionId.length > 512
    || !request.question.trim() || request.question.length > MAX_QUESTION_CHARACTERS
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
