import { createHash } from 'node:crypto'

/** Byte identity for a source or materialized PDF; not page-content identity. */
export function digestPdfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** V1 draft baseline encoding. Keep byte-for-byte equality with existing records. */
export function encodePdfBaseline(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** Decode only the exact baseline recorded for this source. */
export function decodePdfBaseline(original: string, expectedDigest: string): Uint8Array {
  const bytes = Buffer.from(original, 'base64')
  if (encodePdfBaseline(bytes) !== original || digestPdfBytes(bytes) !== expectedDigest) {
    throw Object.assign(new Error('Saved draft source bytes failed their integrity check'), { code: 'pdf/draft-damaged' })
  }
  return bytes
}
