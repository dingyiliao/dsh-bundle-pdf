import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../shared/contracts.js'

export type SaveFeedback = 'saving' | 'saved' | 'unsaved'
export interface SaveFeedbackState { kind: SaveFeedback; durationMs: number; occurrence: number; path?: string }

export interface ReaderSaveOptions {
  api: PdfClientApi
  sessionId: string
  resourceAddress: string
  tabSignal: AbortSignal
  snapshot: WorkspaceSnapshot | null
  ownerSequence: MutableRefObject<number>
  operationLock: MutableRefObject<boolean>
  currentSnapshot(): WorkspaceSnapshot | null
  act(operation: (current: WorkspaceSnapshot) => Promise<WorkspaceSnapshot>, conflictOnStaleSave?: boolean): Promise<WorkspaceSnapshot | undefined>
  pickSavePath?: (defaultPath: string) => Promise<string | null>
  openResource(address: string): void
  addressForPath(sessionId: string, path: string): string
  setError: Dispatch<SetStateAction<string>>
  onError(error: unknown): void
  t(key: string): string
}

/** The save flow owns feedback, target inspection and picker lifetime, not the PDF write transaction. */
export function useReaderSave(options: ReaderSaveOptions) {
  const { api, sessionId, resourceAddress, tabSignal, snapshot, ownerSequence, operationLock,
    currentSnapshot, act, pickSavePath, openResource, addressForPath, setError, onError, t } = options
  const [feedback, setFeedback] = useState<SaveFeedbackState | null>(null)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [saveAsPicking, setSaveAsPicking] = useState(false)
  const [savePath, setSavePath] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [target, setTarget] = useState<{ path: string; version: string | null } | null>(null)
  const [targetChecking, setTargetChecking] = useState(false)
  const [reloadConfirm, setReloadConfirm] = useState(false)
  const pickerLock = useRef(false)
  const feedbackOccurrence = useRef(0)
  const feedbackOwner = useRef<{ sessionId: string; resourceAddress: string } | null>(null)
  const previousDirty = useRef<{ id: string; dirty: boolean } | null>(null)

  const showFeedback = useCallback((kind: SaveFeedback | null, durationMs = 2600, path?: string) => {
    setFeedback(kind ? { kind, durationMs, occurrence: ++feedbackOccurrence.current, path } : null)
  }, [])

  useEffect(() => {
    if (feedbackOwner.current?.sessionId === sessionId && feedbackOwner.current.resourceAddress === resourceAddress) return
    feedbackOwner.current = { sessionId, resourceAddress }
    previousDirty.current = null
    showFeedback(null)
  }, [sessionId, resourceAddress, showFeedback])

  useEffect(() => {
    if (!snapshot) { previousDirty.current = null; return }
    const previous = previousDirty.current
    previousDirty.current = { id: snapshot.id, dirty: snapshot.dirty }
    if (previous?.id === snapshot.id && !previous.dirty && snapshot.dirty) showFeedback('unsaved')
    else if (previous?.id === snapshot.id && previous.dirty && !snapshot.dirty && feedback?.kind === 'unsaved') showFeedback(null)
  }, [snapshot?.id, snapshot?.dirty, feedback, showFeedback])

  const save = async (path?: string, confirmedTarget?: { version: string | null; overwrite: boolean }) => {
    const checkedTarget = confirmedTarget ?? (target && target.path === path ? { version: target.version, overwrite } : undefined)
    if (path && !checkedTarget) { setError(t('reader.targetUnchecked')); return }
    const originalPath = currentSnapshot()?.path
    showFeedback('saving', 0)
    let committed: WorkspaceSnapshot | undefined
    const result = await act(async (current) => {
      committed = await api.save(sessionId, current.id, current.revision,
        path ? { path, overwrite: checkedTarget!.overwrite, expectedTargetVersion: checkedTarget!.version } : {}, tabSignal)
      return committed
    }, !path || path === originalPath)
    // A successful same-file save can advance the source revision before its
    // RPC resolves, so the caller's stale-response guard may discard result.
    const sameResource = feedbackOwner.current?.sessionId === sessionId
      && feedbackOwner.current.resourceAddress === resourceAddress && !tabSignal.aborted
    const saved = result ?? (sameResource ? committed : undefined)
    if (saved) {
      showFeedback('saved', 2600, saved.path)
      setSaveAsOpen(false); setOverwrite(false)
      if (path && saved.path !== originalPath) {
        const nextAddress = addressForPath(sessionId, saved.path)
        feedbackOwner.current = { sessionId, resourceAddress: nextAddress }
        openResource(nextAddress)
      }
    } else if (sameResource) showFeedback(null)
  }

  const beginSaveAs = async () => {
    const current = currentSnapshot()
    if (!current || operationLock.current || pickerLock.current) return
    const defaultPath = /\.pdf$/i.test(current.path) ? current.path.replace(/\.pdf$/i, '-annotated.pdf') : `${current.path}-annotated.pdf`
    if (!pickSavePath) { setSavePath(defaultPath); setSaveAsOpen(true); return }
    const owner = ownerSequence.current
    pickerLock.current = true
    setSaveAsPicking(true)
    try {
      const path = await pickSavePath(defaultPath)
      if (!path || owner !== ownerSequence.current || tabSignal.aborted) return
      setError('')
      const inspected = await api.inspectTarget(sessionId, path, tabSignal)
      if (owner !== ownerSequence.current || tabSignal.aborted) return
      // The OS confirms replacement; Host still checks the observed target version.
      await save(path, { version: inspected.version, overwrite: inspected.version !== null })
    } catch (failure) {
      if (owner === ownerSequence.current && !tabSignal.aborted && !(failure instanceof Error && failure.name === 'AbortError')) onError(failure)
    } finally {
      pickerLock.current = false
      if (!tabSignal.aborted) setSaveAsPicking(false)
    }
  }

  useEffect(() => {
    setTarget(null)
    setOverwrite(false)
    if (!saveAsOpen || !savePath.trim()) { setTargetChecking(false); return }
    const controller = new AbortController()
    setTargetChecking(true)
    const timer = setTimeout(() => {
      void api.inspectTarget(sessionId, savePath, controller.signal).then(result => {
        if (!controller.signal.aborted) setTarget({ path: savePath, version: result.version })
      }).catch(failure => { if (!controller.signal.aborted) onError(failure) })
        .finally(() => { if (!controller.signal.aborted) setTargetChecking(false) })
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, sessionId, saveAsOpen, savePath, onError])

  return { feedback, setFeedback, showFeedback, saveAsOpen, setSaveAsOpen, saveAsPicking,
    savePath, setSavePath, overwrite, setOverwrite, target, targetChecking, reloadConfirm, setReloadConfirm,
    save, beginSaveAs }
}
