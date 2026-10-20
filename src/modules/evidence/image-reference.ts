import { randomUUID } from 'node:crypto'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../working-copy/index.js'
import { evidenceSha256 } from './provenance.js'
import { assertFreshSource, type FreshSourceRead } from './source-freshness.js'
import { imageEvidenceSchema, isSavedImageReference,
  type EvidenceReferenceStore, type PdfImageEvidence } from './reference-store.js'

export type ImageEvidenceCapture = Omit<PdfImageEvidence, 'refId'>
export type DirectImageEvidence = Extract<PdfImageEvidence, { source: 'direct-image' }>

/** Attachment-store lookup must reauthorize the caller and attest to this exact attachment. */
export type ImageAttachmentVerifier = (sessionId: string, attachment: DirectImageEvidence['snapshot'],
  signal: AbortSignal) => Promise<{
  mediaType: DirectImageEvidence['snapshot']['mediaType']
  bytes: number
  width: number
  height: number
  storedImageSha256?: string
} | undefined>

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

function identity(snapshot: HostWorkspaceSnapshot) {
  return { documentId: snapshot.id, sourcePath: snapshot.path,
    sourceDigest: evidenceSha256(snapshot.bytes), sourceVersion: snapshot.sourceVersion,
    contentVersion: snapshot.contentVersion, revision: snapshot.revision }
}

function sameIdentity(left: ReturnType<typeof identity>, right: ReturnType<typeof identity>): boolean {
  return left.documentId === right.documentId && left.sourcePath === right.sourcePath
    && left.sourceDigest === right.sourceDigest && left.sourceVersion === right.sourceVersion
    && left.contentVersion === right.contentVersion && left.revision === right.revision
}

function validRegion(evidence: PdfImageEvidence): void {
  if (evidence.locator.kind !== 'pdf-region') return
  const [left, bottom, right, top] = evidence.locator.rectPdf
  if (right <= left || top <= bottom) fail('pdf/invalid-region', 'PDF evidence region must have positive area')
}

/** No PDF pixels are kept here: only the attachment handle or bounded derived text. */
export function createImageEvidenceRegistry(workspaces: WorkingCopyReadPort, references: EvidenceReferenceStore,
  verifyAttachment?: ImageAttachmentVerifier) {
  async function attestAttachment(sessionId: string, snapshot: DirectImageEvidence['snapshot'],
    signal: AbortSignal): Promise<void> {
    if (!verifyAttachment) fail('pdf/attachment-unavailable', 'Image attachment cannot be verified')
    const actual = await verifyAttachment(sessionId, snapshot, signal)
    signal.throwIfAborted()
    if (!actual || actual.mediaType !== snapshot.mediaType || actual.bytes !== snapshot.bytes
      || actual.width !== snapshot.width || actual.height !== snapshot.height
      || snapshot.storedImageSha256 !== undefined
        && actual.storedImageSha256 !== snapshot.storedImageSha256) {
      fail('pdf/attachment-unavailable', 'Referenced image attachment is missing or has changed')
    }
  }

  async function mint(sessionId: string, capture: ImageEvidenceCapture,
    signal: AbortSignal): Promise<PdfImageEvidence> {
    signal.throwIfAborted()
    const before = workspaces.readSnapshot(sessionId, capture.documentId)
    const evidence = imageEvidenceSchema.parse({ ...capture, refId: `pdfref_${randomUUID()}` })
    validRegion(evidence)
    if (!sameIdentity(identity(before), evidence) || evidence.page > before.document.pageCount) {
      fail('pdf/stale-reader', 'PDF changed before image evidence could be recorded')
    }
    if (evidence.snapshot.kind === 'derived-text'
      && evidenceSha256(evidence.snapshot.text) !== evidence.snapshot.sha256) {
      fail('pdf/invalid-evidence', 'Derived text does not match its evidence digest')
    }
    if (evidence.snapshot.kind === 'attachment') await attestAttachment(sessionId, evidence.snapshot, signal)
    await references.put(evidence.refId, { sessionId, evidence, createdAt: Date.now() })
    try {
      signal.throwIfAborted()
      if (!sameIdentity(identity(before), identity(workspaces.readSnapshot(sessionId, capture.documentId)))) {
        fail('pdf/stale-reader', 'PDF changed while image evidence was recorded')
      }
    } catch (error) {
      await references.delete(evidence.refId)
      throw error
    }
    return evidence
  }

  async function revalidate(sessionId: string, documentId: string, refId: string,
    signal: AbortSignal, readSource: FreshSourceRead): Promise<{ evidence: PdfImageEvidence; revalidated: boolean }> {
    signal.throwIfAborted()
    const saved = references.get(refId)
    if (!saved || !isSavedImageReference(saved) || saved.sessionId !== sessionId) {
      fail('pdf/reference-unavailable', 'Image evidence is unavailable in this session')
    }
    // A reference is not permission. Resolve the requested working copy through
    // the caller's session before comparing the persisted source identity.
    const current = workspaces.readSnapshot(sessionId, documentId)
    const before = identity(current)
    const evidence = saved.evidence
    if (before.sourcePath !== evidence.sourcePath) {
      fail('pdf/reference-unavailable', 'Image evidence belongs to another PDF source')
    }
    await assertFreshSource(sessionId, current, readSource, signal)
    if (evidence.page > current.document.pageCount || before.sourceDigest !== evidence.sourceDigest) {
      fail('pdf/stale-reader', 'PDF image source bytes changed; render this page again')
    }
    validRegion(evidence)
    if (evidence.snapshot.kind === 'derived-text') {
      if (evidenceSha256(evidence.snapshot.text) !== evidence.snapshot.sha256) {
        fail('pdf/stale-reader', 'Saved image-derived text changed')
      }
    } else {
      await attestAttachment(sessionId, evidence.snapshot, signal)
    }
    signal.throwIfAborted()
    const after = workspaces.readSnapshot(sessionId, documentId)
    if (!sameIdentity(before, identity(after))) {
      fail('pdf/stale-reader', 'PDF changed while image evidence was being checked')
    }
    await assertFreshSource(sessionId, after, readSource, signal)
    if (sameIdentity(before, evidence)) return { evidence, revalidated: false }
    // The source PDF is byte-identical across a reopened document or a draft-only
    // revision; rebind the immutable snapshot without recreating its pixels/text.
    const rebound = await mint(sessionId, { ...evidence, ...before }, signal)
    return { evidence: rebound, revalidated: true }
  }

  return { mint, revalidate }
}
