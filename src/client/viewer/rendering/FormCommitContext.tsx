import { createContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { createReaderFormCommits, type ReaderFormCommits, type ReaderFormValue } from '../controllers/reader-form-commits.js'

export const ReaderFormCommitContext = createContext<ReaderFormCommits | null>(null)
export const ReaderFormCommitProvider = ReaderFormCommitContext.Provider

export function useFormCommitLifetime(owner: ReaderFormCommits) {
  const lease = useMemo(() => ({ generation: 0 }), [owner])
  useLayoutEffect(() => {
    const generation = ++lease.generation
    return () => { queueMicrotask(() => { if (lease.generation === generation) owner.dispose() }) }
  }, [owner, lease])
}

export interface ReaderFormCommitOptions {
  /** Session, document/content identity and edit permission; deliberately excludes revision. */
  identity: string
  commit(fieldId: string, value: ReaderFormValue): Promise<boolean>
  onError(error: unknown): void
}

/** Provider ownership survives ordinary working-copy revisions, including widget commits. */
export function useReaderFormCommits(options: ReaderFormCommitOptions) {
  const latest = useRef(options)
  latest.current = options
  const owner = useMemo(() => {
    const identity = options.identity
    return createReaderFormCommits((fieldId, value) => latest.current.identity === identity
      ? latest.current.commit(fieldId, value) : Promise.resolve(false), error => {
      if (latest.current.identity === identity) latest.current.onError(error)
    })
  }, [options.identity])
  useFormCommitLifetime(owner)
  const pending = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot)
  return { owner, pending, flush: owner.flush }
}
