import { fatalContentError } from '../document/index.js'
import type { RetrievalDocument, RetrievalEmbedding, RetrievalPorts } from './types.js'

/** Authority belongs to a caller, never to the content-addressed index. */
export interface RetrievalBinding {
  sessionId: string
  document: RetrievalDocument
  provider?: RetrievalEmbedding
  selectionIdentity: string
  extractionIdentity: string
  lifetime: { valid: boolean; id: string }
  signal: AbortSignal
}

const stale = () => Object.assign(new Error('No authorized PDF source remains for this indexing step.'), { code: 'pdf/stale-reader' })


/** A shared step owns its lease. A departing caller does not cancel another
 * caller's work; a changed/revoked source is replaced before derived data commits. */
export function createSharedRetrievalSource(ports: RetrievalPorts, bindings: ReadonlySet<RetrievalBinding>,
  signal: AbortSignal, checkIndex: () => void,
  checkBinding: (binding: RetrievalBinding) => void, checkOrigin: (binding: RetrievalBinding) => void) {
  let owner: RetrievalBinding | undefined
  let release: (() => void) | undefined
  const valid = (binding: RetrievalBinding) => {
    try { checkBinding(binding); return true } catch { return false }
  }
  function current(excluded: ReadonlySet<RetrievalBinding> = new Set()): RetrievalBinding {
    signal.throwIfAborted(); checkIndex()
    if (owner && bindings.has(owner) && !excluded.has(owner) && valid(owner)) return owner
    for (const binding of bindings) if (!excluded.has(binding) && valid(binding)) return binding
    throw stale()
  }
  function clear() { const dispose = release; owner = undefined; release = undefined; dispose?.() }
  async function run<T>(operation: (binding: RetrievalBinding) => Promise<T>): Promise<T> {
    const attempted = new Set<RetrievalBinding>()
    for (;;) {
      const binding = current(attempted)
      let acquiring = false
      try {
        if (owner !== binding) {
          clear(); acquiring = true
          release = await ports.documents.retain?.(binding.sessionId, binding.document.id, signal)
          owner = binding
          checkBinding(binding)
          acquiring = false
        }
        const value = await operation(binding)
        // A lease may finish a read after its subscriber left. Its exact source
        // must still match, and another live authorized subscriber must exist.
        checkOrigin(binding)
        current()
        return value
      } catch (error) {
        signal.throwIfAborted(); checkIndex()
        if (!acquiring && valid(binding) && fatalContentError(error) === undefined) throw error
        attempted.add(binding)
        clear()
      }
    }
  }
  return {
    current,
    check: () => { current() },
    read: (page: number) => run(binding => ports.pages.read(binding.sessionId, binding.document.id, page, signal)),
    embed: (texts: string[]) => run(binding => {
      if (!binding.provider) throw stale()
      return binding.provider.embed(texts, 'document', signal)
    }),
    signal,
    dispose: clear,
  }
}
export type SharedRetrievalSource = ReturnType<typeof createSharedRetrievalSource>
