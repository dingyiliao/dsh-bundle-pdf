import { createHash } from 'node:crypto'
import { EmbeddingError, type EmbeddingEngine, type EmbeddingEngineRequest, type EmbeddingModel } from '../../../embedding/index.js'
import type { EngineConfiguration } from '../../../modules/engines/index.js'

export const QWEN3_RETRIEVAL_INSTRUCTION = 'Given a search query, retrieve relevant passages from the document that answer the query'
const localEndpoint = 'http://127.0.0.1:8001/v1/embeddings'
const modelName = 'mlx-community/Qwen3-Embedding-0.6B-8bit'
export const LOCAL_QWEN3_REVISION = 'b8d7100604f51da6d14eab4dd1805f596fa1ce3f'

interface Options {
  /** Remote transport is explicit; the built-in engine only accepts loopback. */
  execution?: 'local' | 'remote'
  fetch?: typeof fetch
  maxResponseBytes?: number
}
interface Configuration {
  endpoint: string; model: string; modelRevision: string; dimensions: number
  maxBatchSize: number; maxInputCharacters: number; queryInstruction: string
}

function configuration(input: EngineConfiguration, execution: 'local' | 'remote'): Configuration {
  const string = (key: string, fallback: string): string => {
    const value = input[key] ?? fallback
    if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new EmbeddingError('invalid-request', 'Invalid embedding configuration.')
    return value.trim()
  }
  const integer = (key: string, fallback: number, maximum: number): number => {
    const value = input[key] ?? fallback
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new EmbeddingError('invalid-request', 'Invalid embedding configuration.')
    }
    return value
  }
  let url: URL
  try { url = new URL(string('endpoint', execution === 'local' ? localEndpoint : '')) } catch {
    throw new EmbeddingError('invalid-request', 'Configure a valid embedding endpoint.')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)
      || execution === 'local' && !loopback || execution === 'remote' && url.protocol !== 'https:') {
    throw new EmbeddingError('invalid-request', execution === 'local'
      ? 'The local embedding engine requires a loopback HTTP endpoint.' : 'The remote embedding engine requires an HTTPS endpoint.')
  }
  const queryInstruction = input.queryInstruction ?? QWEN3_RETRIEVAL_INSTRUCTION
  if (typeof queryInstruction !== 'string' || queryInstruction.length > 512) throw new EmbeddingError('invalid-request', 'Invalid embedding instruction.')
  return { endpoint: url.toString(), model: string('model', modelName), modelRevision: string('modelRevision', LOCAL_QWEN3_REVISION),
    dimensions: integer('dimensions', 1024, 8192), maxBatchSize: integer('maxBatchSize', 8, 16),
    maxInputCharacters: integer('maxInputCharacters', 16_000, 16_000), queryInstruction }
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new EmbeddingError('engine-unavailable', 'The embedding endpoint returned an error.') }
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > limit) { await response.body?.cancel(); throw new EmbeddingError('limit-exceeded', 'The embedding response exceeds its size limit.') }
  const reader = response.body?.getReader()
  if (!reader) throw new EmbeddingError('invalid-result', 'The embedding endpoint returned an empty response.')
  const decoder = new TextDecoder()
  let text = '', bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) throw new EmbeddingError('limit-exceeded', 'The embedding response exceeds its size limit.')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    try { return JSON.parse(text) } catch { throw new EmbeddingError('invalid-result', 'The embedding endpoint returned invalid JSON.') }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** OpenAI wire format; no chat model, remote RAG store, ingestion or PDF data access. */
