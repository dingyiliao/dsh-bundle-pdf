import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'
import type { createPdfService } from '../pdfium/index.js'
import { createImageEvidenceRegistry, evidenceSha256,
  type EvidenceReferenceStore } from '../../../modules/evidence/index.js'
import type { WorkingCopyReadPort } from '../../../modules/working-copy/index.js'
import { binaryResult, type PdfDispatch } from './transport.js'

type RegionRenderer = Pick<ReturnType<typeof createPdfService>, 'renderOcrImage'>
type ImageStore = Pick<AttachmentStore, 'imageLimits' | 'saveImage' | 'readImage'>
type ImageRegistry = Pick<ReturnType<typeof createImageEvidenceRegistry>, 'mint'>

const identity = z.string().min(1).max(512)
const regionRequest = z.object({
  sessionId: identity,
  documentId: identity,
  page: z.number().int().min(1).max(100_000),
  rectPdf: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  maxEdge: z.number().int().min(256).max(1024).optional(),
  expectedRevision: z.number().int().nonnegative(),
  expectedContentVersion: identity,
}).strict()

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

/**
 * Prepare one session-authorized PDF region as durable image evidence.
 *
 * The renderer, not a Client screenshot, supplies both pixels and the actual
 * crop-box-clipped PDF rectangle. Image storage must retain those PNG bytes
 * exactly; a normalized or downscaled attachment is not the selected region.
 * The registry then fences the record to the current working-copy identity.
 */
export async function prepareRegionImageEvidence(
  renderer: RegionRenderer,
  attachments: ImageStore,
  registry: ImageRegistry,
  input: { sessionId: string; documentId: string; page: number;
    rectPdf: readonly [number, number, number, number]; maxEdge?: number },
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  if (!attachments.imageLimits.mediaTypes.includes('image/png')) {
    fail('pdf/image-type-unsupported', 'PNG images are not accepted by this attachment store')
  }
  const { snapshot, png, width, height, pdfRegion } = await renderer.renderOcrImage(
    input.sessionId, input.documentId, input.page, input.rectPdf, input.maxEdge ?? 1024, signal)
  signal.throwIfAborted()

  const image = await attachments.saveImage({ data: png, mediaType: 'image/png',
    name: `pdf-region-${input.page}.png` })
  signal.throwIfAborted()
  const digest = evidenceSha256(png)
  // DSH image attachments may normalize large or non-sRGB input. A region
  // reference must remain byte-for-byte the PDFium-rendered PNG instead.
  if (image.mediaType !== 'image/png' || image.bytes !== png.length
    || image.width !== width || image.height !== height || String(image.attachmentId) !== digest) {
    fail('pdf/image-normalized', 'The image store changed the rendered PDF region; retry with a smaller region')
  }
  const stored = await attachments.readImage(image, signal)
  signal.throwIfAborted()
  if (evidenceSha256(stored.data) !== digest) {
    fail('pdf/attachment-unavailable', 'The stored PDF region differs from its rendered PNG')
  }
  const evidence = await registry.mint(input.sessionId, {
    documentId: snapshot.id, sourcePath: snapshot.path, sourceDigest: evidenceSha256(snapshot.bytes),
    sourceVersion: snapshot.sourceVersion, contentVersion: snapshot.contentVersion,
    revision: snapshot.revision, page: input.page, source: 'direct-image',
    renderedImageSha256: digest,
    locator: { kind: 'pdf-region', rectPdf: pdfRegion },
    precision: 'approximate-geometry',
    limitations: ['The PDF crop is rendered without annotation overlays; the current model has not received this image until an image-capable route consumes the attachment.'],
    snapshot: { kind: 'attachment', attachmentId: String(image.attachmentId),
      mediaType: image.mediaType, bytes: image.bytes, width: image.width, height: image.height,
      storedImageSha256: digest },
  }, signal)
  return { evidence, image, png: stored.data }
}

/** Authenticated pdf.region dispatch; the transport resolves the session before calling this. */
export function createPdfRegionDispatch(ctx: Pick<Context, 'get'>, workspaces: WorkingCopyReadPort,
  renderer: RegionRenderer, references: EvidenceReferenceStore): PdfDispatch {
  const registry = createImageEvidenceRegistry(workspaces, references, async (_sessionId, snapshot, signal) => {
    const attachments = ctx.get('attachments')
    if (!attachments) return undefined
    try {
      const stored = await attachments.readImage({ attachmentId: AttachmentId(snapshot.attachmentId),
        mediaType: snapshot.mediaType, bytes: snapshot.bytes, width: snapshot.width,
        height: snapshot.height }, signal)
      signal.throwIfAborted()
      return { mediaType: stored.ref.mediaType, bytes: stored.ref.bytes,
        width: stored.ref.width, height: stored.ref.height,
        storedImageSha256: evidenceSha256(stored.data) }
    } catch (error) {
      if (signal.aborted) throw error
      return undefined
    }
  })
  return async (sessionId, raw, agent, signal) => {
    const request = regionRequest.parse(raw)
    if (request.sessionId !== sessionId || agent.session.id !== sessionId) {
      fail('pdf/session-mismatch', 'Session identity mismatch')
    }
    signal.throwIfAborted()
    const before = workspaces.readSnapshot(sessionId, request.documentId)
    if (before.revision !== request.expectedRevision
      || before.contentVersion !== request.expectedContentVersion) {
      fail('pdf/stale-reader', 'PDF changed before the selected region was rendered')
    }
    const attachments = ctx.get('attachments')
    if (!attachments) fail('pdf/attachment-unavailable', 'PDF region needs a mounted attachment store')
    const { evidence, image, png } = await prepareRegionImageEvidence(renderer, attachments,
      registry, request, signal)
    if (evidence.locator.kind !== 'pdf-region') fail('pdf/invalid-evidence', 'Region evidence has no PDF rectangle')
    return binaryResult({ refId: evidence.refId, documentId: evidence.documentId, page: evidence.page,
      rectPdf: evidence.locator.rectPdf, sourcePath: evidence.sourcePath,
      sourceDigest: evidence.sourceDigest, sourceVersion: evidence.sourceVersion,
      contentVersion: evidence.contentVersion, revision: evidence.revision,
      mediaType: image.mediaType, width: image.width, height: image.height }, png, 'image/png')
  }
}
