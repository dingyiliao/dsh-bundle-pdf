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
  items: { str: string; transform: number[]; width: number; height: number; dir: string; fontName: string; hasEOL: boolean }[]
  styles: Record<string, { fontFamily: string; ascent: number; descent: number; vertical: boolean }>
  lang: string | null
}
export interface NativeOutlineItem {
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
