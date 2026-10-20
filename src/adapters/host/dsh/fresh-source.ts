import type { FreshSourceRead } from '../../../modules/evidence/index.js'
import type { WorkingCopyAgent, WorkingCopyFilePort } from '../../../modules/working-copy/index.js'

/** Bridge the pure evidence check to the same session-scoped, policy-checked
 * file adapter used to open and save the working copy. No raw host fs bypass.
 */
export function freshSourceReader(files: Pick<WorkingCopyFilePort, 'read'>,
  agent: WorkingCopyAgent): FreshSourceRead {
  return async (sessionId, snapshot, signal) => {
    if (sessionId !== agent.session.id) throw Object.assign(new Error('PDF session identity changed'),
      { code: 'pdf/session-mismatch' })
    const source = await files.read(agent, snapshot.path, signal)
    return { path: source.path, digest: source.version }
  }
}
