import { evidenceSha256, type ImageEvidenceSource,
  type PdfTextEvidence, type RenderedPageValue } from '../../../modules/evidence/index.js'

const MAX_PATH_CHARS = 512
const MAX_REPLAY_TEXT_CHARS = 8_000

/** Session-log presentation data: an exact bounded copy, never a pointer to the process-local ref cache. */
function snapshot(evidence: PdfTextEvidence, maxChars: number) {
  const text = evidence.snapshot.text.slice(0, maxChars)
  return { refId: evidence.refId, documentId: evidence.documentId,
    sourcePath: evidence.sourcePath.slice(0, MAX_PATH_CHARS),
    sourcePathDigest: evidenceSha256(evidence.sourcePath),
    sourceDigest: evidence.sourceDigest, sourceVersion: evidence.sourceVersion,
    ...(evidence.pageTextDigest ? { pageTextDigest: evidence.pageTextDigest } : {}),
    contentVersion: evidence.contentVersion, revision: evidence.revision, page: evidence.page,
    source: evidence.source, precision: evidence.precision,
    ...(evidence.extraction ? { extraction: evidence.extraction } : {}),
    locator: { kind: evidence.locator.kind, startUtf16: evidence.locator.startUtf16,
      endUtf16: evidence.locator.endUtf16 },
    snapshot: { text, sha256: evidenceSha256(text), originalSha256: evidence.snapshot.sha256,
      truncated: text.length < evidence.snapshot.text.length },
    limitations: [...evidence.limitations.slice(0, 3),
      'Replay metadata does not preserve geometric rectangles; navigation requires fresh authorization and validation.'] }
}

export function readPagePresentationMeta(value: {
  documentId: string; path: string; page: number; sourceDigest: string; sourceVersion: string;
  pageTextDigest: string;
  contentVersion: string; revision: number; text: string; offset: number; nextOffset: number | null;
  totalChars: number; status: string; extraction?: 'local-ocr'; limitations?: string[]
}) {
  const text = value.text.slice(0, MAX_REPLAY_TEXT_CHARS)
  return { kind: 'pdf-evidence-snapshot', version: 1, tool: 'pdf_page_read',
    documentId: value.documentId, sourcePath: value.path.slice(0, MAX_PATH_CHARS),
    sourcePathDigest: evidenceSha256(value.path),
    sourceDigest: value.sourceDigest, sourceVersion: value.sourceVersion,
    pageTextDigest: value.pageTextDigest,
    ...(value.extraction ? { extraction: value.extraction } : {}),
    contentVersion: value.contentVersion, revision: value.revision, page: value.page,
    status: value.status, locator: { kind: 'text-window', startUtf16: value.offset,
      endUtf16: value.offset + text.length },
    snapshot: { text, sha256: evidenceSha256(text), truncated: text.length < value.text.length },
    nextOffset: value.nextOffset, totalChars: value.totalChars,
    limitations: [...(value.limitations ?? []).slice(0, 3), 'This is the text sent to the model at tool completion; it is not a live or authorized PDF position.'] }
}

/** New atomic search/read tools share bounded, per-page evidence presentation. */
export function keywordSearchPresentationMeta(value: {
  documentId: string; matches: readonly { evidence?: PdfTextEvidence }[]; nextCursor?: string | null; hasMore?: boolean
}) {
  return { kind: 'pdf-evidence-snapshot', version: 1, tool: 'pdf_keyword_search',
    documentId: value.documentId, status: value.hasMore || value.nextCursor ? 'partial' : 'ok',
    matches: value.matches.flatMap(item => item.evidence ? [snapshot(item.evidence, 512)] : []).slice(0, 20) }
}

