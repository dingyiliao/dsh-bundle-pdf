import { ByteCache } from '../../../shared/cache/index.ts'
import type { NativeReaderApi, NativeTextContent, NativeTileRequest } from '../../../shared/native.ts'
import type { WorkspaceSnapshot } from '../../../shared/contracts.ts'
import type { ReaderAnnotation, ReaderDocument, ReaderOutlineItem, ReaderPage, ReaderRenderOptions } from '../ports/reader-document.ts'
import { NativeViewport } from '../../../shared/geometry/native-viewport.ts'

export interface NativeDocumentEvents {
  onStale?(document: NativeDocument, error: unknown): Promise<void>
  onReady?(document: NativeDocument): void
}

/** Native PDFium document exposed to the reader. */
export class NativeDocument implements ReaderDocument {
  readonly numPages: number
  readonly lifetime = new AbortController()
  private pageCache = new Map<number, NativePage>()
  private textCache = new ByteCache<NativeTextContent>(4 * 1024 * 1024)
  private bitmapCache = new ByteCache<ImageBitmap>(24 * 1024 * 1024, image => image.close())
  private ready = false
  constructor(readonly snapshot: WorkspaceSnapshot, readonly sessionId: string, readonly api: NativeReaderApi,
    private readonly events: NativeDocumentEvents = {}) {
    this.numPages = snapshot.document.pageCount
  }
  /** All reads share one lifetime, including adapters which do not honor AbortSignal. */
  private async read<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    combined.throwIfAborted()
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(combined.reason)
      combined.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const value = await Promise.race([operation(combined), aborted])
      combined.throwIfAborted()
      if (!this.ready) { this.ready = true; this.events.onReady?.(this) }
      return value
    } catch (error) {
      combined.throwIfAborted()
      if (error && typeof error === 'object' && 'code' in error && error.code === 'pdf/stale-reader' && this.events.onStale) {
        await this.events.onStale(this, error)
        throw new DOMException('PDF reader snapshot was replaced', 'AbortError')
      }
      throw error
    } finally {
      combined.removeEventListener('abort', onAbort)
    }
  }
  async getPage(number: number): Promise<NativePage> {
    this.lifetime.signal.throwIfAborted()
    if (!Number.isInteger(number) || number < 1 || number > this.numPages) throw new RangeError('Page is outside the PDF')
    let page = this.pageCache.get(number)
    if (!page) page = new NativePage(this, number)
    this.pageCache.delete(number); this.pageCache.set(number, page)
    while (this.pageCache.size > 32) this.pageCache.delete(this.pageCache.keys().next().value!)
    return page
  }
  getOutline(): Promise<ReaderOutlineItem[] | null> {
    return this.read(signal => this.api.outline(this.sessionId, this.snapshot.id, this.snapshot.reader, signal))
  }
  getDestination(name: string): Promise<unknown> {
    return this.read(signal => this.api.destination(this.sessionId, this.snapshot.id, this.snapshot.reader, name, signal))
  }
  links(number: number, signal?: AbortSignal): Promise<ReaderAnnotation[]> {
    return this.read(async combined => await this.api.links(this.sessionId, this.snapshot.id, this.snapshot.reader, number, combined) as ReaderAnnotation[], signal)
  }
  async getPageIndex(ref: unknown): Promise<number> {
    if (typeof ref === 'number' && ref >= 0 && ref < this.numPages) return ref
    throw new Error('Native destinations must carry a page index')
  }
  async text(number: number, signal?: AbortSignal): Promise<NativeTextContent> {
    return this.read(async combined => {
      const key = String(number), cached = this.textCache.get(key)
      if (cached) return cached
      const value = await this.api.text(this.sessionId, this.snapshot.id, this.snapshot.reader, number, combined)
      combined.throwIfAborted()
      this.textCache.set(key, value, JSON.stringify(value).length * 2)
      return value
    }, signal)
  }
  async bitmap(tile: NativeTileRequest, signal: AbortSignal): Promise<ImageBitmap> {
    return this.read(async combined => {
      const key = JSON.stringify(tile), cached = this.bitmapCache.get(key)
      if (cached) return cached
      const result = await this.api.tile(this.sessionId, this.snapshot.id, this.snapshot.reader, tile, combined)
      combined.throwIfAborted()
      const image = await createImageBitmap(new Blob([new Uint8Array(result.bytes)], { type: result.mime }))
      if (combined.aborted) { image.close(); combined.throwIfAborted() }
      this.bitmapCache.set(key, image, image.width * image.height * 4)
      return image
    }, signal)
  }
  diagnostics() { return { bitmapCacheBytes: this.bitmapCache.bytes, textCacheBytes: this.textCache.bytes, pageProxies: this.pageCache.size } }
  /** Stop obsolete work while retaining the last painted bitmaps during handoff. */
  retire(): void { this.lifetime.abort() }
  async dispose(): Promise<void> { this.retire(); this.bitmapCache.clear(); this.textCache.clear(); this.pageCache.clear() }
}

