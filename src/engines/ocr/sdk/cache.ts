import type { OcrCacheIdentity, OcrJson, OcrRequest, OcrSource } from './types.js'

function canonical(value: OcrJson): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Configuration values are deliberately absent; only their revision identifies them. */
export async function makeOcrCacheKey(source: OcrSource, request: OcrRequest, identity: OcrCacheIdentity): Promise<string> {
  const material = canonical({
    source: { ...source, languages: [...source.languages] },
    identity: { ...identity, region: identity.region ? [...identity.region] : null },
    width: request.width, height: request.height, options: { ...request.options },
  })
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
