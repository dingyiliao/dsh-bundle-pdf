import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { PdfRect } from '../../../core/pdf-types.js'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { ImageUnderstandingApi, ImageUnderstandingAvailability } from '../ports/image-understanding.js'
import type { PdfRegionEvidenceApi, PdfTextSelectionEvidenceApi, ReaderPromptExplanation } from '../ports/reader.js'
import type { NativeDocument } from '../rendering/document.js'
import type { ReaderSelection } from '../model/reader-selection.js'
import { addExplanationExcerpt, addExplanationRegion, MAX_EXPLANATION_EXCERPTS,
  updateExplanationExcerptQuestion, buildMixedExplanationPrompt,
  explanationSourceIdentity, sameExplanationSource,
  type ExplanationExcerpt, type ExplanationSourceIdentity } from '../../explanation/index.js'

type ExplanationEditorDraft = { key: string; question: string } & (
  | { kind: 'new'; draftId: string; selection: ReaderSelection }
  | { kind: 'edit'; excerptId: string }
)

export interface ReaderExplanationOptions {
  sessionId: string
  tabSignal: AbortSignal
  visible: boolean
  snapshot: WorkspaceSnapshot | null
  pdf: NativeDocument | null
  promptExplanation?: ReaderPromptExplanation
  imageUnderstanding: ImageUnderstandingApi
  regionEvidence?: PdfRegionEvidenceApi
  textSelectionEvidence?: PdfTextSelectionEvidenceApi
  allowReadingContext: boolean
  screenshotBusy: boolean
  displayReady: boolean
  mode: 'text' | 'region' | 'note'
  regionPurpose: MutableRefObject<'explanation' | 'screenshot' | null>
  ownerSequence: MutableRefObject<number>
  currentSnapshot(): WorkspaceSnapshot | null
  /** Re-read the source file digest immediately before a Session turn is admitted. */
  inspectSource(path: string, signal?: AbortSignal): Promise<string | null>
  documentReady(): boolean
  setMode: Dispatch<SetStateAction<'text' | 'region' | 'note'>>
  setSelection: Dispatch<SetStateAction<ReaderSelection | null>>
  clearSelection(): void
  clearAnnotation(): void
  closeToolsMenu(): void
  t(key: string): string
}

function sameSelection(left: ReaderSelection, right: ReaderSelection): boolean {
  return left.kind === right.kind && left.revision === right.revision && left.text === right.text
    && left.fragments.length === right.fragments.length
    && left.fragments.every((fragment, index) => {
      const other = right.fragments[index]
      return other?.page === fragment.page && fragment.rect.every((value, part) => value === other.rect[part])
        && fragment.quadPoints.length === other.quadPoints.length
        && fragment.quadPoints.every((value, part) => value === other.quadPoints[part])
    })
}

