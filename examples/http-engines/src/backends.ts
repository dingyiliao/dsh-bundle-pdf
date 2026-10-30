import type { HostOcrBackend } from '@dylanl1/dsh-plugin-pdf/ocr-host'
import type { ImageUnderstandingBackend } from '@dylanl1/dsh-plugin-pdf/image-host'
import type { EngineConfiguration } from '@dylanl1/dsh-plugin-pdf/engines'

type Image = { data: Uint8Array; mediaType: string; width: number; height: number }

/** The endpoint belongs to this example, not a standard OCR/vendor protocol. */
async function post(fetcher: typeof fetch, configuration: EngineConfiguration | undefined,
  image: Image, input: object, signal: AbortSignal): Promise<{ text: string; model?: string }> {
  const endpoint = new URL(String(configuration?.endpoint ?? ''))
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Configure an HTTP(S) endpoint without embedded credentials.')
  }
  signal.throwIfAborted()
  const response = await fetcher(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ image: { mediaType: image.mediaType, width: image.width, height: image.height,
      base64: Buffer.from(image.data).toString('base64') }, ...input }),
  })
  if (!response.ok) throw new Error(`Engine endpoint returned HTTP ${response.status}.`)
  const value: unknown = await response.json()
  signal.throwIfAborted()
  if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string'
    || value.text.length > 32_768 || 'model' in value && typeof value.model !== 'string') {
    throw new Error('Engine endpoint must return { text: string, model?: string }.')
  }
  return { text: value.text, ...('model' in value ? { model: value.model as string } : {}) }
}

const endpointField = { key: 'endpoint', label: 'HTTP endpoint', type: 'string' as const, required: true }

export function createHttpOcrBackend(fetcher: typeof fetch = fetch): HostOcrBackend {
  return {
    descriptor: { id: 'example.http-ocr', name: 'Example HTTP OCR', version: '1', execution: 'service',
      geometry: [], confidence: false, languages: ['auto'], configurationFields: [endpointField] },
    async availability(_sessionId, _signal, configuration) {
      return configuration?.endpoint ? { status: 'available' } : { status: 'not-configured', reason: 'Set the HTTP endpoint.' }
    },
    async recognize(request, configuration) {
      const data = request.image instanceof Uint8Array ? request.image : new Uint8Array(await request.image.arrayBuffer())
      const result = await post(fetcher, configuration, { data, mediaType: request.mediaType,
        width: request.width, height: request.height }, { languages: request.languages }, request.signal!)
      // A text-only provider does not invent word positions or confidence scores.
      return { text: result.text, blocks: [], lines: [], words: [], confidence: null, status: 'complete',
        coverage: [{ x0: 0, y0: 0, x1: request.width, y1: request.height }], warnings: [] }
    },
  }
}

export function createHttpVisionBackend(fetcher: typeof fetch = fetch): ImageUnderstandingBackend {
  return {
    descriptor: { id: 'example.http-vision', name: 'Example HTTP vision', version: '1', execution: 'service',
      configurationFields: [endpointField] },
    async availability(_sessionId, _signal, configuration) {
      return configuration?.endpoint ? { available: true } : { available: false, reason: 'Set the HTTP endpoint.' }
    },
    understand(request, configuration) {
      return post(fetcher, configuration, request.image, { prompt: request.prompt }, request.signal)
    },
  }
}
