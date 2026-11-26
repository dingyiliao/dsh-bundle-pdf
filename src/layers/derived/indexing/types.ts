export interface RetrievalCache {
  get(key: string): Promise<unknown>
  /** Presence only; consumers still validate immutable data before querying it. */
  has?(key: string): Promise<boolean>
  set(key: string, value: unknown): Promise<void>
  /** Atomically replace an unchanged JSON record; undefined expects absence.
   * A failed comparison must leave the current record untouched. */
  compareAndSet?(key: string, expected: unknown, value: unknown): Promise<boolean>
  /** All records are durable before success; implementations may commit one transaction. */
  setMany?(entries: readonly (readonly [string, unknown])[]): Promise<void>
  /** Remove all derived records for an explicit global cache reset. */
  clear?(): Promise<void>
  /** Remove an obsolete checkpoint after all readers of its generation drain. */
  delete?(key: string): Promise<void>
}
export type RetrievalPageUnitKind = 'native-text' | 'ocr-text' | 'image-description'
export interface RetrievalPageUnitProducer {
  id: string
  version?: string
  model?: string
  configurationIdentity?: string
}
export interface RetrievalPageUnitSpan {
  startUtf16: number
  endUtf16: number
  rectPdf: [number, number, number, number]
}
/** One exact representation of a logical content block. Generated offsets stay
 * local to this unit and must never be interpreted as native PDF text offsets. */
export interface RetrievalPageUnit {
  id: string
  blockId: string
  kind: RetrievalPageUnitKind
  text: string
  /** SHA-256 of the exact representation text, prefixed with sha256:. */
  digest: string
  paragraphBreaks?: number[]
  nativeRange?: { startUtf16: number; endUtf16: number }
  rectPdf?: [number, number, number, number]
  spans?: RetrievalPageUnitSpan[]
  producer?: RetrievalPageUnitProducer
  inputDigest?: string
}
export interface RetrievalPageFailure {
  code: string
}
export interface RetrievalPage {
  /** Joined page text, including OCR when the page has no native text. */
  text: string
  source: 'pdf-text' | 'ocr'
  warnings?: string[]
  paragraphBreaks?: number[]
  /** When supplied, these are the complete searchable units for this page. */
  units?: RetrievalPageUnit[]
  contentIdentity?: string
  /** Available representations are checkpointed; retry replaces the page
   * atomically and reuses successfully cached source layers and vectors. */
  failure?: RetrievalPageFailure
}
