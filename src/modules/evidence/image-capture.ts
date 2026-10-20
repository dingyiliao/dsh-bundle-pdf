import type { DerivedPageValue, RenderedPageValue, ocrPageForAgent } from './agent-page-image.js'
import type { ImageEvidenceCapture } from './image-reference.js'
import { evidenceSha256 } from './provenance.js'

type OcrPageValue = Awaited<ReturnType<typeof ocrPageForAgent>>
export type OcrPageEvidenceValue = Pick<OcrPageValue, 'documentId' | 'path' | 'page' | 'revision'
  | 'sourceVersion' | 'contentVersion' | 'evidenceSource' | 'source' | 'text'>

function shared(value: RenderedPageValue | DerivedPageValue | OcrPageEvidenceValue) {
  return { documentId: value.documentId, sourcePath: value.path,
    sourceDigest: value.evidenceSource.sourceDigest, sourceVersion: value.sourceVersion,
    contentVersion: value.contentVersion, revision: value.revision, page: value.page,
    renderedImageSha256: value.evidenceSource.renderedImageSha256,
    locator: { kind: 'page-only' as const }, precision: 'page-only' as const,
    limitations: [...value.evidenceSource.limitations] }
}

/** Convert a delivered page image or its bounded derivative into metadata-only durable evidence. */
export function captureRenderedPageEvidence(value: RenderedPageValue | DerivedPageValue): ImageEvidenceCapture {
  const base = shared(value)
  if ('image' in value) {
    if (value.evidenceSource.kind !== 'direct-image') throw new Error('Direct image provenance mismatch')
    return { ...base, source: 'direct-image', snapshot: {
      kind: 'attachment', attachmentId: value.image.attachmentId, mediaType: value.image.mediaType,
      bytes: value.image.bytes, width: value.image.width, height: value.image.height,
      ...(value.evidenceSource.storedImageSha256 === undefined ? {}
        : { storedImageSha256: value.evidenceSource.storedImageSha256 }),
    } }
  }
  const source = value.evidenceSource.kind
  if (source !== 'ocr-text' && source !== 'auxiliary-vision') throw new Error('Derived image provenance mismatch')
  return { ...base, source, snapshot: { kind: 'derived-text', text: value.text,
    sha256: evidenceSha256(value.text), backendId: value.source.backendId,
    ...(value.source.model === undefined ? {} : { model: value.source.model }) },
    ...(value.limitations === undefined ? {} : { limitations: [...base.limitations, value.limitations] }) }
}

/** OCR results are text derivatives of rendered pixels, never an image sent to the current model. */
export function captureOcrPageEvidence(value: OcrPageEvidenceValue): ImageEvidenceCapture {
  if (value.evidenceSource.kind !== 'ocr-text') throw new Error('OCR provenance mismatch')
  return { ...shared(value), source: 'ocr-text', snapshot: { kind: 'derived-text',
    text: value.text, sha256: evidenceSha256(value.text), backendId: value.source.backendId,
    backendVersion: value.source.backendVersion } }
}
