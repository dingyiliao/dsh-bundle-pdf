import type { WorkingCopyReadPort } from '../working-copy/index.js'
import { evidenceSha256 } from './provenance.js'

/** Observe an already authorized working copy without acquiring another owner or reading the disk. */
export function observePdfStatus(workspaces: WorkingCopyReadPort, sessionId: string, documentId: string) {
  const snapshot = workspaces.readSnapshot(sessionId, documentId)
  return { documentId: snapshot.id, path: snapshot.path, pageCount: snapshot.document.pageCount,
    sourceDigest: evidenceSha256(snapshot.bytes), sourceVersion: snapshot.sourceVersion,
    contentVersion: snapshot.contentVersion, revision: snapshot.revision,
    dirty: snapshot.dirty, conflict: snapshot.conflict, canUndo: snapshot.canUndo, canRedo: snapshot.canRedo,
    observedAt: new Date().toISOString(),
    limitations: ['Status reflects the working copy at observation time; external changes require a new file check.'] }
}
