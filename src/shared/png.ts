export interface PngLimits {
  maxBytes: number
  maxWidth?: number
  maxHeight?: number
  maxPixels?: number
}

const signature = [137, 80, 78, 71, 13, 10, 26, 10]

/**
 * Validate a complete PNG container before its bytes are trusted as evidence.
 * The caller still owns semantic checks such as matching declared dimensions.
 */
export function inspectPng(bytes: Uint8Array, limits: PngLimits): { width: number; height: number } {
  if (bytes.byteLength < 45 || bytes.byteLength > limits.maxBytes
    || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error('PNG is invalid or exceeds its byte limit')
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (data.getUint32(8) !== 13 || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
    throw new Error('PNG has no valid IHDR chunk')
  }
  const width = data.getUint32(16), height = data.getUint32(20)
  if (width < 1 || height < 1
    || width > (limits.maxWidth ?? 16_384) || height > (limits.maxHeight ?? 16_384)
    || width * height > (limits.maxPixels ?? 24_000_000)) {
    throw new Error('PNG dimensions are invalid')
  }
  let offset = 8
  let hasImageData = false
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) throw new Error('PNG is truncated')
    const length = data.getUint32(offset)
    const next = offset + 12 + length
    if (next > bytes.byteLength) throw new Error('PNG is truncated')
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!)
    if (type === 'IDAT') hasImageData = true
    if (type === 'IEND') {
      if (!hasImageData || length !== 0 || next !== bytes.byteLength) throw new Error('PNG has an invalid ending')
      return { width, height }
    }
    offset = next
  }
  throw new Error('PNG has no end chunk')
}
