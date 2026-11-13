export type ReaderFormValue = string | boolean | string[]

interface FormDraft { value: ReaderFormValue; version: number }

export interface ReaderFormCommits {
  stage(fieldId: string, value: ReaderFormValue, baseline: ReaderFormValue): void
  value(fieldId: string): ReaderFormValue | undefined
  commit(fieldId: string): Promise<boolean>
  flush(): Promise<boolean>
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
  dispose(): void
}

const sameValue = (left: ReaderFormValue, right: ReaderFormValue) => Array.isArray(left) && Array.isArray(right)
  ? left.length === right.length && left.every((value, index) => value === right[index]) : left === right
const copyValue = (value: ReaderFormValue): ReaderFormValue => Array.isArray(value) ? [...value] : value

/** One Reader owns staged widget values and serializes their existing mutation calls. */
export function createReaderFormCommits(write: (fieldId: string, value: ReaderFormValue) => Promise<boolean>,
  onError: (error: unknown) => void): ReaderFormCommits {
  const drafts = new Map<string, FormDraft>()
  const pending = new Map<string, Promise<boolean>>()
  const listeners = new Set<() => void>()
  let sequence = 0, disposed = false, snapshot = false
  let tail: Promise<unknown> = Promise.resolve()
  const publish = () => {
    const next = drafts.size > 0 || pending.size > 0
    if (snapshot === next) return
    snapshot = next
    for (const listener of listeners) listener()
  }
  const commit = (fieldId: string): Promise<boolean> => {
    if (disposed) return Promise.resolve(false)
    const running = pending.get(fieldId)
    if (running) return running.then(ok => ok && drafts.has(fieldId) ? commit(fieldId) : ok)
    const draft = drafts.get(fieldId)
    if (!draft) return Promise.resolve(true)
    const operation = tail.then(async () => {
      if (disposed) return false
      try {
        const ok = await write(fieldId, copyValue(draft.value))
        if (disposed) return false
        if (ok && drafts.get(fieldId)?.version === draft.version) drafts.delete(fieldId)
        return ok
      } catch (error) {
        if (!disposed) onError(error)
        return false
      }
    }).finally(() => {
      if (pending.get(fieldId) === operation) pending.delete(fieldId)
      publish()
    })
    pending.set(fieldId, operation)
    tail = operation
    publish()
    return operation.then(ok => ok && drafts.has(fieldId) ? commit(fieldId) : ok)
  }
  return {
    stage(fieldId, value, baseline) {
      if (disposed) return
      if (sameValue(value, baseline) && !pending.has(fieldId)) drafts.delete(fieldId)
      else if (!drafts.has(fieldId) || !sameValue(drafts.get(fieldId)!.value, value)) {
        drafts.set(fieldId, { value: copyValue(value), version: ++sequence })
      }
      publish()
    },
    value: fieldId => drafts.get(fieldId)?.value,
    commit,
    async flush() {
      if (disposed) return false
      // A blur may have started before the command's click. Join it, including
      // failures, before admitting any save, undo or document navigation.
      if ((await Promise.all([...pending.values()])).some(ok => !ok) || disposed) return false
      for (const fieldId of drafts.keys()) if (!await commit(fieldId)) return false
      return !disposed
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    dispose() { disposed = true; drafts.clear(); pending.clear(); publish(); listeners.clear() },
  }
}
