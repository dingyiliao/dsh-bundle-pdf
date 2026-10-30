import type { OcrOutput } from '../../ocr/types.js'
import type { StagedImageHooks } from '../ocr/index.js'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../working-copy/index.js'
import { evidenceSha256, imageEvidenceSource, type ImageEvidenceSource } from './provenance.js'

export interface AgentPageImagePort {
  renderPage(sessionId: string, documentId: string, page: number, maxEdge: number,
    signal: AbortSignal): Promise<{ snapshot: HostWorkspaceSnapshot; png: Uint8Array; width: number; height: number }>
}

/** Capability reporting uses the same selected execution service as image tools. */
export interface AgentImageUnderstandingPort {
  availability(sessionId: string, signal: AbortSignal): Promise<
    { status: 'available' } | { status: 'unavailable'; reason: string }>
}

export interface AgentOcrPort {
  selectedDescriptor(): { languages?: readonly string[] } | undefined
  availability(sessionId: string, signal: AbortSignal): Promise<{ status: string; reason?: string }>
  recognize(input: { sessionId: string; image: Uint8Array; mediaType: 'image/png'; width: number; height: number;
    languages: readonly string[]; signal: AbortSignal }): Promise<OcrOutput & {
      source: { backendId: string; backendVersion: string }
    }>
  stageImage(input: { sessionId: string; image: Uint8Array; mediaType: 'image/png'; width: number; height: number;
    languages: readonly string[] }, hooks?: StagedImageHooks): Promise<string>
}

export interface AgentImageAttachmentPort {
  imageLimits: { mediaTypes: readonly string[] }
  saveImage(input: { data: Uint8Array; mediaType: 'image/png'; name: string }): Promise<{
    attachmentId: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    bytes: number; width: number; height: number; name?: string;
    originalDimensions?: { width: number; height: number }
  }>
}

export interface AgentImageServices {
  ocr(): AgentOcrPort | undefined
  attachments(): AgentImageAttachmentPort | undefined
  requireVisualModel(signal: AbortSignal): Promise<void>
  imageHooks?(snapshot: HostWorkspaceSnapshot, png: Uint8Array): StagedImageHooks
}

export interface RenderedPageValue {
  documentId: string; path: string; page: number; pageCount: number; revision: number;
  sourceVersion: string; contentVersion: string
  evidenceSource: ImageEvidenceSource
  image: { attachmentId: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    bytes: number; width: number; height: number; name?: string;
    originalDimensions?: { width: number; height: number } }
  imageHandle?: string
  imageHandleWarning?: string
  deliverImage: boolean
}

export interface DerivedPageValue {
  kind: 'derived-text'; documentId: string; path: string; page: number; pageCount: number; revision: number
  sourceVersion: string; contentVersion: string; text: string; totalChars: number; truncated: boolean
  evidenceSource: ImageEvidenceSource
  source: { backendId: string; backendVersion?: string; mode: 'ocr-text' | 'image-description'; model?: string }
  limitations?: string
}

function recognitionLanguages(ocr: AgentOcrPort): string[] {
  const supported = ocr.selectedDescriptor()?.languages
  return supported?.length ? [...supported.slice(0, 4)] : ['auto']
}

function ensurePngAttachments(attachments: AgentImageAttachmentPort | undefined): AgentImageAttachmentPort {
  if (attachments === undefined) {
    throw Object.assign(new Error('PDF screenshot needs a mounted attachment store'), { code: 'pdf/attachment-unavailable' })
  }
  if (!attachments.imageLimits.mediaTypes.includes('image/png')) {
    throw Object.assign(new Error('PNG images are not accepted by this attachment store'), { code: 'pdf/image-type-unsupported' })
  }
  return attachments
}

