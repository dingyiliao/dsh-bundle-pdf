export interface ReaderDescriptor {
  bytesHash: string
  generation: number
  protocolVersion: 1
}
export interface NativeTileRequest {
  page: number; rotation: number; rasterWidth: number; rasterHeight: number
  x: number; y: number; width: number; height: number; annotations: boolean
}
export interface NativeTile { bytes: Uint8Array; width: number; height: number; mime: 'image/png' }
export interface NativeTextContent {
  items: { str: string; transform: number[]; width: number; height: number; dir: string; fontName: string; hasEOL: boolean;
    /** PDF-space origin and advance for each Unicode scalar; omitted for oversized pages. */
    glyphs?: [x: number, y: number, advance: number][] }[]
  styles: Record<string, { fontFamily: string; ascent: number; descent: number; vertical: boolean }>
  lang: string | null
  /** A mapping failure is distinct from a scanned/empty page. */
  quality?: { unmappedCharacters: number }
  /** Local, derived recognition must never be presented as exact native text. */
  extraction?: 'local-ocr'
  warnings?: string[]
}
export interface NativeOutlineItem {
  /** Stable outline identity supplied by the Host, independent of tree position. */
  id?: string
  title: string
  dest?: unknown
  url?: string
  items: NativeOutlineItem[]
}
export interface NativeReaderApi {
  tile(sessionId: string, id: string, reader: ReaderDescriptor, tile: NativeTileRequest, signal?: AbortSignal): Promise<NativeTile>
  text(sessionId: string, id: string, reader: ReaderDescriptor, page: number, signal?: AbortSignal): Promise<NativeTextContent>
  links(sessionId: string, id: string, reader: ReaderDescriptor, page: number, signal?: AbortSignal): Promise<unknown[]>
  outline(sessionId: string, id: string, reader: ReaderDescriptor, signal?: AbortSignal): Promise<NativeOutlineItem[] | null>
  destination(sessionId: string, id: string, reader: ReaderDescriptor, name: string, signal?: AbortSignal): Promise<unknown>
}
