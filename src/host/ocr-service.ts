import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { validateOcrOutput, validateOcrRequest } from '../ocr/validation.js'
import {
  OcrError, type OcrAvailability, type OcrEngineDescriptor, type OcrOutput, type OcrRequest,
} from '../ocr/types.js'

/** A Host image request, deliberately independent of PDF documents or page rendering. */
export interface HostOcrRequest extends OcrRequest {
  sessionId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

/** Backends may be contributed by separate plugins and removed with their Fiber. */
export interface HostOcrBackend {
  readonly descriptor: OcrEngineDescriptor
  availability(sessionId: string, signal: AbortSignal): Promise<OcrAvailability>
  recognize(request: HostOcrRequest): Promise<OcrOutput>
}

export interface HostOcrResult extends OcrOutput {
  source: { backendId: string; backendVersion: string }
}

function checkImageLimits(request: HostOcrRequest): void {
  const bytes = request.image instanceof Uint8Array ? request.image.byteLength : request.image.size
  if (bytes > 16 * 1024 * 1024 || request.width * request.height > 24_000_000) {
    throw new OcrError('limit-exceeded', 'The OCR image exceeds its size limit.')
  }
}

function checkOutputLimits(output: OcrOutput): void {
  const parts = [output.blocks, output.lines, output.words]
  if (typeof output.text === 'string' && output.text.length > 32_768
    || parts.some(items => Array.isArray(items) && items.length > 4_096)
    || Array.isArray(output.coverage) && output.coverage.length > 4_096
    || Array.isArray(output.warnings) && output.warnings.length > 64) {
    throw new OcrError('limit-exceeded', 'The OCR result exceeds its output limit.')
  }
  const details = [...parts.flatMap(items => Array.isArray(items) ? items : []),
    ...Array.isArray(output.warnings) ? output.warnings : []]
  if (details.reduce((length, item) => length + (typeof item === 'string' ? item.length : item?.text?.length ?? 0), 0) > 65_536) {
    throw new OcrError('limit-exceeded', 'The OCR result exceeds its output limit.')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ocr: HostOcrService
  }
}

/** The selected backend is application configuration; session identity stays per call. */
export class HostOcrService extends Service {
  static provide = 'ocr'
  private readonly backends = new Map<string, HostOcrBackend>()
  private readonly tasks = new Map<AbortController, HostOcrBackend>()
  private readonly staged = new Map<string, { request: HostOcrRequest; expiresAt: number }>()
  private readonly expiryTimer: NodeJS.Timeout
  private disposed = false

  constructor(ctx: Context, private readonly selectedBackend: () => string) {
    super(ctx, 'ocr')
    this.expiryTimer = setInterval(() => this.pruneStaged(), 60_000)
    this.expiryTimer.unref()
  }

  register(backend: HostOcrBackend): () => void {
    if (this.disposed) throw new OcrError('engine-unavailable', 'The OCR service is disposed.')
    const id = backend.descriptor.id
    if (!id || this.backends.has(id)) throw new Error(`OCR backend is missing or duplicated: ${id}`)
    this.backends.set(id, backend)
    return () => {
      if (this.backends.get(id) !== backend) return
      this.backends.delete(id)
      for (const [controller, active] of this.tasks) {
        if (active === backend) controller.abort(new OcrError('engine-unavailable', 'The OCR backend was removed.'))
      }
    }
  }

  list(): OcrEngineDescriptor[] {
    return [...this.backends.values()].map(backend => structuredClone(backend.descriptor))
  }

  selectedDescriptor(): OcrEngineDescriptor | undefined {
    const descriptor = this.backends.get(this.selectedBackend())?.descriptor
    return descriptor ? structuredClone(descriptor) : undefined
  }

