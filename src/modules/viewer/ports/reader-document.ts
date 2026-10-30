import type { NativeTextContent, NativeTileRequest } from '../../../shared/native.ts'
import type { NativeViewport } from '../../../shared/geometry/native-viewport.js'

/** Document operations used by the native reader and its UI. */
export interface ReaderDocument {
  readonly numPages: number
  getPage(number: number): Promise<ReaderPage>
  getOutline(): Promise<ReaderOutlineItem[] | null>
  getDestination(name: string): Promise<unknown>
  getPageIndex(ref: unknown): Promise<number>
}

/** Document bookmarks, including their nested children and optional navigation target. */
export interface ReaderOutlineItem {
  id?: string
  title: string
  dest?: unknown
  url?: string | null
  items: ReaderOutlineItem[]
}

export interface ReaderAnnotation {
  id: string
  subtype: string
  rect: number[]
  quadPoints?: ArrayLike<number> | Iterable<number>
  dest?: unknown
  url?: string
  action?: string
}

export interface ReaderRenderOptions {
  canvas: HTMLCanvasElement
  viewport: NativeViewport
  transform?: number[]
  annotations?: boolean
}

export interface ReaderRenderTask {
  readonly promise: Promise<void>
  cancel(): void
}

/** Only native page operations used by the reader, selection and screenshot surfaces. */
export interface ReaderPage {
  readonly pageNumber: number
  readonly rotate: number
  readonly userUnit: number
  readonly view: number[]
  getViewport(options: { scale: number; rotation?: number; offsetX?: number; offsetY?: number; dontFlip?: boolean }): NativeViewport
  getTextContent(): Promise<NativeTextContent>
  getAnnotations(): Promise<ReaderAnnotation[]>
  tile(tile: Omit<NativeTileRequest, 'page'>, signal: AbortSignal): Promise<ImageBitmap>
  render(options: ReaderRenderOptions): ReaderRenderTask
}