export class NativePage implements ReaderPage {
  readonly rotate: number
  readonly userUnit: number
  readonly view: number[]
  constructor(readonly owner: NativeDocument, readonly pageNumber: number) {
    const geometry = owner.snapshot.document.pages[pageNumber - 1]
    this.rotate = geometry.rotation; this.userUnit = geometry.userUnit; this.view = [...geometry.cropBox]
  }
  getViewport(options: { scale: number; rotation?: number; offsetX?: number; offsetY?: number; dontFlip?: boolean }): NativeViewport {
    return new NativeViewport(this.owner.snapshot.document.pages[this.pageNumber - 1], options.scale, options.rotation ?? this.rotate,
      options.offsetX, options.offsetY, options.dontFlip)
  }
  getTextContent(): Promise<NativeTextContent> { return this.owner.text(this.pageNumber) }
  async getAnnotations(): Promise<ReaderAnnotation[]> {
    const links = await this.owner.links(this.pageNumber)
    return [...links, ...this.owner.snapshot.document.annotations.filter(a => a.page === this.pageNumber && a.linkAction && a.rect)
      .map(a => ({ id: a.id, subtype: 'Link', rect: a.rect!, quadPoints: a.quadPoints, action: a.linkAction }))]
  }
  tile(tile: Omit<NativeTileRequest, 'page'>, signal: AbortSignal): Promise<ImageBitmap> {
    return this.owner.bitmap({ ...tile, page: this.pageNumber }, signal)
  }
  /** Shared screenshot/OCR adapter: compose only the requested region, tile by tile. */
  render(options: ReaderRenderOptions) {
    const controller = new AbortController()
    const promise = (async () => {
      const { canvas, viewport } = options, t = options.transform ?? [1, 0, 0, 1, 0, 0]
      if (t[1] !== 0 || t[2] !== 0 || t[0] <= 0 || t[3] !== t[0]) throw new Error('Unsupported screenshot transform')
      const ratio = t[0], left = -t[4], top = -t[5]
      const context = canvas.getContext('2d')
      if (!context || canvas.width * canvas.height > 24_000_000) throw new Error('Screenshot exceeds the canvas budget')
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
      const rasterWidth = Math.ceil(viewport.width * ratio), rasterHeight = Math.ceil(viewport.height * ratio)
      const startX = Math.max(0, Math.floor(left)), startY = Math.max(0, Math.floor(top))
      const endX = Math.min(rasterWidth, Math.ceil(left + canvas.width)), endY = Math.min(rasterHeight, Math.ceil(top + canvas.height))
      for (let y = startY; y < endY; y += 512) for (let x = startX; x < endX; x += 512) {
        controller.signal.throwIfAborted()
        const image = await this.tile({ rotation: (viewport.rotation - this.rotate + 360) % 360,
          rasterWidth, rasterHeight, x, y, width: Math.min(512, endX - x), height: Math.min(512, endY - y), annotations: options.annotations !== false }, controller.signal)
        context.drawImage(image, x - left, y - top)
      }
    })().catch(error => { if (controller.signal.aborted) throw Object.assign(new Error('Rendering cancelled'), { name: 'RenderingCancelledException' }); throw error })
    return { promise, cancel: () => controller.abort() }
  }
}

export async function openNativeDocument(snapshot: WorkspaceSnapshot, sessionId: string, api: NativeReaderApi, events?: NativeDocumentEvents) {
  const owner = new NativeDocument(snapshot, sessionId, api, events)
  return { document: owner, dispose: () => owner.dispose() }
}
