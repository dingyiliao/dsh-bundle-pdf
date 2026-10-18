export const MAX_EXPLANATION_IMAGE_BYTES = 6 * 1024 * 1024

/** Encode a bounded PNG only at send time; a cancelled draft never creates a Session attachment. */
export async function encodeExplanationImage(blob: Blob, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (blob.type !== 'image/png') throw new TypeError('Explanation regions must be PNG images.')
  if (blob.size <= 0 || blob.size > MAX_EXPLANATION_IMAGE_BYTES) {
    throw new RangeError('The selected region exceeds the explanation image size limit.')
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  signal?.throwIfAborted()
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 16_384)))
  }
  return btoa(chunks.join(''))
}
