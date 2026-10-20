import { beginPdfSpan } from '../../../shared/performance.js'
import type { PdfPageInfo } from '../../../core/pdf-types.js'
import type { NativeDocument } from '../rendering/document.js'
import type { OcrPage } from './reader-lifetime.js'
import { joinSearchText, searchItemAtOffset, searchOffsetMap, searchResultExcerpt,
  SearchProgressPacer, SearchTextIndex } from '../model/reader-search.js'

export interface ReaderSearchHit {
  page: number
  text: string
  x?: number
  y?: number
  source: 'native' | 'ocr'
}

export interface ReaderSearchRequest {
  document: NativeDocument
  pages: readonly PdfPageInfo[]
  ocrPages: ReadonlyMap<number, OcrPage>
  query: string
  signal: AbortSignal
  onProgress(hits: ReaderSearchHit[]): void
  onComplete(hits: ReaderSearchHit[]): void
  onError(error: unknown): void
  onSettled(): void
}

const yieldSearchTurn = () => {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler
  // A timer also makes progress in background tabs where rAF is suspended.
  return scheduler?.yield?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** Owns one tab's cancellable search task and its per-document text index. */
export class ReaderSearchController {
  private sequence = 0
  private indexed: { document: NativeDocument; index: SearchTextIndex } | null = null

  cancel(): void { this.sequence++ }

  invalidateDocument(): void {
    this.cancel()
    this.indexed = null
  }

  async run(request: ReaderSearchRequest): Promise<void> {
    const { document, pages, ocrPages, signal } = request
    const sequence = ++this.sequence
    const current = () => sequence === this.sequence && !signal.aborted
    if (this.indexed?.document !== document) this.indexed = { document, index: new SearchTextIndex() }
    const index = this.indexed.index
    const needle = request.query.trim().toLocaleLowerCase()
    const found: ReaderSearchHit[] = []
    const progress = new SearchProgressPacer(() => performance.now(), yieldSearchTurn,
      () => { if (current()) request.onProgress([...found]) }, current)
    const span = beginPdfSpan('client.search', { pageCount: document.numPages })
    let outcome: 'ok' | 'cancelled' | 'error' = 'ok'
    try {
      for (let number = 1; number <= document.numPages; number++) {
        if (!current()) { outcome = 'cancelled'; return }
        const ocr = ocrPages.get(number)
        if (ocr) {
          // OCR transcripts have no word boxes: a hit locates the page only.
          const match = ocr.text.toLocaleLowerCase().indexOf(needle)
          if (match >= 0 && found.length < 500 && !found.some(hit => hit.page === number)) {
            found.push({ page: number, text: searchResultExcerpt(ocr.text, match, needle.length), source: 'ocr' })
          }
        }
        if (found.length >= 500) break
        if (!index.mayContain(number, needle)) {
          const pause = progress.checkpoint(found.length)
          if (pause && !await pause) { outcome = 'cancelled'; return }
          continue
        }
        const page = await document.getPage(number)
        if (!current()) { outcome = 'cancelled'; return }
        const content = await page.getTextContent()
        if (!current()) { outcome = 'cancelled'; return }
        const items = content.items.filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        const { text: combined, starts } = joinSearchText(items)
        const folded = index.remember(number, combined)
        let offset = 0, match = -1
        let offsetMap: Uint32Array | undefined
        while ((match = folded.indexOf(needle, offset)) >= 0 && found.length < 500) {
          offsetMap ??= searchOffsetMap(combined, folded.length)
          const start = offsetMap[match]
          const mappedEnd = offsetMap[Math.min(folded.length, match + needle.length)]
          const end = mappedEnd > start ? mappedEnd : start + (combined.codePointAt(start)! > 0xffff ? 2 : 1)
          const itemIndex = searchItemAtOffset(starts, start)
          const transform = items[itemIndex]?.transform
          const box = pages[number - 1].cropBox
          found.push({ page: number, text: searchResultExcerpt(combined, start, end - start),
            x: transform?.[4] ?? box[0], y: transform?.[5] ?? box[3], source: 'native' })
          offset = match + Math.max(1, needle.length)
        }
        if (!current()) { outcome = 'cancelled'; return }
        const pause = progress.checkpoint(found.length)
        if (pause && !await pause) { outcome = 'cancelled'; return }
        if (found.length >= 500) break
      }
      if (current()) request.onComplete(found)
      else outcome = 'cancelled'
    } catch (error) {
      outcome = current() ? 'error' : 'cancelled'
      if (current()) request.onError(error)
    } finally {
      if (!current()) outcome = 'cancelled'
      span.end(outcome, { resultCount: found.length })
      if (current()) request.onSettled()
    }
  }
}
