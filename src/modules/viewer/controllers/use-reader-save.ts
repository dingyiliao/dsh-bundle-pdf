import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../shared/contracts.js'
import { createSaveLocation, resolveSaveLocation } from '../model/save-location.js'

export type SaveFeedback = 'saving' | 'saved' | 'unsaved' | 'failed'
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
  pickSaveDirectory?: () => Promise<string | null>
  openResource(address: string): void
  addressForPath(sessionId: string, path: string): string
  setError: Dispatch<SetStateAction<string>>
  onError(error: unknown): void
  t(key: string): string
}

/** Own the Save As draft and target inspection; Host owns the PDF write transaction. */
export function useReaderSave(options: ReaderSaveOptions) {
  const { api, sessionId, resourceAddress, tabSignal, snapshot, ownerSequence, operationLock,
    currentSnapshot, act, pickSaveDirectory, openResource, addressForPath, setError, onError, t } = options
  const [feedback, setFeedback] = useState<SaveFeedbackState | null>(null)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [saveAsPicking, setSaveAsPicking] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveDirectory, setSaveDirectory] = useState('')
  const [replaceConfirm, setReplaceConfirm] = useState(false)
  const [target, setTarget] = useState<{ path: string; version: string | null } | null>(null)
  const [targetChecking, setTargetChecking] = useState(false)
  const [reloadConfirm, setReloadConfirm] = useState(false)
  const [targetAttempt, setTargetAttempt] = useState(0)
  const pickerLock = useRef<object | null>(null)
  const dialogOwner = useRef<object | null>(null)
  const feedbackOccurrence = useRef(0)
  const feedbackOwner = useRef<{ sessionId: string; resourceAddress: string } | null>(null)
  const previousDirty = useRef<{ id: string; revision: number; dirty: boolean } | null>(null)
  const location = resolveSaveLocation(saveDirectory, saveName)
  const savePath = 'path' in location ? location.path : undefined

  const closeSaveAs = useCallback(() => {
    dialogOwner.current = null
    pickerLock.current = null
    setSaveAsPicking(false)
    setSaveAsOpen(false)
    setReplaceConfirm(false)
    setTarget(null)
    setTargetChecking(false)
  }, [])

  useEffect(() => {
    closeSaveAs()
    const abort = () => closeSaveAs()
    tabSignal.addEventListener('abort', abort, { once: true })
    return () => {
      tabSignal.removeEventListener('abort', abort)
      dialogOwner.current = null
      pickerLock.current = null
    }
  }, [api, sessionId, resourceAddress, snapshot?.id, tabSignal, closeSaveAs])

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
    if (!snapshot) { previousDirty.current = null; showFeedback(null); return }
    const previous = previousDirty.current
    previousDirty.current = { id: snapshot.id, revision: snapshot.revision, dirty: snapshot.dirty }
    if (previous && previous.id !== snapshot.id) showFeedback(null)
    else if (previous && !previous.dirty && snapshot.dirty && feedback?.kind !== 'failed' && feedback?.kind !== 'saving') showFeedback('unsaved')
    else if (previous && !snapshot.dirty && (previous.dirty || previous.revision !== snapshot.revision)
      && (feedback?.kind === 'unsaved' || feedback?.kind === 'failed')) showFeedback(null)
  }, [snapshot?.id, snapshot?.revision, snapshot?.dirty, feedback, showFeedback])

  const save = async (path?: string, confirmedTarget?: { version: string | null; overwrite: boolean }) => {
    const checkedTarget = confirmedTarget ?? (target && target.path === path
      ? { version: target.version, overwrite: replaceConfirm } : undefined)
    if (path && !checkedTarget) { setError(t('reader.targetUnchecked')); return }
    const original = currentSnapshot()
    const originalPath = original?.path
    const resourceOwner = feedbackOwner.current
    const previousFeedback = feedback
    let committed: WorkspaceSnapshot | undefined
    let attempted = false
    let failed = false
    let attemptOwner: number | undefined
    const result = await act(async (current) => {
      attempted = true
      attemptOwner = ownerSequence.current
      showFeedback('saving', 0)
      try {
        committed = await api.save(sessionId, current.id, current.revision,
          path ? { path, overwrite: checkedTarget!.overwrite, expectedTargetVersion: checkedTarget!.version } : {}, tabSignal)
        return committed
      } catch (failure) {
        failed = !(failure instanceof Error && failure.name === 'AbortError')
        throw failure
      }
    }, !path || path === originalPath)
    // A successful same-file save can advance the source revision before its
    // RPC resolves, so the caller's stale-response guard may discard result.
    const sameResource = feedbackOwner.current === resourceOwner && currentSnapshot()?.id === original?.id && !tabSignal.aborted
    if (!sameResource) return
    const saved = result ?? committed
    if (saved) {
      showFeedback('saved', 2000, saved.path)
      closeSaveAs()
      if (path && saved.path !== originalPath) {
        const nextAddress = addressForPath(sessionId, saved.path)
        feedbackOwner.current = { sessionId, resourceAddress: nextAddress }
        openResource(nextAddress)
      }
    } else if (attempted) {
      if (attemptOwner !== ownerSequence.current) setFeedback(current => current?.kind === 'saving' ? null : current)
      else if (failed) {
        showFeedback('failed', 0, originalPath)
        if (path && dialogOwner.current) {
          // A target can change after inspection. Refresh it after a refused
          // write and require a new replacement decision for its new version.
          setTarget(null); setReplaceConfirm(false); setTargetAttempt(value => value + 1)
        }
      }
      else setFeedback(previousFeedback)
    }
  }

  const beginSaveAs = () => {
    const current = currentSnapshot()
    if (!current || operationLock.current || pickerLock.current) return
    const initial = createSaveLocation(current.path)
    dialogOwner.current = {}
    setSaveName(initial.name); setSaveDirectory(initial.directory)
    setTarget(null); setReplaceConfirm(false); setError(''); setSaveAsOpen(true)
    setTargetAttempt(value => value + 1)
  }

  const chooseSaveDirectory = async () => {
    const dialog = dialogOwner.current
    if (!dialog || !pickSaveDirectory || operationLock.current || pickerLock.current) return
    const owner = ownerSequence.current
    const request = {}
    pickerLock.current = request
    setSaveAsPicking(true)
    const active = () => dialogOwner.current === dialog && pickerLock.current === request
      && owner === ownerSequence.current && !tabSignal.aborted
    try {
      const directory = await pickSaveDirectory()
      if (!directory || !active()) return
      setError('')
      setSaveDirectory(directory)
    } catch (failure) {
      if (active() && !(failure instanceof Error && failure.name === 'AbortError')) onError(failure)
    } finally {
      if (pickerLock.current === request) {
        pickerLock.current = null
        if (!tabSignal.aborted) setSaveAsPicking(false)
      }
    }
  }

  const submitSaveAs = async () => {
    if (!dialogOwner.current || !savePath || saveAsPicking || targetChecking || operationLock.current
      || !target || target.path !== savePath) return
    if (target.version !== null && !replaceConfirm) { setReplaceConfirm(true); return }
    await save(savePath)
  }

  useEffect(() => {
    setTarget(null)
    setReplaceConfirm(false)
    if (!saveAsOpen || !savePath) { setTargetChecking(false); return }
    const controller = new AbortController()
    const owner = dialogOwner.current
    const active = () => !controller.signal.aborted && !tabSignal.aborted && dialogOwner.current === owner
    setTargetChecking(true)
    const timer = setTimeout(() => {
      void api.inspectTarget(sessionId, savePath, controller.signal).then(result => {
        if (active()) setTarget({ path: savePath, version: result.version })
      }).catch(failure => { if (active()) onError(failure) })
        .finally(() => { if (active()) setTargetChecking(false) })
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, sessionId, saveAsOpen, savePath, targetAttempt, tabSignal, onError])

  return { feedback, setFeedback, showFeedback, saveAsOpen, closeSaveAs, saveAsPicking,
    savePath, saveName, setSaveName, saveDirectory, setSaveDirectory,
    locationError: 'error' in location ? location.error : undefined,
    replaceConfirm, backToSaveAs: () => setReplaceConfirm(false),
    target, targetChecking, reloadConfirm, setReloadConfirm, save, beginSaveAs, chooseSaveDirectory, submitSaveAs }
}
