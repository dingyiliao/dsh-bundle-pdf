import type { WorkspaceSnapshot } from '../../shared/contracts.js'

/** A draft must keep the exact PDF baseline and working-copy revision it was selected from. */
export interface ExplanationSourceIdentity {
  sessionId: string
  documentId: string
  path: string
  /** DSH filesystem version, distinct from the source bytes digest. */
  sourceVersion: string
  /** SHA-256 of the PDF bytes backing the native Reader, even with unsaved annotation operations. */
  baselineDigest: string
  contentVersion: string
  revision: number
}

export function explanationSourceIdentity(
  sessionId: string, snapshot: WorkspaceSnapshot | null,
): ExplanationSourceIdentity | null {
  if (!snapshot || snapshot.conflict || !sessionId.trim() || !snapshot.id || !snapshot.path
    || !snapshot.sourceVersion || !snapshot.contentVersion || !Number.isSafeInteger(snapshot.revision)
    || !/^sha256:[a-f0-9]{64}$/.test(snapshot.reader?.bytesHash ?? '')) return null
  return {
    sessionId, documentId: snapshot.id, path: snapshot.path, sourceVersion: snapshot.sourceVersion,
    baselineDigest: snapshot.reader.bytesHash, contentVersion: snapshot.contentVersion,
    revision: snapshot.revision,
  }
}

export function sameExplanationSource(
  expected: ExplanationSourceIdentity, sessionId: string, snapshot: WorkspaceSnapshot | null,
): boolean {
  const current = explanationSourceIdentity(sessionId, snapshot)
  return !!current && current.sessionId === expected.sessionId && current.documentId === expected.documentId
    && current.path === expected.path && current.sourceVersion === expected.sourceVersion
    && current.baselineDigest === expected.baselineDigest && current.contentVersion === expected.contentVersion
    && current.revision === expected.revision
}
