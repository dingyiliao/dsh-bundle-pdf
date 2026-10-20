import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { ReaderSelection } from '../model/reader-selection.js'
import type { TranslationPanelProps } from '../components/TranslationPanel.js'
import { currentTranslationSelection } from '../model/translation-selection.js'
import { TranslationService, type TranslationRegistry, type TranslationRequest } from '../../../translation/index.js'

type TranslationSelection = TranslationPanelProps['selection'] & {
  owner: number
  documentId: string
  contentVersion: string
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
  const latest = useRef(options)
  latest.current = options

  useEffect(() => () => { service.current?.dispose(); service.current = null }, [])
  useEffect(() => { service.current?.cancel(); setSelection(null) }, [options.engine, options.timeoutMs])

  const reset = () => { service.current?.setSource(undefined); setSelection(null) }
  const close = () => { service.current?.cancel(); setSelection(null) }
  const begin = () => {
    const { snapshot, selection: selected, displayOwnerToken, ownerSequence, targetLanguage, showSidebar } = latest.current
    if (!snapshot || !selected || selected.kind !== 'text' || selected.revision !== snapshot.revision
      || displayOwnerToken !== ownerSequence.current) return
    service.current?.cancel()
    showSidebar()
    setSelection({ text: selected.text, pages: selected.fragments.map(fragment => fragment.page),
      selectionBefore: selected.selectionBefore, selectionAfter: selected.selectionAfter,
      targetLanguage, owner: ownerSequence.current, documentId: snapshot.id,
      contentVersion: snapshot.contentVersion })
  }
  const translate = useCallback(async (request: TranslationRequest) => {
    const { translation, ownerSequence, currentSnapshot, timeoutMs, tabSignal, sessionId } = latest.current
    const source = currentTranslationSelection(selectionRef.current, ownerSequence.current, currentSnapshot())
    service.current ??= new TranslationService(translation)
    service.current.setSource({ documentId: source.documentId, contentVersion: source.contentVersion })
    return service.current.translate({ ...request, timeoutMs,
      signal: request.signal ? AbortSignal.any([request.signal, tabSignal]) : tabSignal,
      context: { sessionId, documentId: source.documentId, contentVersion: source.contentVersion,
        pages: source.pages, ...(request.text === source.text
          ? { selectionBefore: source.selectionBefore, selectionAfter: source.selectionAfter } : {}) } })
  }, [])

  return { selection, begin, translate, close, reset }
}