  /** Stage bounded image bytes for an agent tool, without exposing a filesystem path or base64 to the model. */
  async stageImage(request: Omit<HostOcrRequest, 'signal' | 'timeoutMs'>): Promise<string> {
    validateOcrRequest(request)
    if (this.disposed) throw new OcrError('engine-unavailable', 'The OCR service is disposed.')
    if (!request.sessionId?.trim() || request.sessionId.length > 512) {
      throw new OcrError('invalid-request', 'OCR requires a valid session identity.')
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(request.mediaType)) {
      throw new OcrError('invalid-request', 'OCR requires a supported encoded image type.')
    }
    checkImageLimits(request)
    const bytes = request.image instanceof Uint8Array
      ? request.image.slice() : new Uint8Array(await request.image.arrayBuffer())
    if (this.disposed) throw new OcrError('engine-unavailable', 'The OCR service is disposed.')
    this.pruneStaged()
    const retainedBytes = () => [...this.staged.values()].reduce((sum, entry) =>
      sum + (entry.request.image as Uint8Array).byteLength, 0)
    while (this.staged.size >= 24 || retainedBytes() + bytes.byteLength > 64 * 1024 * 1024) {
      this.staged.delete(this.staged.keys().next().value!)
    }
    const handle = `ocrimg_${randomUUID()}`
    this.staged.set(handle, { request: { ...request, image: bytes, languages: [...request.languages],
      options: request.options ? structuredClone(request.options) : undefined },
      expiresAt: Date.now() + 5 * 60_000 })
    return handle
  }

  /** A model may use only an unexpired handle staged for its own Session. */
  async recognizeStaged(handle: string, sessionId: string, signal: AbortSignal): Promise<HostOcrResult> {
    this.pruneStaged()
    const staged = this.staged.get(handle)
    if (!staged || staged.request.sessionId !== sessionId) {
      throw new OcrError('invalid-request', 'The OCR image handle is missing, expired, or belongs to another session.')
    }
    return this.recognize({ ...staged.request, signal })
  }

  private pruneStaged(): void {
    const now = Date.now()
    for (const [handle, item] of this.staged) if (item.expiresAt <= now) this.staged.delete(handle)
  }

  async availability(sessionId: string, signal: AbortSignal = new AbortController().signal): Promise<OcrAvailability> {
    const backend = this.backends.get(this.selectedBackend())
    if (!backend || this.disposed) return { status: 'unavailable', reason: 'The selected OCR backend is not installed.' }
    if (!sessionId?.trim()) return { status: 'not-configured', reason: 'OCR requires a session.' }
    return backend.availability(sessionId, signal)
  }

  async recognize(request: HostOcrRequest): Promise<HostOcrResult> {
    validateOcrRequest(request)
    if (!request.sessionId?.trim() || request.sessionId.length > 512) {
      throw new OcrError('invalid-request', 'OCR requires a valid session identity.')
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(request.mediaType)) {
      throw new OcrError('invalid-request', 'OCR requires a supported encoded image type.')
    }
    checkImageLimits(request)
    const backend = this.backends.get(this.selectedBackend())
    if (!backend || this.disposed) throw new OcrError('engine-unavailable', 'The selected OCR backend is not installed.')
    const maxPixels = backend.descriptor.maxPixels
    if (maxPixels && request.width * request.height > maxPixels) {
      throw new OcrError('limit-exceeded', 'The image exceeds the selected OCR backend’s pixel limit.')
    }
    const controller = new AbortController()
    this.tasks.set(controller, backend)
    const cancel = () => controller.abort(new OcrError('cancelled', 'OCR was cancelled.'))
    request.signal?.addEventListener('abort', cancel, { once: true })
    if (request.signal?.aborted) cancel()
    const timer = setTimeout(() => controller.abort(new OcrError('timeout', 'OCR exceeded its time limit.')),
      request.timeoutMs ?? 120_000)
    let abortListener: (() => void) | undefined
    const cancellation = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abortListener, { once: true })
      if (controller.signal.aborted) abortListener()
    })
    try {
      controller.signal.throwIfAborted()
      const snapshot: HostOcrRequest = {
        ...request, image: request.image instanceof Uint8Array ? request.image.slice() : request.image,
        languages: [...request.languages], signal: controller.signal,
      }
      const result = await Promise.race([backend.recognize(snapshot), cancellation])
      controller.signal.throwIfAborted()
      checkOutputLimits(result)
      return { ...validateOcrOutput(result, snapshot),
        source: { backendId: backend.descriptor.id, backendVersion: backend.descriptor.version } }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      if (error instanceof OcrError) throw error
      throw new OcrError('recognition-failed', 'OCR could not recognize the image.', { cause: error })
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
    clearInterval(this.expiryTimer)
    for (const controller of this.tasks.keys()) controller.abort(new OcrError('cancelled', 'The OCR service was disposed.'))
    this.backends.clear()
    this.staged.clear()
  }
}
