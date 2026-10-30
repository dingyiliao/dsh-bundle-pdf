import type { DerivedPageValue, RenderedPageValue } from './agent-page-image.js'
import type { ImageEvidenceCapture } from './image-reference.js'
import { evidenceSha256 } from './provenance.js'

function shared(value: RenderedPageValue | DerivedPageValue) {
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
    ...(value.source.backendVersion === undefined ? {} : { backendVersion: value.source.backendVersion }),
    ...(value.source.model === undefined ? {} : { model: value.source.model }) },
    ...(value.limitations === undefined ? {} : { limitations: [...base.limitations, value.limitations] }) }
}
