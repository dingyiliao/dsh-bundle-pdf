import { useEffect, useRef, useState } from 'react'
import type { PdfPageInfo } from '../../../core/pdf-types.js'
import type { NativeDocument } from '../rendering/document.js'
import type { OcrPage } from './reader-lifetime.js'
import { ReaderSearchController, type ReaderSearchHit } from './search-controller.js'

export interface ReaderSearchOptions {
  document: NativeDocument | null
  pages: readonly PdfPageInfo[]
  ocrPages: ReadonlyMap<number, OcrPage>
  tabSignal: AbortSignal
  onError(error: unknown): void
}

/** Owns the search form and one cancellable search index for this Reader mount. */
export function useReaderSearch(options: ReaderSearchOptions) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<ReaderSearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const controller = useRef<ReaderSearchController | null>(null)
  controller.current ??= new ReaderSearchController()
  const latest = useRef(options)
  latest.current = options

  // A hidden tab may retain its Reader, but closing its occurrence must never
  // let a late native read publish into a later mount.
  useEffect(() => () => controller.current?.cancel(), [])

  const cancel = () => {
    controller.current?.cancel()
    setSearching(false)
  }

  const invalidateDocument = () => {
    controller.current?.invalidateDocument()
    setSearching(false)
    setHits([])
    setSearched(false)
  }

  const resetContent = () => invalidateDocument()

  const run = async (): Promise<void> => {
    const { document, pages, ocrPages, tabSignal, onError } = latest.current
    if (!document || !query.trim() || tabSignal.aborted) return
    setSearching(true)
    setSearched(false)
    setHits([])
    await controller.current!.run({ document, pages, ocrPages, query, signal: tabSignal,
      onProgress: setHits,
      onComplete: found => { setHits(found); setSearched(true) },
      onError,
      onSettled: () => setSearching(false) })
  }

  return { query, setQuery, searching, hits, searched, run, cancel, invalidateDocument, resetContent }
}
