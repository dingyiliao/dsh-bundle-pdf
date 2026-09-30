import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist'

/** The document operations shared by PDF.js and the native reader. */
export interface ReaderDocument {
  readonly numPages: number
  getPage(number: number): Promise<ReaderPage>
  getDestination(name: string): Promise<unknown>
  getPageIndex(ref: Parameters<PDFDocumentProxy['getPageIndex']>[0]): Promise<number>
}

export interface ReaderTextContent {
  items: ({ str: string; transform: number[]; width: number; height: number; hasEOL: boolean } | { type: string })[]
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
  viewport: PageViewport
  transform?: number[]
  annotationMode?: number
  background?: string
}

export interface ReaderRenderTask {
  readonly promise: Promise<void>
  cancel(): void
}

/** Only page operations used by the reader, selection and screenshot surfaces. */
export interface ReaderPage {
  readonly pageNumber: number
  readonly rotate: number
  readonly userUnit: number
  readonly view: number[]
  getViewport(options: { scale: number; rotation?: number; offsetX?: number; offsetY?: number; dontFlip?: boolean }): PageViewport
  getTextContent(): Promise<ReaderTextContent>
  streamTextContent(): ReadableStream
  getAnnotations(options?: { intent?: string }): Promise<ReaderAnnotation[]>
  render(options: ReaderRenderOptions): ReaderRenderTask
  cleanup(): boolean
}
