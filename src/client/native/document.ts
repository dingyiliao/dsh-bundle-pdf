import { ByteCache } from '../../engine/byte-cache.ts'
import type { NativeReaderApi, NativeTextContent, NativeTileRequest } from '../../shared/native.ts'
import type { WorkspaceSnapshot } from '../../shared/contracts.ts'
import type { ReaderAnnotation, ReaderDocument, ReaderPage, ReaderRenderOptions } from '../reader-document.ts'
import { NativeViewport } from './viewport.ts'

export const nativeDocument = (document: ReaderDocument): NativeDocument | undefined => document instanceof NativeDocument ? document : undefined
export const nativePage = (page: ReaderPage): NativePage | undefined => page instanceof NativePage ? page : undefined

/** Only the public reader methods are adapted. No PDF.js parser or worker is opened. */
export class NativeDocument implements ReaderDocument {
  readonly numPages: number
  readonly lifetime = new AbortController()
  private pageCache = new Map<number, NativePage>()
  private textCache = new ByteCache<NativeTextContent>(4 * 1024 * 1024)
  private bitmapCache = new ByteCache<ImageBitmap>(24 * 1024 * 1024, image => image.close())
  constructor(readonly snapshot: WorkspaceSnapshot, readonly sessionId: string, readonly api: NativeReaderApi) {
    this.numPages = snapshot.document.pageCount
  }
  async getPage(number: number): Promise<ReaderPage> {
    this.lifetime.signal.throwIfAborted()
    if (!Number.isInteger(number) || number < 1 || number > this.numPages) throw new RangeError('Page is outside the PDF')
    let page = this.pageCache.get(number)
    if (!page) page = new NativePage(this, number)
    this.pageCache.delete(number); this.pageCache.set(number, page)
    while (this.pageCache.size > 32) this.pageCache.delete(this.pageCache.keys().next().value!)
    return page
  }
  getDestination(name: string): Promise<unknown> {
    return this.api.destination(this.sessionId, this.snapshot.id, this.snapshot.reader!, name, this.lifetime.signal)
  }
  async getPageIndex(ref: unknown): Promise<number> {
    if (typeof ref === 'number' && ref >= 0 && ref < this.numPages) return ref
    throw new Error('Native destinations must carry a page index')
  }
  async text(number: number, signal?: AbortSignal): Promise<NativeTextContent> {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    combined.throwIfAborted()
    const key = String(number), cached = this.textCache.get(key)
    if (cached) return cached
    const value = await this.api.text(this.sessionId, this.snapshot.id, this.snapshot.reader!, number, combined)
    combined.throwIfAborted()
    this.textCache.set(key, value, JSON.stringify(value).length * 2)
    return value
  }
  async bitmap(tile: NativeTileRequest, signal: AbortSignal): Promise<ImageBitmap> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    const key = JSON.stringify(tile), cached = this.bitmapCache.get(key)
    if (cached) return cached
    const result = await this.api.tile(this.sessionId, this.snapshot.id, this.snapshot.reader!, tile, combined)
    const image = await createImageBitmap(new Blob([new Uint8Array(result.bytes)], { type: result.mime }))
    if (combined.aborted) { image.close(); combined.throwIfAborted() }
    this.bitmapCache.set(key, image, image.width * image.height * 4)
    return image
  }
  diagnostics() { return { bitmapCacheBytes: this.bitmapCache.bytes, textCacheBytes: this.textCache.bytes, pageProxies: this.pageCache.size } }
  async dispose(): Promise<void> { this.lifetime.abort(); this.bitmapCache.clear(); this.textCache.clear(); this.pageCache.clear() }
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
  streamTextContent(): ReadableStream<NativeTextContent> {
    return new ReadableStream({ start: async controller => {
      try { controller.enqueue(await this.getTextContent()); controller.close() } catch (error) { controller.error(error) }
    } })
  }
  async getAnnotations(): Promise<ReaderAnnotation[]> {
    const links = await this.owner.api.links(this.owner.sessionId, this.owner.snapshot.id, this.owner.snapshot.reader!, this.pageNumber, this.owner.lifetime.signal) as ReaderAnnotation[]
    return [...links, ...this.owner.snapshot.document.annotations.filter(a => a.page === this.pageNumber && a.linkAction && a.rect)
      .map(a => ({ id: a.id, subtype: 'Link', rect: a.rect!, quadPoints: a.quadPoints, action: a.linkAction }))]
  }
  cleanup(): boolean { return true }
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
          rasterWidth, rasterHeight, x, y, width: Math.min(512, endX - x), height: Math.min(512, endY - y), annotations: options.annotationMode !== 0 }, controller.signal)
        context.drawImage(image, x - left, y - top)
      }
    })().catch(error => { if (controller.signal.aborted) throw Object.assign(new Error('Rendering cancelled'), { name: 'RenderingCancelledException' }); throw error })
    return { promise, cancel: () => controller.abort() }
  }
}

export async function openNativeDocument(snapshot: WorkspaceSnapshot, sessionId: string, api: NativeReaderApi) {
  const owner = new NativeDocument(snapshot, sessionId, api)
  return { document: owner, dispose: () => owner.dispose() }
}
