import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { PdfRect } from '../../../core/pdf-types.js'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { NativeDocument } from '../rendering/document.js'
import type { ReaderSelection } from '../model/reader-selection.js'
import { capturePdfRegion, type PdfRegionScreenshot } from '../rendering/reader-screenshot.js'

export type ReaderScreenshot = PdfRegionScreenshot & { page: number; region: PdfRect; revision: number }
export type ReaderScreenshotPhase = 'preparing' | 'cancelling' | null
export type ReaderRegion = { rect: PdfRect; quadPoints: number[] }

export interface ReaderScreenshotOptions {
  pdf: NativeDocument | null
  snapshot: WorkspaceSnapshot | null
  tabSignal: AbortSignal
  /** Token of the content currently mounted in the document preview. */
  displayOwnerToken: number | null
  ownerSequence: MutableRefObject<number>
  regionPurpose: MutableRefObject<'explanation' | 'screenshot' | null>
  currentSnapshot(): WorkspaceSnapshot | null
  /** Checks that the native handle belongs to the current snapshot. */
  documentReady(): boolean
  setMode: Dispatch<SetStateAction<'text' | 'region' | 'note'>>
  setSelection: Dispatch<SetStateAction<ReaderSelection | null>>
  clearSelection(): void
  clearAnnotation(): void
  closeToolsMenu(): void
  clearError(): void
  onError(error: unknown): void
  t(key: string): string
  /** Renderer override for focused tests; production uses the native region capture. */
  captureRegion?: typeof capturePdfRegion
}

/** A single screenshot action, scoped to one Reader occurrence and its native document. */
export function useReaderScreenshot(options: ReaderScreenshotOptions) {
  const [screenshot, setScreenshot] = useState<ReaderScreenshot | null>(null)
  const [phase, setPhase] = useState<ReaderScreenshotPhase>(null)
  const controller = useRef<AbortController | null>(null)
  const captureTask = useRef<Promise<void> | null>(null)
  const latest = useRef(options)
  latest.current = options

  useEffect(() => () => { controller.current?.abort() }, [])

  const reset = () => {
    controller.current?.abort()
    setPhase(null)
    setScreenshot(null)
  }

  const close = () => {
    setScreenshot(null)
    latest.current.clearSelection()
  }

  const cancel = () => {
    const { regionPurpose, setMode, clearSelection } = latest.current
    if (controller.current && !controller.current.signal.aborted) {
      controller.current.abort()
      setPhase('cancelling')
    }
    regionPurpose.current = null
    setScreenshot(null)
    setMode('text')
    clearSelection()
  }

  const begin = (explanationActive: boolean) => {
    const { displayOwnerToken, ownerSequence, regionPurpose, setMode, clearSelection,
      clearAnnotation, closeToolsMenu, onError, t } = latest.current
    if (explanationActive || controller.current || phase || screenshot) return
    if (displayOwnerToken === null || displayOwnerToken !== ownerSequence.current) {
      onError(new Error(t('reader.notReady')))
      return
    }
    clearSelection()
    clearAnnotation()
    setScreenshot(null)
    regionPurpose.current = 'screenshot'
    setMode('region')
    closeToolsMenu()
  }

  const takeRegion = async (page: number, region: ReaderRegion): Promise<void> => {
    const { pdf, snapshot, displayOwnerToken, ownerSequence, documentReady, tabSignal,
      regionPurpose, setMode, setSelection, clearError, onError, t,
      captureRegion = capturePdfRegion } = latest.current
    // Screenshot mode is one action: resume text selection even if the native
    // document became unavailable before the drag completed.
    regionPurpose.current = null
    setMode('text')
    if (!pdf || !snapshot || controller.current) return
    if (displayOwnerToken === null || displayOwnerToken !== ownerSequence.current || !documentReady()) {
      onError(new Error(t('reader.notReady')))
      return
    }
    const revision = snapshot.revision
    const owner = displayOwnerToken
    const taskController = new AbortController()
    controller.current = taskController
    const stop = () => taskController.abort()
    tabSignal.addEventListener('abort', stop, { once: true })
    if (tabSignal.aborted) taskController.abort()
    setSelection({ kind: 'region', revision, text: '', fragments: [{ page, ...region }] })
    setPhase('preparing')
    clearError()
    const run = async () => {
      try {
        const image = await captureRegion(pdf, page, region.rect, { signal: taskController.signal })
        const current = latest.current.currentSnapshot()
        if (!taskController.signal.aborted && latest.current.ownerSequence.current === owner
          && current?.id === snapshot.id && current.revision === revision) {
          setScreenshot({ ...image, page, region: region.rect, revision })
        }
      } catch (failure) {
        if (!taskController.signal.aborted) { onError(failure); setSelection(null) }
      } finally {
        tabSignal.removeEventListener('abort', stop)
        if (controller.current === taskController) { controller.current = null; setPhase(null) }
      }
    }
    const pending = run()
    captureTask.current = pending
    try { await pending }
    finally { if (captureTask.current === pending) captureTask.current = null }
  }

  return { screenshot, phase, controller, captureTask, busy: !!controller.current || !!phase || !!screenshot,
    begin, cancel, takeRegion, close, reset, setScreenshot }
}
