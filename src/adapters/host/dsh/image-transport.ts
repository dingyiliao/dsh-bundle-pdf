import { z } from 'zod'
import { AttachmentId, type AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { PdfDispatch } from './transport.js'
import { binaryResult } from './transport.js'
import { createImageEvidenceRegistry, evidenceSha256,
  type EvidenceReferenceStore, type FreshSourceRead, type PdfImageEvidence } from '../../../modules/evidence/index.js'
import { ImageUnderstandingError, MAX_IMAGE_BYTES, MAX_QUESTION_CHARACTERS,
  type HostImageUnderstandingService, type ImageUnderstandingImage } from '../../../modules/image-understanding/index.js'
import type { WorkingCopyReadPort } from '../../../modules/working-copy/index.js'

export const MAX_IMAGE_BASE64_CHARACTERS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
export const MAX_IMAGE_REQUEST_BYTES = MAX_IMAGE_BASE64_CHARACTERS + 16_384

const identity = z.string().min(1).max(512)
const referenceId = z.string().regex(/^pdfref_[0-9a-f-]{36}$/)
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('availability'), sessionId: identity }).strict(),
  z.object({ action: z.literal('prepare'), sessionId: identity,
    image: z.object({ mediaType: z.literal('image/png'), data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARACTERS),
      width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) }).strict(),
    question: z.string().min(1).max(MAX_QUESTION_CHARACTERS) }).strict(),
  z.object({ action: z.literal('prepare-reference'), sessionId: identity,
    documentId: identity, refId: referenceId,
    question: z.string().min(1).max(MAX_QUESTION_CHARACTERS) }).strict(),
])

/** A Host-owned capability, never constructed from an RPC payload. The implementation
 * must reauthorize the requested session/document and freshly check source + attachment.
 * It may return a rebound refId when the same source bytes survived a reopen.
 */
export interface PdfImageEvidenceResolver {
  resolve(sessionId: string, documentId: string, refId: string, signal: AbortSignal): Promise<{
    image: ImageUnderstandingImage
    evidence: Extract<PdfImageEvidence, { source: 'direct-image' }>
  }>
}

type ImageReader = Pick<AttachmentStore, 'readImage'>

/**
 * Resolve an opaque, session-scoped ref against the caller's working copy and
 * the actual source file. The attachment's bytes, not Client-supplied pixels,
 * are passed to image understanding and returned to the calling Client.
 */
export function createPdfImageEvidenceResolver(workspaces: WorkingCopyReadPort,
  references: EvidenceReferenceStore, attachments: ImageReader,
  readSource: FreshSourceRead): PdfImageEvidenceResolver {
  return { async resolve(sessionId, documentId, refId, signal) {
    type DirectEvidence = Extract<PdfImageEvidence, { source: 'direct-image' }>
    let attested: { attachmentId: string; data: Uint8Array } | undefined
    const registry = createImageEvidenceRegistry(workspaces, references,
      async (_owner, snapshot, verifySignal) => {
        try {
          const stored = await attachments.readImage({ attachmentId: AttachmentId(snapshot.attachmentId),
            mediaType: snapshot.mediaType, bytes: snapshot.bytes,
            width: snapshot.width, height: snapshot.height }, verifySignal)
          verifySignal.throwIfAborted()
          attested = { attachmentId: snapshot.attachmentId, data: stored.data }
          return { mediaType: stored.ref.mediaType, bytes: stored.ref.bytes,
            width: stored.ref.width, height: stored.ref.height,
            storedImageSha256: evidenceSha256(stored.data) }
        } catch (error) {
          verifySignal.throwIfAborted()
          if (error instanceof ImageUnderstandingError) throw error
          return undefined
        }
      })
    const { evidence } = await registry.revalidate(sessionId, documentId, refId, signal, readSource)
    if (evidence.source !== 'direct-image' || evidence.snapshot.mediaType !== 'image/png') {
      throw new ImageUnderstandingError('pdf/reference-unavailable', 'Reference is not a PNG image.')
    }
    const direct: DirectEvidence = evidence
    const image = { mediaType: 'image/png' as const, data: Uint8Array.from(attested!.data),
      width: direct.snapshot.width, height: direct.snapshot.height }
    referencedImage({ image, evidence: direct }, documentId, direct.refId)
    return { image, evidence: direct }
  } }
}