export function createOpenAiCompatibleEmbeddingEngine(options: Options = {}): EmbeddingEngine {
  const execution = options.execution ?? 'local'
  const id = execution === 'local' ? 'local-qwen3-embedding' : 'remote-openai-embedding'
  const requestFetch = options.fetch ?? fetch
  const descriptor = { id, name: execution === 'local' ? 'Local Qwen3 embedding' : 'Remote embedding endpoint', version: '1', execution,
    configurationFields: [
      { key: 'endpoint', label: 'Embedding endpoint', type: 'string' as const },
      { key: 'model', label: 'Model name', type: 'string' as const },
      { key: 'modelRevision', label: 'Model revision', type: 'string' as const },
      { key: 'dimensions', label: 'Vector dimensions', type: 'number' as const },
      { key: 'maxBatchSize', label: 'Batch size', type: 'number' as const },
      { key: 'maxInputCharacters', label: 'Maximum input characters', type: 'number' as const },
      { key: 'queryInstruction', label: 'Query instruction', type: 'string' as const },
    ] }
  const describe = (input: EngineConfiguration): EmbeddingModel => {
    const config = configuration(input, execution)
    const encoding = `qwen3-instruct-l2-v1:${createHash('sha256').update(config.queryInstruction).digest('hex')}`
    const fingerprint = createHash('sha256').update(JSON.stringify({ engine: id, version: descriptor.version, ...config, encoding })).digest('hex')
    return { engineId: id, engineVersion: descriptor.version, model: config.model, modelRevision: config.modelRevision,
      dimensions: config.dimensions, maxBatchSize: config.maxBatchSize, maxInputCharacters: config.maxInputCharacters, encoding, fingerprint }
  }
  const verifyMetadata = async (config: Configuration, signal: AbortSignal): Promise<void> => {
    const url = new URL(config.endpoint)
    url.pathname = url.pathname.replace(/\/embeddings\/?$/, '/models')
    if (url.pathname === new URL(config.endpoint).pathname) throw new EmbeddingError('invalid-request', 'The embedding endpoint must end with /embeddings.')
    const response = await requestFetch(url.toString(), { redirect: 'error', signal })
    const raw = await readJson(response, 64 * 1024) as { data?: { id?: unknown; embedding?: Record<string, unknown> }[] }
    const entry = Array.isArray(raw?.data) ? raw.data.find(item => item?.id === config.model) : undefined
    const metadata = entry?.embedding
    if (!metadata || metadata.revision !== config.modelRevision || metadata.dimensions !== config.dimensions
        || metadata.truncation !== false || typeof metadata.maxInputCharacters !== 'number'
        || metadata.maxInputCharacters < config.maxInputCharacters || typeof metadata.maxBatchSize !== 'number'
        || metadata.maxBatchSize < config.maxBatchSize || metadata.queryEncoding !== 'client-instruction') {
      throw new EmbeddingError('engine-unavailable', 'The embedding endpoint must report matching model metadata and non-truncating inputs at /v1/models.')
    }
  }
  const embed = async (request: EmbeddingEngineRequest, input: EngineConfiguration): Promise<number[][]> => {
    const config = configuration(input, execution)
    request.signal.throwIfAborted()
    if (!request.texts.length || request.texts.length > config.maxBatchSize
        || request.texts.some(text => !text.trim() || text.length > config.maxInputCharacters)) {
      throw new EmbeddingError('limit-exceeded', 'The embedding inputs exceed the endpoint limits.')
    }
    const texts = request.purpose === 'query' && config.queryInstruction
      ? request.texts.map(text => `Instruct: ${config.queryInstruction}\nQuery: ${text}`) : [...request.texts]
    await verifyMetadata(config, request.signal)
    const response = await requestFetch(config.endpoint, { method: 'POST', redirect: 'error', signal: request.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: config.model, input: texts, encoding_format: 'float' }) })
    const raw = await readJson(response, options.maxResponseBytes ?? 4 * 1024 * 1024) as { model?: unknown; model_revision?: unknown; data?: unknown }
    request.signal.throwIfAborted()
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.data) || raw.data.length !== texts.length
        || raw.model_revision !== config.modelRevision
        || raw.model !== undefined && raw.model !== config.model) throw new EmbeddingError('invalid-result', 'The embedding response does not match the requested model, revision or batch.')
    const vectors: number[][] = Array.from({ length: texts.length })
    const indices = new Set<number>()
    for (const item of raw.data) {
      if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= texts.length
          || indices.has(item.index) || !Array.isArray(item.embedding) || item.embedding.length !== config.dimensions
          || item.embedding.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new EmbeddingError('invalid-result', 'The embedding response contains invalid or duplicate vector entries.')
      }
      indices.add(item.index)
      vectors[item.index] = item.embedding
    }
    return vectors
  }
  return { descriptor, describe, embed, async availability(config, signal) {
    await verifyMetadata(configuration(config, execution), signal)
    return { status: 'available' }
  } }
}