export function evidenceReadPresentationMeta(value: {
  documentId: string; status: string; pages: readonly PdfTextEvidence[]
}) {
  let remaining = MAX_REPLAY_TEXT_CHARS
  return { kind: 'pdf-evidence-snapshot', version: 1, tool: 'pdf_evidence_read',
    documentId: value.documentId, status: value.status,
    chunks: value.pages.slice(0, 10).map(evidence => {
      const projected = snapshot(evidence, remaining)
      remaining -= projected.snapshot.text.length
      return projected
    }), candidates: [] }
}

function imageSource(source: ImageEvidenceSource) {
  return { kind: source.kind, sourceDigest: source.sourceDigest,
    renderedImageSha256: source.renderedImageSha256,
    ...(source.storedImageSha256 ? { storedImageSha256: source.storedImageSha256 } : {}),
    ...(source.snapshotSha256 ? { snapshotSha256: source.snapshotSha256 } : {}),
    precision: source.precision, limitations: source.limitations.slice(0, 3) }
}

/** Persist only the protected attachment reference, never PNG bytes or inferred text. */
export function renderPagePresentationMeta(value: RenderedPageValue & { refId?: string }) {
  const base = { kind: 'pdf-evidence-snapshot', version: 1, tool: 'pdf_page_render',
    ...(value.refId ? { refId: value.refId } : {}),
    documentId: value.documentId, sourcePath: value.path.slice(0, MAX_PATH_CHARS),
    sourcePathDigest: evidenceSha256(value.path),
    sourceVersion: value.sourceVersion, contentVersion: value.contentVersion,
    revision: value.revision, page: value.page,
    pageCount: value.pageCount, evidenceSource: imageSource(value.evidenceSource) }
  return { ...base, status: 'direct-image', attachment: {
    attachmentId: value.image.attachmentId, mediaType: value.image.mediaType,
    width: value.image.width, height: value.image.height, bytes: value.image.bytes } }
}

type ImageContextMetaBase = {
  refId: string; documentId: string; sourcePath: string;
  sourcePathDigest: string;
  sourceDigest: string; sourceVersion: string; contentVersion: string; revision: number; page: number;
  source: string; renderedImageSha256: string; precision: string;
  locator: { kind: string; rectPdf?: number[] }; limitations: readonly string[];
  revalidatedReference?: { from: string; to: string };
}
type ImageContextMetaValue = ImageContextMetaBase & (
  { status: 'direct-image'; image: { attachmentId: string; mediaType: string;
    bytes: number; width: number; height: number } } |
  { status: 'derived-text'; text: string; textSha256: string; backendId: string;
    backendVersion?: string; model?: string }
)

/** A replay snapshot of an already reauthorized image ref; never inline raster bytes. */
export function imageContextPresentationMeta(value: ImageContextMetaValue) {
  const base = { kind: 'pdf-evidence-snapshot', version: 1, tool: 'pdf_evidence_read',
    status: value.status, refId: value.refId,
    ...(value.revalidatedReference ? { revalidatedReference: value.revalidatedReference } : {}),
    documentId: value.documentId, sourcePath: value.sourcePath.slice(0, MAX_PATH_CHARS),
    sourcePathDigest: value.sourcePathDigest, sourceDigest: value.sourceDigest,
    sourceVersion: value.sourceVersion, contentVersion: value.contentVersion,
    revision: value.revision, page: value.page, source: value.source,
    renderedImageSha256: value.renderedImageSha256, precision: value.precision,
    locator: value.locator, limitations: value.limitations.slice(0, 3) }
  if (value.status === 'direct-image') {
    return { ...base, attachment: { attachmentId: value.image.attachmentId,
      mediaType: value.image.mediaType, bytes: value.image.bytes,
      width: value.image.width, height: value.image.height } }
  }
  const text = value.text.slice(0, MAX_REPLAY_TEXT_CHARS)
  return { ...base, backend: { id: value.backendId,
    ...(value.backendVersion ? { version: value.backendVersion } : {}),
    ...(value.model ? { model: value.model } : {}) },
    snapshot: { text, sha256: evidenceSha256(text), originalSha256: value.textSha256,
      truncated: text.length < value.text.length } }
}
