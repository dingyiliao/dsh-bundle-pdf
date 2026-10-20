import type { HostWorkspaceSnapshot } from '../working-copy/index.js'
import { evidenceSha256 } from './provenance.js'

/** Host-only file read under the caller's session and filesystem policy.
 * The adapter returns an exact content digest, not a stat-derived version.
 */
export type FreshSourceRead = (sessionId: string, snapshot: HostWorkspaceSnapshot,
  signal: AbortSignal) => Promise<{ path: string; digest: string }>

function stale(message: string): never {
  throw Object.assign(new Error(message), { code: 'pdf/stale-reader' })
}

/** A working copy can remain unchanged while its source is overwritten or removed. */
export async function assertFreshSource(sessionId: string, snapshot: HostWorkspaceSnapshot,
  readSource: FreshSourceRead, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let current: Awaited<ReturnType<FreshSourceRead>>
  try { current = await readSource(sessionId, snapshot, signal) }
  catch {
    signal.throwIfAborted()
    return stale('The PDF source can no longer be verified; reopen the document')
  }
  signal.throwIfAborted()
  if (current.path !== snapshot.path || current.digest !== evidenceSha256(snapshot.bytes)) {
    stale('The PDF source changed outside this working copy; reopen the document')
  }
}
