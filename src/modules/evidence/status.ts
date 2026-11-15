import type { WorkingCopyReadPort } from '../working-copy/index.js'
import { evidenceSha256 } from './provenance.js'

/** Observe an already authorized working copy without acquiring another owner or reading the disk. */
export function observePdfStatus(workspaces: WorkingCopyReadPort, sessionId: string, documentId: string) {
  const snapshot = workspaces.readSnapshot(sessionId, documentId)
  return { documentId: snapshot.id, path: snapshot.path, pageCount: snapshot.document.pageCount,
    ...(snapshot.baselineId ? { baselineId: snapshot.baselineId } : {}),
    sourceDigest: snapshot.contentContext?.sourceDigest ?? evidenceSha256(snapshot.bytes), sourceVersion: snapshot.sourceVersion,
    contentVersion: snapshot.contentVersion, revision: snapshot.revision,
    ...(snapshot.contentContext?.indexContentDigest ? { indexContentDigest: snapshot.contentContext.indexContentDigest } : {}),
    dirty: snapshot.dirty, conflict: snapshot.conflict,
    ...(snapshot.baselineMismatch ? { baselineMismatch: { operationsBaselineId: snapshot.baselineMismatch.operationsBaselineId,
      ...(snapshot.baselineMismatch.currentBaselineId ? { currentBaselineId: snapshot.baselineMismatch.currentBaselineId } : {}), choices: [...snapshot.baselineMismatch.choices] } } : {}),
    canUndo: snapshot.canUndo, canRedo: snapshot.canRedo,
    observedAt: new Date().toISOString(),
    limitations: ['Status reflects the working copy at observation time; external changes require a new file check.'] }
}
