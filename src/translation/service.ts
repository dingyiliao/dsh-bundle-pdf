import { TranslationRegistry } from './registry.js'
import { TranslationError, type DocumentTranslationResult, type TranslationDocumentIdentity, type TranslationRequest } from './types.js'

/** One reader owns one service; newer requests and changed documents supersede older work. */
export class TranslationService {
  private document?: TranslationDocumentIdentity
  private active?: AbortController
  private generation = 0
  private disposed = false

  constructor(private readonly registry: TranslationRegistry) {}

  setSource(document: TranslationDocumentIdentity | undefined): void {
    this.assertLive()
    if (document && (!document.documentId || !document.contentVersion)) {
      throw new TranslationError('invalid-request', 'Translation requires a document identity and content version.')
    }
    if (this.document?.documentId === document?.documentId && this.document?.contentVersion === document?.contentVersion) return
    this.cancel(new TranslationError('stale-result', 'The source document changed.'))
    this.document = document ? { ...document } : undefined
  }

  async translate(request: TranslationRequest): Promise<DocumentTranslationResult> {
    this.assertLive()
    if (!this.document) throw new TranslationError('invalid-request', 'Open a PDF before requesting a translation.')
    this.cancel()
    const document = { ...this.document }
    const requestId = ++this.generation
    const controller = new AbortController()
    this.active = controller
    const cancel = () => controller.abort(new TranslationError('cancelled', 'Translation was cancelled.'))
    request.signal?.addEventListener('abort', cancel, { once: true })
    if (request.signal?.aborted) cancel()
    try {
      const result = await this.registry.translate({ ...request, signal: controller.signal })
      controller.signal.throwIfAborted()
      if (this.disposed || this.generation !== requestId || this.document?.documentId !== document.documentId
          || this.document?.contentVersion !== document.contentVersion) {
        throw new TranslationError('stale-result', 'The translation no longer belongs to the active selection.')
      }
      return { ...result, document, requestId }
    } finally {
      request.signal?.removeEventListener('abort', cancel)
      if (this.active === controller) this.active = undefined
    }
  }

  cancel(reason = new TranslationError('cancelled', 'Translation was superseded or cancelled.')): void {
    this.generation++
    this.active?.abort(reason)
    this.active = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    this.document = undefined
  }

  private assertLive(): void {
    if (this.disposed) throw new TranslationError('cancelled', 'Translation service is disposed.')
  }
}