function ensureSameSource(workspaces: WorkingCopyReadPort, sessionId: string, documentId: string,
  snapshot: HostWorkspaceSnapshot, message: string): void {
  const latest = workspaces.readSnapshot(sessionId, documentId)
  if (latest.contentVersion !== snapshot.contentVersion || latest.revision !== snapshot.revision
    || evidenceSha256(latest.bytes) !== evidenceSha256(snapshot.bytes)) {
    throw Object.assign(new Error(message), { code: 'pdf/stale-reader' })
  }
}

/** Produce one immutable page image; generation is independent of the current model's modalities. */
export async function renderPageForAgent(workspaces: WorkingCopyReadPort, pages: AgentPageImagePort,
  services: AgentImageServices, sessionId: string, documentId: string, page: number,
  maxEdge: number | undefined, signal: AbortSignal): Promise<RenderedPageValue> {
  const attachments = ensurePngAttachments(services.attachments())
  let deliverImage = true
  try { await services.requireVisualModel(signal) }
  catch (error) {
    signal.throwIfAborted()
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code !== 'pdf/image-input-unsupported' && code !== 'pdf/image-route-unknown') throw error
    deliverImage = false
  }
  const { snapshot, png, width, height } = await pages.renderPage(sessionId, documentId, page, maxEdge ?? 1024, signal)
  ensureSameSource(workspaces, sessionId, documentId, snapshot, 'PDF changed during page rendering; retry')
  const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: `pdf-page-${page}.png` })
  if (ref.width !== width || ref.height !== height || !Number.isInteger(ref.bytes) || ref.bytes <= 0
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)) {
    throw Object.assign(new Error('Attachment storage changed the page image dimensions or metadata'),
      { code: 'pdf/image-normalized' })
  }
  const storedImageSha256 = /^sha256:[a-f0-9]{64}$/.test(ref.attachmentId) ? ref.attachmentId : undefined
  signal.throwIfAborted()
  const ocr = services.ocr()
  let imageHandle: string | undefined
  let imageHandleWarning: string | undefined
  if (ocr) {
    try {
      imageHandle = await ocr.stageImage({ sessionId, image: png, mediaType: 'image/png',
        width, height, languages: recognitionLanguages(ocr) }, services.imageHooks?.(snapshot, png))
    } catch (error) {
      signal.throwIfAborted()
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      if (code === 'cancelled' || code.startsWith('pdf/source-') || code.startsWith('pdf/stale-')
        || code.startsWith('pdf/session-') || error instanceof Error && error.name === 'AbortError') throw error
      imageHandleWarning = 'Image rendering succeeded, but no consumable image handle could be staged. OCR and auxiliary image tools cannot use this result.'
    }
  } else {
    imageHandleWarning = 'The optional image-handle service is not installed. OCR and auxiliary image tools cannot consume this result.'
  }
  signal.throwIfAborted()
  ensureSameSource(workspaces, sessionId, documentId, snapshot, 'PDF changed before image delivery; retry')
  const evidenceSource = imageEvidenceSource({ kind: 'direct-image', pdfBytes: snapshot.bytes, imageBytes: png,
    storedImageSha256 })
  if (!deliverImage) evidenceSource.limitations = [
    'This is a stored page image. The current text-only or unknown-route model has not received its pixels; pass imageHandle to an available OCR or auxiliary image engine.',
    ...evidenceSource.limitations.filter(value => !value.startsWith('The current vision-capable model receives')),
  ]
  return { documentId: snapshot.id, path: snapshot.path, page,
    pageCount: snapshot.document.pageCount, revision: snapshot.revision,
    sourceVersion: snapshot.sourceVersion, contentVersion: snapshot.contentVersion, evidenceSource,
    deliverImage, ...(imageHandle ? { imageHandle } : {}), ...(imageHandleWarning ? { imageHandleWarning } : {}),
    image: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes,
      width: ref.width, height: ref.height,
      ...ref.name === undefined ? {} : { name: ref.name },
      ...ref.originalDimensions === undefined ? {} : { originalDimensions: ref.originalDimensions } } }
}
