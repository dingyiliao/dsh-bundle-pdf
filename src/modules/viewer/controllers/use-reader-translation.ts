import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { ReaderSelection } from '../model/reader-selection.js'
import type { TranslationPanelProps } from '../components/TranslationPanel.js'
import type { HostOcrRecognition } from '../ports/ocr.js'
import { currentTranslationSelection } from '../model/translation-selection.js'
import { translationContextLimit, TranslationError, TranslationService, type TranslationRegistry, type TranslationRequest } from '../../../translation/index.js'

type TranslationSelection = TranslationPanelProps['selection'] & {
  owner: number
  documentId: string
  contentVersion: string
  ocrRevision?: number
}

function splitsCharacter(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

export interface ReaderTranslationOptions {
  translation: TranslationRegistry
  sessionId: string
  tabSignal: AbortSignal
  snapshot: WorkspaceSnapshot | null
  displayOwnerToken: number | null
  ownerSequence: MutableRefObject<number>
  currentSnapshot(): WorkspaceSnapshot | null
  selection: ReaderSelection | null
  targetLanguage: string
  engine: string
  timeoutMs: number
  showSidebar(): void
}

/** Translation source, request ownership and cancellation for one Reader mount. */
export function useReaderTranslation(options: ReaderTranslationOptions) {
  const [selection, setSelection] = useState<TranslationSelection | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const service = useRef<TranslationService | null>(null)
  const alive = useRef(false)
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; service.current?.dispose(); service.current = null }
  }, [])
  useEffect(() => { service.current?.cancel(); selectionRef.current = null; setSelection(null) }, [options.engine, options.timeoutMs])

  useEffect(() => {
    const invalidateOcr = () => {
      if (selectionRef.current?.ocrRevision === undefined) return
      service.current?.cancel(new TranslationError('stale-result', 'The OCR transcript is no longer current.'))
      selectionRef.current = null
      setSelection(null)
    }
    const captured = selectionRef.current, current = options.currentSnapshot()
    if (captured?.ocrRevision !== undefined && (options.tabSignal.aborted
      || captured.owner !== options.ownerSequence.current || options.displayOwnerToken !== captured.owner
      || current?.id !== captured.documentId || current.contentVersion !== captured.contentVersion
      || current.revision !== captured.ocrRevision)) invalidateOcr()
    options.tabSignal.addEventListener('abort', invalidateOcr, { once: true })
    return () => options.tabSignal.removeEventListener('abort', invalidateOcr)
  }, [selection, options.snapshot?.id, options.snapshot?.contentVersion, options.snapshot?.revision,
    options.displayOwnerToken, options.tabSignal])

  const reset = () => { service.current?.setSource(undefined); selectionRef.current = null; setSelection(null) }
  const close = () => { service.current?.cancel(); selectionRef.current = null; setSelection(null) }
  const capture = (captured: TranslationPanelProps['selection'] & { ocrRevision?: number }): boolean => {
    const { snapshot, displayOwnerToken, ownerSequence, currentSnapshot, showSidebar, tabSignal } = latest.current
    const current = currentSnapshot()
    if (!alive.current || tabSignal.aborted || !snapshot || displayOwnerToken !== ownerSequence.current
      || snapshot.id !== current?.id || snapshot.contentVersion !== current.contentVersion
      || snapshot.revision !== current.revision) return false
    service.current?.cancel()
    const next = { ...captured, owner: ownerSequence.current, documentId: snapshot.id,
      contentVersion: snapshot.contentVersion }
    selectionRef.current = next
    setSelection(next)
    showSidebar()
    return true
  }
  const begin = () => {
    const { snapshot, selection: selected, targetLanguage } = latest.current
    if (!snapshot || !selected || selected.kind !== 'text' || selected.revision !== snapshot.revision
      || !selected.text.trim()) return
    capture({ text: selected.text, pages: selected.fragments.map(fragment => fragment.page),
      selectionBefore: selected.selectionBefore, selectionAfter: selected.selectionAfter,
      targetLanguage })
  }
  const beginOcr = (result: HostOcrRecognition, range?: { start: number; end: number }): boolean => {
    const { snapshot, targetLanguage } = latest.current
    if (!snapshot || result.documentId !== snapshot.id || result.contentVersion !== snapshot.contentVersion
      || result.revision !== snapshot.revision || !Number.isSafeInteger(result.page) || result.page < 1) return false
    const { text } = result
    const start = range?.start ?? 0, end = range?.end ?? text.length
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > text.length
      || end <= start || splitsCharacter(text, start) || splitsCharacter(text, end) || !text.slice(start, end).trim()) return false
    let before = Math.max(0, start - translationContextLimit), after = Math.min(text.length, end + translationContextLimit)
    if (splitsCharacter(text, before)) before++
    if (splitsCharacter(text, after)) after--
    return capture({ text: text.slice(start, end), pages: [result.page], targetLanguage, sourceKind: 'ocr',
      ocrRevision: result.revision, ...(start > 0 || end < text.length ? {
        selectionBefore: text.slice(before, start), selectionAfter: text.slice(end, after),
      } : {}) })
  }
  const translate = useCallback(async (request: TranslationRequest) => {
    const { translation, ownerSequence, currentSnapshot, timeoutMs, tabSignal, sessionId } = latest.current
    const assertCurrent = () => {
      const current = currentSnapshot()
      const source = currentTranslationSelection(selectionRef.current, ownerSequence.current, current)
      if (!alive.current || tabSignal.aborted || source.ocrRevision !== undefined && source.ocrRevision !== current?.revision) {
        throw new TranslationError('stale-result', 'The OCR transcript is no longer current.')
      }
      return source
    }
    const source = assertCurrent()
    service.current ??= new TranslationService(translation)
    service.current.setSource({ documentId: source.documentId, contentVersion: source.contentVersion })
    const result = await service.current.translate({ ...request, timeoutMs,
      signal: request.signal ? AbortSignal.any([request.signal, tabSignal]) : tabSignal,
      context: { sessionId, documentId: source.documentId, contentVersion: source.contentVersion,
        pages: source.pages, ...(request.text === source.text
          ? { ...(source.selectionBefore !== undefined ? { selectionBefore: source.selectionBefore } : {}),
            ...(source.selectionAfter !== undefined ? { selectionAfter: source.selectionAfter } : {}) } : {}) } })
    if (assertCurrent() !== source) throw new TranslationError('stale-result', 'The translation selection changed.')
    return result
  }, [])

  return { selection, begin, beginOcr, translate, close, reset }
}