function referencedImage(source: Awaited<ReturnType<PdfImageEvidenceResolver['resolve']>>,
  documentId: string, refId: string): ImageUnderstandingImage {
  const { image, evidence } = source
  const snapshot = evidence.snapshot
  const digest = evidenceSha256(image.data)
  if (evidence.documentId !== documentId || evidence.refId !== refId
    || evidence.source !== 'direct-image' || snapshot.kind !== 'attachment'
    || image.mediaType !== 'image/png' || snapshot.mediaType !== image.mediaType
    || image.width !== snapshot.width || image.height !== snapshot.height
    || image.data.byteLength !== snapshot.bytes
    || snapshot.storedImageSha256 !== undefined && digest !== snapshot.storedImageSha256
    || digest !== evidence.renderedImageSha256) {
    throw new ImageUnderstandingError('pdf/reference-unavailable', 'Referenced PDF image does not match its verified attachment.')
  }
  return image
}

/** Connection authenticates the RPC before this dispatch verifies its Session identity. */
export function createImageUnderstandingDispatch(service: HostImageUnderstandingService,
  references?: PdfImageEvidenceResolver): PdfDispatch {
  return async (sessionId, input, agent, signal) => {
    const parsed = request.safeParse(input)
    if (!parsed.success) throw new ImageUnderstandingError('pdf/image-invalid-request', 'Invalid image request.')
    const args = parsed.data
    if (args.sessionId !== sessionId || agent.session.id !== sessionId) {
      throw new ImageUnderstandingError('pdf/session-mismatch', 'Session identity mismatch.')
    }
    signal.throwIfAborted()
    if (args.action === 'availability') return service.availability(sessionId, signal)
    if (args.action === 'prepare-reference') {
      if (!references) throw new ImageUnderstandingError('pdf/reference-unavailable', 'PDF image references are not mounted.')
      const source = await references.resolve(sessionId, args.documentId, args.refId, signal)
      signal.throwIfAborted()
      const image = referencedImage(source, args.documentId, source.evidence.refId)
      const prepared = await service.prepare({ sessionId, image, question: args.question, signal })
      signal.throwIfAborted()
      // Preparation may call OCR or a remote model. Recheck the source and
      // attachment after that asynchronous work before delivering its result.
      const latest = await references.resolve(sessionId, args.documentId, source.evidence.refId, signal)
      signal.throwIfAborted()
      referencedImage(latest, args.documentId, latest.evidence.refId)
      if (latest.evidence.refId !== source.evidence.refId
        || evidenceSha256(latest.image.data) !== evidenceSha256(image.data)) {
        throw new ImageUnderstandingError('pdf/stale-reader', 'PDF image changed while it was being prepared.')
      }
      const evidence = { refId: source.evidence.refId, documentId: source.evidence.documentId,
        page: source.evidence.page, locator: source.evidence.locator,
        sourceDigest: source.evidence.sourceDigest, sourceVersion: source.evidence.sourceVersion,
        contentVersion: source.evidence.contentVersion, revision: source.evidence.revision,
        renderedImageSha256: source.evidence.renderedImageSha256 }
      if (prepared.kind === 'direct-image') {
        return binaryResult({ ...prepared, requestedRefId: args.refId, evidence }, image.data, image.mediaType)
      }
      return { ...prepared, requestedRefId: args.refId, evidence }
    }
    const { data, width, height, mediaType } = args.image
    if (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new ImageUnderstandingError('pdf/image-invalid-request', 'Image data must be canonical Base64.')
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.byteLength > MAX_IMAGE_BYTES || bytes.toString('base64') !== data) {
      throw new ImageUnderstandingError('pdf/image-invalid-request', 'Image data exceeds the limit or is not canonical Base64.')
    }
    return service.prepare({ sessionId, image: { mediaType, data: bytes, width, height },
      question: args.question, signal })
  }
}
