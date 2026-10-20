import { useRef, useState, type MutableRefObject } from 'react'
import type { PdfAnnotationOperation } from '../../../core/pdf-types.js'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../shared/contracts.js'

export interface ReaderMutationsOptions {
  api: PdfClientApi
  sessionId: string
  tabSignal: AbortSignal
  ownerSequence: MutableRefObject<number>
  currentSnapshot(): WorkspaceSnapshot | null
  acceptSnapshot(snapshot: WorkspaceSnapshot): void
  clearError(): void
  onError(error: unknown): void
}

const isAbortError = (value: unknown) => value instanceof Error && value.name === 'AbortError'
const isStalePdf = (value: unknown) => value instanceof Error && 'code' in value && value.code === 'PDF_STALE_VERSION'

/** Serialize PDF changes and discard replies from a document/tab that no longer owns this Reader. */
export function useReaderMutations(options: ReaderMutationsOptions) {
  const [busy, setBusy] = useState(false)
  const operationLock = useRef(false)
  const { api, sessionId, tabSignal, ownerSequence, currentSnapshot, acceptSnapshot, clearError, onError } = options
  const act = async (operation: (current: WorkspaceSnapshot) => Promise<WorkspaceSnapshot>,
    conflictOnStaleSave = false): Promise<WorkspaceSnapshot | undefined> => {
    const current = currentSnapshot()
    if (!current || operationLock.current) return undefined
    const owner = ownerSequence.current
    operationLock.current = true
    setBusy(true)
    clearError()
    try {
      const next = await operation(current)
      if (owner !== ownerSequence.current || tabSignal.aborted) return undefined
      acceptSnapshot(next)
      return next
    } catch (failure) {
      if (owner !== ownerSequence.current || tabSignal.aborted) return undefined
      if (conflictOnStaleSave && isStalePdf(failure)) {
        // A stale source is one conflict, not both an error banner and a conflict banner.
        const latest = currentSnapshot()
        if (latest?.id === current.id) acceptSnapshot({ ...latest, conflict: true })
      } else if (!isAbortError(failure)) onError(failure)
      return undefined
    } finally {
      operationLock.current = false
      setBusy(false)
    }
  }
  const change = (operations: PdfAnnotationOperation[]) => act(current =>
    api.change(sessionId, current.id, current.revision, operations, tabSignal))
  return { busy, operationLock, act, change }
}
