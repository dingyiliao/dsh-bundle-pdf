import { createHash } from 'node:crypto'

/** Digest of the exact model-visible snapshot, not a durable PDF element ID. */
export function evidenceSha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export type ImageEvidenceSource = {
  kind: 'direct-image' | 'ocr-text' | 'auxiliary-vision'
  sourceDigest: string
  /** Digest of the PDFium-rendered PNG passed to the selected backend. */
  renderedImageSha256: string
  /** For direct delivery, digest of the normalized bytes actually stored for the model. */
  storedImageSha256?: string
  snapshotSha256?: string
  precision: 'page-only'
  limitations: string[]
}

export function imageEvidenceSource(input: {
  kind: ImageEvidenceSource['kind']; pdfBytes: Uint8Array; imageBytes: Uint8Array; text?: string
  storedImageSha256?: string
}): ImageEvidenceSource {
  const limitations = input.kind === 'direct-image'
    ? ['The current vision-capable model receives this rendered page image; unsaved draft annotation overlays are absent.',
      ...input.storedImageSha256 === undefined ? ['The attachment store did not provide a verifiable stored-byte digest.'] : []]
    : input.kind === 'ocr-text'
      ? ['OCR text is derived from page pixels and may misread layout; the current model has not received the image.']
      : ['An auxiliary visual model described the page; the current model has not received the image, and details may be omitted.']
  return { kind: input.kind, sourceDigest: evidenceSha256(input.pdfBytes),
    renderedImageSha256: evidenceSha256(input.imageBytes),
    ...(input.storedImageSha256 === undefined ? {} : { storedImageSha256: input.storedImageSha256 }),
    ...(input.text === undefined ? {} : { snapshotSha256: evidenceSha256(input.text) }),
    precision: 'page-only', limitations }
}
