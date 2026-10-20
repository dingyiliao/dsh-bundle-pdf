import type { OcrOutput } from '../../ocr/types.js'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../working-copy/index.js'
import { evidenceSha256, imageEvidenceSource, type ImageEvidenceSource } from './provenance.js'
import { windowPageText } from './text-window.js'

export interface AgentPageImagePort {
  renderPage(sessionId: string, documentId: string, page: number, maxEdge: number,
    signal: AbortSignal): Promise<{ snapshot: HostWorkspaceSnapshot; png: Uint8Array; width: number; height: number }>
}

export interface AgentImageUnderstandingPort {
  availability(sessionId: string, signal: AbortSignal): Promise<
    { status: 'available'; kind: 'direct-image' | 'derived-text' } | { status: 'unavailable'; reason: string }>
  prepare(input: { sessionId: string; image: { data: Uint8Array; mediaType: 'image/png'; width: number; height: number };
    question: string; signal: AbortSignal }): Promise<
      { kind: 'direct-image' } | { kind: 'derived-text'; text: string;
        provenance: { backendId: string; mode: 'ocr-text' | 'image-description'; model?: string }; limitations?: string }>
}

export interface AgentOcrPort {
  selectedDescriptor(): { languages?: readonly string[] } | undefined
  availability(sessionId: string, signal: AbortSignal): Promise<{ status: string; reason?: string }>
  recognize(input: { sessionId: string; image: Uint8Array; mediaType: 'image/png'; width: number; height: number;
    languages: readonly string[]; signal: AbortSignal }): Promise<OcrOutput & {
      source: { backendId: string; backendVersion: string }
    }>
  stageImage(input: { sessionId: string; image: Uint8Array; mediaType: 'image/png'; width: number; height: number;
    languages: readonly string[] }): Promise<string>
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
  imageUnderstanding(): AgentImageUnderstandingPort | undefined
  ocr(): AgentOcrPort | undefined
  attachments(): AgentImageAttachmentPort | undefined
  requireVisualModel(signal: AbortSignal): Promise<void>
}

export interface RenderedPageValue {
  documentId: string; path: string; page: number; pageCount: number; revision: number;
  sourceVersion: string; contentVersion: string
  evidenceSource: ImageEvidenceSource
  image: { attachmentId: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    bytes: number; width: number; height: number; name?: string;
    originalDimensions?: { width: number; height: number } }
  imageHandle?: string
}

export interface DerivedPageValue {
  kind: 'derived-text'; documentId: string; path: string; page: number; pageCount: number; revision: number
  sourceVersion: string; contentVersion: string; text: string; totalChars: number; truncated: boolean
  evidenceSource: ImageEvidenceSource
  source: { backendId: string; mode: 'ocr-text' | 'image-description'; model?: string }
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

/** Render only after model/backend and attachment preflight; never imply a text model saw a page image. */
export async function renderPageForAgent(workspaces: WorkingCopyReadPort, pages: AgentPageImagePort,
  services: AgentImageServices, sessionId: string, documentId: string, page: number,
  maxEdge: number | undefined, mode: 'current-model' | 'configured-backend' | undefined,
  question: string | undefined, signal: AbortSignal) {
  const imageUnderstanding = mode === 'configured-backend' ? services.imageUnderstanding() : undefined
  if (mode === 'configured-backend' && imageUnderstanding === undefined) {
    throw Object.assign(new Error('The configured image-understanding plugin is not installed'),
      { code: 'pdf/image-backend-unavailable' })
  }
  const availability = imageUnderstanding === undefined ? undefined
    : await imageUnderstanding.availability(sessionId, signal)
  if (availability?.status === 'unavailable') {
    throw Object.assign(new Error(availability.reason), { code: 'pdf/image-backend-unavailable' })
  }
  if (availability === undefined || availability.kind === 'direct-image') await services.requireVisualModel(signal)
  let attachments = availability?.kind === 'derived-text' ? undefined : ensurePngAttachments(services.attachments())
  const { snapshot, png, width, height } = await pages.renderPage(sessionId, documentId, page, maxEdge ?? 1024, signal)
  ensureSameSource(workspaces, sessionId, documentId, snapshot, 'PDF changed during page rendering; retry')
  if (imageUnderstanding !== undefined) {
    const prepared = await imageUnderstanding.prepare({ sessionId,
      image: { data: png, mediaType: 'image/png', width, height },
      question: question ?? 'Describe this PDF page accurately, including any relevant figures or tables.', signal })
    signal.throwIfAborted()
    ensureSameSource(workspaces, sessionId, documentId, snapshot, 'PDF changed during image understanding; retry')
    if (prepared.kind === 'derived-text') {
      // Auxiliary backends are not trusted to enforce a model-output budget.
      // Bound both UTF-16 units and UTF-8 bytes before the tool renderer and
      // session-log presentation metadata ever see the derived passage.
      const window = windowPageText(prepared.text, 0, 8000)
      const backendLimitations = prepared.limitations === undefined ? undefined
        : windowPageText(prepared.limitations, 0, 512).text
      const limitations = [backendLimitations,
        ...(window.truncated ? ['Image-derived text was truncated; rerunning may produce a different answer, not a continuation.'] : [])]
        .filter((value): value is string => value !== undefined && value.length > 0)
      return { kind: 'derived-text' as const, documentId: snapshot.id, path: snapshot.path, page,
        pageCount: snapshot.document.pageCount, revision: snapshot.revision,
        sourceVersion: snapshot.sourceVersion, contentVersion: snapshot.contentVersion,
        source: prepared.provenance, ...(limitations.length ? { limitations: limitations.join(' ') } : {}),
        evidenceSource: imageEvidenceSource({ kind: prepared.provenance.mode === 'ocr-text' ? 'ocr-text' : 'auxiliary-vision',
          pdfBytes: snapshot.bytes, imageBytes: png, text: window.text }),
        text: window.text, totalChars: window.totalChars, truncated: window.truncated }
    }
    await services.requireVisualModel(signal)
  }
  attachments = ensurePngAttachments(attachments ?? services.attachments())
  const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: `pdf-page-${page}.png` })
  const storedImageSha256 = /^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)
    ? ref.attachmentId : undefined
  signal.throwIfAborted()
  let imageHandle: string | undefined
  const ocr = services.ocr()
  if (ocr?.selectedDescriptor()) {
    try { imageHandle = await ocr.stageImage({ sessionId, image: png, mediaType: 'image/png',
      width, height, languages: recognitionLanguages(ocr) }) }
    catch { signal.throwIfAborted() }
  }
  signal.throwIfAborted()
  ensureSameSource(workspaces, sessionId, documentId, snapshot, 'PDF changed before image delivery; retry')
  return { documentId: snapshot.id, path: snapshot.path, page,
    pageCount: snapshot.document.pageCount, revision: snapshot.revision,
    sourceVersion: snapshot.sourceVersion, contentVersion: snapshot.contentVersion,
    evidenceSource: imageEvidenceSource({ kind: 'direct-image', pdfBytes: snapshot.bytes, imageBytes: png,
      storedImageSha256 }),
    ...(imageHandle ? { imageHandle } : {}),
    image: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes,
      width: ref.width, height: ref.height,
      ...ref.name === undefined ? {} : { name: ref.name },
      ...ref.originalDimensions === undefined ? {} : { originalDimensions: ref.originalDimensions } } }
}

