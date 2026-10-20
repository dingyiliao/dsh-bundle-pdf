import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { PdfRect } from '../../../core/pdf-types.js'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import { captureTextSelection, pdfRectToViewport, type PageView, type ReaderSelection } from '../model/reader-selection.js'

export interface ReaderSelectionOptions {
  mode: 'text' | 'region' | 'note'
  scrollRoot: HTMLElement | null
  snapshot: WorkspaceSnapshot | null
  views: MutableRefObject<Map<number, PageView>>
  ownerSequence: MutableRefObject<number>
  currentSnapshot(): WorkspaceSnapshot | null
  tabSignal: AbortSignal
  setDraggingPage: Dispatch<SetStateAction<number | null>>
  shouldIgnore(selection: ReaderSelection | null): boolean
  onCaptured(selection: ReaderSelection | null): void
  onError(error: Error): void
  t(key: string): string
}

/** Owns transient text selection, settled pointer capture, copy feedback, and PDF-to-screen anchors. */
export function useReaderSelection(options: ReaderSelectionOptions) {
  const latest = useRef(options)
  latest.current = options
  const [selection, setSelection] = useState<ReaderSelection | null>(null)
  const [textCopied, setTextCopied] = useState(false)
  const currentSelection = useRef(selection)
  currentSelection.current = selection
  const frame = useRef<number | null>(null)
  const generation = useRef(0)

  const invalidate = useCallback(() => {
    generation.current++
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])
  useEffect(() => () => invalidate(), [invalidate])
  useEffect(() => {
    if (!textCopied) return
    const timer = setTimeout(() => setTextCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [textCopied])
  useEffect(() => { setTextCopied(false) }, [selection])

  const reset = useCallback(() => { invalidate(); setSelection(null) }, [invalidate])
  const clear = useCallback(() => {
    invalidate()
    setSelection(null)
    const browser = window.getSelection(), root = latest.current.scrollRoot
    if (browser?.rangeCount && root?.contains(browser.getRangeAt(0).commonAncestorContainer)) browser.removeAllRanges()
  }, [invalidate])
  const capture = useCallback(() => {
    const current = latest.current
    if (current.mode !== 'text' || !current.scrollRoot || !current.snapshot) return
    const next = captureTextSelection(current.scrollRoot, current.views.current, current.snapshot.revision)
    if (current.shouldIgnore(next)) return
    setSelection(next)
    current.onCaptured(next)
  }, [])
  const scheduleCapture = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    const current = latest.current
    const scheduledGeneration = generation.current
    const owner = current.ownerSequence.current
    const documentId = current.snapshot?.id, revision = current.snapshot?.revision
    // Native drag and double-click selection may finish on mouseup, after pointerup.
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const latestOptions = latest.current
      latestOptions.setDraggingPage(null)
      const now = latestOptions.currentSnapshot()
      if (scheduledGeneration !== generation.current || owner !== latestOptions.ownerSequence.current
        || now?.id !== documentId || now?.revision !== revision) return
      capture()
    })
  }, [capture])
  const copyText = useCallback(async () => {
    const current = latest.current
    const copiedSelection = currentSelection.current
    if (copiedSelection?.kind !== 'text' || copiedSelection.revision !== current.snapshot?.revision) return
    try {
      await navigator.clipboard.writeText(copiedSelection.text)
      if (!current.tabSignal.aborted && currentSelection.current === copiedSelection) setTextCopied(true)
    } catch { current.onError(new Error(current.t('reader.copyTextFailed'))) }
  }, [])
  const fragmentAnchor = useCallback((fragments: readonly {
    page: number; rect: PdfRect; quadPoints: readonly number[]
  }[]) => {
    const root = latest.current.scrollRoot
    if (!root) return null
    const bounds = root.getBoundingClientRect()
    let anchor: DOMRect | null = null
    for (const fragment of fragments) {
      const view = latest.current.views.current.get(fragment.page)
      if (!view) continue
      const pageBounds = view.element.getBoundingClientRect()
      const rectangles: PdfRect[] = []
      for (let index = 0; index + 7 < fragment.quadPoints.length; index += 8) {
        const points = Array.from({ length: 4 }, (_, offset) => view.viewport.convertToViewportPoint(
          fragment.quadPoints[index + offset * 2], fragment.quadPoints[index + offset * 2 + 1]))
        rectangles.push([Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
          Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))])
      }
      if (!rectangles.length) rectangles.push(pdfRectToViewport(view.viewport, fragment.rect))
      for (const box of rectangles) {
        const rect = new DOMRect(pageBounds.left + box[0], pageBounds.top + box[1], box[2] - box[0], box[3] - box[1])
        if (rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right) anchor = rect
      }
    }
    return anchor
  }, [])

  return {
    selection, setSelection, textCopied,
    hasTextSelection: selection?.kind === 'text' && selection.revision === options.snapshot?.revision,
    invalidate, reset, clear, capture, scheduleCapture, copyText, fragmentAnchor,
  }
}
