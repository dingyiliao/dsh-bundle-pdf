import { NavigationHistory, type NavigationPosition } from '../navigation/index.js'
import type { PdfOcrTextPart } from '../ocr/mapping.js'

export interface OcrPage { words: PdfOcrTextPart[]; text: string; engine: string; warnings: string[] }
export interface ReaderLifetime {
  history: NavigationHistory
  position?: NavigationPosition
  contentVersion?: string
  ocrPages: Map<number, OcrPage>
  ocrConfiguration?: string
}

const tabs = new Map<string, { signal: AbortSignal; state: ReaderLifetime }>()

/** Tab hide/unmount preserves navigation; closing the tab occurrence disposes it. */
export function readerLifetime(sessionId: string, tabId: string, signal: AbortSignal, capacity: number): ReaderLifetime {
  const key = `${sessionId}:${tabId}`
  const existing = tabs.get(key)
  if (existing?.signal === signal) return existing.state
  const state: ReaderLifetime = { history: new NavigationHistory({ capacity }), ocrPages: new Map() }
  tabs.set(key, { signal, state })
  const release = () => {
    state.history.clear()
    state.ocrPages.clear()
    if (tabs.get(key)?.state === state) tabs.delete(key)
  }
  if (signal.aborted) release()
  else signal.addEventListener('abort', release, { once: true })
  return state
}