/** One reader occurrence owns question drafts, image capture, model capability and turn submission. */
export function useReaderExplanation(options: ReaderExplanationOptions) {
  const { sessionId, tabSignal, visible, snapshot, pdf, promptExplanation, imageUnderstanding,
    regionEvidence, textSelectionEvidence,
    allowReadingContext, screenshotBusy, displayReady, mode, regionPurpose, ownerSequence,
    currentSnapshot, inspectSource, documentReady, setMode, setSelection,
    clearSelection, clearAnnotation, closeToolsMenu, t } = options
  const [explanation, setExplanation] = useState<{
    key: string; source: ExplanationSourceIdentity; excerpts: ExplanationExcerpt[]
  } | null>(null)
  const [editor, setEditor] = useState<ExplanationEditorDraft | null>(null)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [imageAvailability, setImageAvailability] = useState<ImageUnderstandingAvailability | null>(null)
  const markerAnchor = useRef<HTMLElement | null>(null)
  const captureController = useRef<AbortController | null>(null)
  const captureTask = useRef<Promise<unknown> | null>(null)
  const key = snapshot ? `${sessionId}:${snapshot.id}:${snapshot.contentVersion}` : undefined
  const active = explanation?.key === key ? explanation : null
  const activeEditor = active && editor?.key === key ? editor : null
  const draftSelection = activeEditor?.kind === 'new' ? activeEditor.selection : null

  useEffect(() => {
    if (!visible || !active) { setImageAvailability(null); return }
    let mounted = true
    let request: AbortController | null = null
    const refresh = () => {
      request?.abort()
      request = new AbortController()
      const signal = AbortSignal.any([request.signal, tabSignal])
      void imageUnderstanding.availability(sessionId, signal).then(value => {
        if (mounted && !signal.aborted) setImageAvailability(value)
      }, failure => {
        if (mounted && !signal.aborted) setImageAvailability({ status: 'unavailable',
          reason: failure instanceof Error ? failure.message : t('reader.explain.imageUnavailable') })
      })
    }
    refresh()
    const timer = setInterval(refresh, 15_000)
    window.addEventListener('focus', refresh)
    return () => { mounted = false; request?.abort(); clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [!!active, imageUnderstanding, sessionId, visible, tabSignal, t])

  useEffect(() => {
    if (explanation && explanation.key !== key) {
      captureController.current?.abort()
      if (regionPurpose.current === 'explanation') regionPurpose.current = null
      setExplanation(null)
      setEditor(null)
      setError('')
      setSending(false)
      if (!captureTask.current) setSaving(false)
      setMode('text')
    }
  }, [explanation, key])

  const cancel = () => {
    captureController.current?.abort()
    if (regionPurpose.current === 'explanation') regionPurpose.current = null
    setExplanation(null)
    setEditor(null)
    if (!captureTask.current) setSaving(false)
    markerAnchor.current = null
    setError('')
    setMode('text')
    clearSelection()
    closeToolsMenu()
  }

  const start = (initialSelection?: ReaderSelection) => {
    if (!key || !promptExplanation || !allowReadingContext || screenshotBusy) return
    const source = explanationSourceIdentity(sessionId, currentSnapshot())
    if (!source || !sameExplanationSource(source, sessionId, snapshot)
      || initialSelection && initialSelection.revision !== source.revision) {
      setError(t('reader.explain.sourceChanged'))
      return
    }
    regionPurpose.current = null
    setMode('text')
    setExplanation({ key, source, excerpts: [] })
    setEditor(initialSelection?.kind === 'text' && initialSelection.text.trim()
      ? { key, kind: 'new', draftId: crypto.randomUUID(), selection: initialSelection, question: '' }
      : null)
    markerAnchor.current = null
    setError('')
    if (!initialSelection) clearSelection()
    closeToolsMenu()
  }

  const saveQuestion = async () => {
    if (!activeEditor || !active || sending || saving) return
    if (!sameExplanationSource(active.source, sessionId, currentSnapshot())) {
      setError(t('reader.explain.sourceChanged'))
      return
    }
    if (!activeEditor.question.trim()) { setError(t('reader.explain.questionRequired')); return }
    if (activeEditor.kind === 'new') {
      if (activeEditor.selection.revision !== active.source.revision) {
        setError(t('reader.explain.sourceChanged'))
        return
      }
      if (activeEditor.selection.kind === 'region') {
        const fragment = activeEditor.selection.fragments[0]
        if (!fragment || !pdf || !snapshot || !documentReady()) { setError(t('reader.notReady')); return }
        if (!regionEvidence) { setError(t('reader.explain.imageUnavailable')); return }
        const owner = ownerSequence.current
        const controller = new AbortController()
        captureController.current = controller
        const signal = AbortSignal.any([controller.signal, tabSignal])
        setSaving(true)
        let pending: ReturnType<PdfRegionEvidenceApi['prepare']> | null = null
        try {
          pending = regionEvidence.prepare({ sessionId, documentId: active.source.documentId,
            page: fragment.page, rectPdf: fragment.rect,
            expectedRevision: active.source.revision,
            expectedContentVersion: active.source.contentVersion }, signal)
          captureTask.current = pending
          const image = await pending
          signal.throwIfAborted()
          const current = currentSnapshot()
          if (ownerSequence.current !== owner) return
          if (!sameExplanationSource(active.source, sessionId, current)) {
            setError(t('reader.explain.sourceChanged'))
            return
          }
          if (image.documentId !== active.source.documentId || image.page !== fragment.page
            || image.sourcePath !== active.source.path || image.sourceDigest !== active.source.baselineDigest
            || image.sourceVersion !== active.source.sourceVersion
            || image.contentVersion !== active.source.contentVersion || image.revision !== active.source.revision) {
            setError(t('reader.explain.sourceChanged'))
            return
          }
          const next = addExplanationRegion(active.excerpts, activeEditor.selection,
            { blob: new Blob([new Uint8Array(image.bytes)], { type: image.mediaType }),
              width: image.width, height: image.height, mediaType: image.mediaType,
              evidenceRefId: image.refId }, crypto.randomUUID(), activeEditor.question)
          if (!next.ok) { setError(t(`reader.explain.${next.reason}`)); return }
          setExplanation({ ...active, excerpts: next.excerpts })
          setEditor(null)
          markerAnchor.current = null
          setError('')
          clearSelection()
        } catch (failure) {
          if (!signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          if (captureTask.current === pending) captureTask.current = null
          if (captureController.current === controller) {
            captureController.current = null
            if (!tabSignal.aborted) setSaving(false)
          }
        }
        return
      }
      if (!textSelectionEvidence) { setError(t('reader.explain.sourceChanged')); return }
      const owner = ownerSequence.current
      const controller = new AbortController()
      captureController.current = controller
      const signal = AbortSignal.any([controller.signal, tabSignal])
      setSaving(true)
      let pending: ReturnType<PdfTextSelectionEvidenceApi['prepare']> | null = null
      try {
        pending = textSelectionEvidence.prepare({ sessionId, documentId: active.source.documentId,
          expectedRevision: active.source.revision, expectedContentVersion: active.source.contentVersion,
          quote: activeEditor.selection.text, fragments: activeEditor.selection.fragments }, signal)
        captureTask.current = pending
        const checked = await pending
        signal.throwIfAborted()
        if (ownerSequence.current !== owner) return
        if (!sameExplanationSource(active.source, sessionId, currentSnapshot())
          || checked.documentId !== active.source.documentId
          || checked.sourcePath !== active.source.path
          || checked.sourceDigest !== active.source.baselineDigest
          || checked.sourceVersion !== active.source.sourceVersion
          || checked.contentVersion !== active.source.contentVersion
          || checked.revision !== active.source.revision) {
          setError(t('reader.explain.sourceChanged'))
          return
        }
        const next = addExplanationExcerpt(active.excerpts,
          { ...activeEditor.selection, text: checked.text }, crypto.randomUUID(), activeEditor.question)
        if (!next.ok) { setError(t(`reader.explain.${next.reason}`)); return }
        const excerpts = next.excerpts.map((excerpt, index) => index === next.excerpts.length - 1 && excerpt.kind === 'text'
          ? { ...excerpt, evidenceRefs: checked.excerpts.map(item => item.refId) } : excerpt)
        setExplanation({ ...active, excerpts })
        setEditor(null)
        markerAnchor.current = null
        setError('')
        clearSelection()
      } catch (failure) {
        if (!signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (captureTask.current === pending) captureTask.current = null
        if (captureController.current === controller) {
          captureController.current = null
          if (!tabSignal.aborted) setSaving(false)
        }
      }
      return
    } else {
      setExplanation({ ...active,
        excerpts: updateExplanationExcerptQuestion(active.excerpts, activeEditor.excerptId, activeEditor.question) })
    }
    setEditor(null)
    markerAnchor.current = null
    setError('')
    clearSelection()
  }

  const cancelEditor = () => {
    captureController.current?.abort()
    setEditor(null)
    if (!captureTask.current) setSaving(false)
    markerAnchor.current = null
    setError('')
    clearSelection()
  }

  const deleteQuestion = () => {
    if (!activeEditor || activeEditor.kind !== 'edit' || !active || sending) return
    setExplanation({ ...active, excerpts: active.excerpts.filter(excerpt => excerpt.id !== activeEditor.excerptId) })
    cancelEditor()
  }

  const submit = async () => {
    if (!active?.excerpts.length || activeEditor || !snapshot || !promptExplanation || sending || saving) return
    const submittedKey = active.key
    const source = active.source
    if (!sameExplanationSource(source, sessionId, currentSnapshot())) {
      setError(t('reader.explain.sourceChanged'))
      return
    }
    setSending(true)
    setError('')
    try {
      const prompt = await buildMixedExplanationPrompt(source.path, active.excerpts, t, {
        sessionId, documentId: source.documentId,
        prepareReference: (request, signal) => imageUnderstanding.prepareReference(request, signal),
        signal: tabSignal,
      })
      tabSignal.throwIfAborted()
      const diskDigest = await inspectSource(source.path, tabSignal)
      tabSignal.throwIfAborted()
      const before = currentSnapshot()
      if (diskDigest !== source.baselineDigest || !sameExplanationSource(source, sessionId, before)) {
        setError(t('reader.explain.sourceChanged'))
        return
      }
      await promptExplanation(prompt, tabSignal)
      const after = currentSnapshot()
      if (sameExplanationSource(source, sessionId, after) && !tabSignal.aborted) {
        setExplanation(draft => draft?.key === submittedKey ? null : draft)
        setEditor(null)
        clearSelection()
      }
    } catch (failure) {
      if (!tabSignal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (!tabSignal.aborted) setSending(false)
    }
  }

  const sameDraftSelection = (selection: ReaderSelection | null) => !!selection && activeEditor?.kind === 'new'
    && sameSelection(selection, activeEditor.selection)

  const offerTextSelection = (selection: ReaderSelection | null) => {
    if (!active || sending || selection?.kind !== 'text' || !selection.text.trim()) return
    if (!sameExplanationSource(active.source, sessionId, currentSnapshot())
      || selection.revision !== active.source.revision) {
      setError(t('reader.explain.sourceChanged'))
      return
    }
    if (active.excerpts.length >= MAX_EXPLANATION_EXCERPTS) { setError(t('reader.explain.limit')); return }
    markerAnchor.current = null
    setEditor({ key: active.key, kind: 'new', draftId: crypto.randomUUID(), selection, question: '' })
    setError('')
  }

  const beginRegion = () => {
    if (!active || sending || saving || activeEditor) return
    if (!regionEvidence) { setError(t('reader.explain.imageUnavailable')); return }
    if (!sameExplanationSource(active.source, sessionId, currentSnapshot())) {
      setError(t('reader.explain.sourceChanged'))
      return
    }
    if (mode === 'region' && regionPurpose.current === 'explanation') {
      regionPurpose.current = null
      setMode('text')
      return
    }
    if (!displayReady || !pdf || !snapshot) { setError(t('reader.notReady')); return }
    if (active.excerpts.length >= MAX_EXPLANATION_EXCERPTS) { setError(t('reader.explain.limit')); return }
    clearSelection()
    clearAnnotation()
    setError('')
    regionPurpose.current = 'explanation'
    setMode('region')
  }

  const selectRegion = (page: number, region: { rect: PdfRect; quadPoints: number[] }): boolean => {
    if (!active || regionPurpose.current !== 'explanation') return false
    regionPurpose.current = null
    if (sending || saving || !snapshot) return true
    setMode('text')
    if (!sameExplanationSource(active.source, sessionId, currentSnapshot())) {
      setError(t('reader.explain.sourceChanged'))
      return true
    }
    const selection: ReaderSelection = { kind: 'region', revision: snapshot.revision, text: '',
      fragments: [{ page, rect: [...region.rect], quadPoints: [...region.quadPoints] }] }
    setSelection(selection)
    markerAnchor.current = null
    setEditor({ key: active.key, kind: 'new', draftId: crypto.randomUUID(), selection, question: '' })
    setError('')
    return true
  }

  const editQuestion = (id: string, marker: HTMLElement) => {
    if (!active || sending) return
    if (!sameExplanationSource(active.source, sessionId, currentSnapshot())) {
      setError(t('reader.explain.sourceChanged'))
      return
    }
    const excerpt = active.excerpts.find(item => item.id === id)
    if (!excerpt) return
    clearSelection()
    markerAnchor.current = marker
    setEditor({ key: active.key, kind: 'edit', excerptId: id, question: excerpt.question })
    setError('')
  }

  return { key, active, editor: activeEditor, draftSelection, error, sending, saving, imageAvailability,
    markerAnchor, captureController, captureTask, setEditor, start, cancel, saveQuestion, cancelEditor, deleteQuestion,
    submit, sameDraftSelection, offerTextSelection, beginRegion, selectRegion, editQuestion }
}
