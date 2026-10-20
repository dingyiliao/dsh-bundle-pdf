import { MAX_EXPLANATION_REGION_IMAGE_BYTES } from './model.js'

export const MAX_EXPLANATION_IMAGE_BYTES = MAX_EXPLANATION_REGION_IMAGE_BYTES

/** Encode exact PNG bytes at send time. Direct images use Host-verified bytes. */
export function encodeExplanationImageBytes(bytes: Uint8Array, signal?: AbortSignal): string {
  signal?.throwIfAborted()
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_EXPLANATION_IMAGE_BYTES) {
    throw new RangeError('The selected region exceeds the explanation image size limit.')
  }
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 16_384)))
  }
  const encoded = btoa(chunks.join(''))
  signal?.throwIfAborted()
  return encoded
}

/** Encode a bounded PNG only at send time; a cancelled draft never creates a Session attachment. */
export async function encodeExplanationImage(blob: Blob, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (blob.type !== 'image/png') throw new TypeError('Explanation regions must be PNG images.')
  if (blob.size <= 0 || blob.size > MAX_EXPLANATION_IMAGE_BYTES) {
    throw new RangeError('The selected region exceeds the explanation image size limit.')
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  signal?.throwIfAborted()
  return encodeExplanationImageBytes(bytes, signal)
}