/** OCR is an independent, text-only read; geometry remains in rendered-image pixel space. */
export async function ocrPageForAgent(workspaces: WorkingCopyReadPort, pages: AgentPageImagePort,
  ocr: AgentOcrPort | undefined, sessionId: string, documentId: string, page: number,
  maxEdge: number | undefined, maxChars: number | undefined, signal: AbortSignal) {
  if (!ocr) throw Object.assign(new Error('PDF OCR requires the optional OCR plugin'), { code: 'pdf/ocr-unavailable' })
  const availability = await ocr.availability(sessionId, signal)
  if (availability.status !== 'available') {
    throw Object.assign(new Error(availability.reason ?? `Selected OCR backend is ${availability.status}`),
      { code: 'pdf/ocr-unavailable' })
  }
  const { snapshot, png, width, height } = await pages.renderPage(sessionId, documentId, page, maxEdge ?? 1024, signal)
  const result = await ocr.recognize({ sessionId, image: png, mediaType: 'image/png', width, height,
    languages: recognitionLanguages(ocr), signal })
  signal.throwIfAborted()
  ensureSameSource(workspaces, sessionId, documentId, snapshot, 'PDF changed during OCR; retry')
  const { nextOffset: _nextOffset, ...window } = windowPageText(result.text, 0, maxChars)
  const parts = [...result.blocks, ...result.lines, ...result.words]
  const positioned = parts.filter(part => part.box !== null).length
  const geometry = positioned === 0 ? 'none' : positioned === parts.length ? 'complete' : 'partial'
  return { status: result.text.trim() ? result.status : 'no_text', documentId: snapshot.id,
    path: snapshot.path, page, pageCount: snapshot.document.pageCount,
    revision: snapshot.revision, sourceVersion: snapshot.sourceVersion,
    contentVersion: snapshot.contentVersion,
    source: { ...result.source, kind: 'ocr' },
    evidenceSource: imageEvidenceSource({ kind: 'ocr-text', pdfBytes: snapshot.bytes, imageBytes: png,
      text: window.text }),
    image: { width, height }, geometry: { status: geometry,
      coordinateSpace: 'rendered-image-pixels', positionedParts: positioned, totalParts: parts.length,
      pdfCoordinatesAvailable: false },
    lines: result.lines.slice(0, 50).map(line => ({ id: line.id,
      text: windowPageText(line.text, 0, 300).text,
      box: line.box ? { x0: line.box.x0, y0: line.box.y0, x1: line.box.x1, y1: line.box.y1 } : null })),
    totalLines: result.lines.length,
    warnings: result.warnings.slice(0, 20).map(warning => windowPageText(warning, 0, 500).text),
    ...window }
}
