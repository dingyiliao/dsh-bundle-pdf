import { createHash } from 'node:crypto'
import { EmbeddingError, type EmbeddingEngine, type EmbeddingEngineOutput, type EmbeddingEngineRequest, type EmbeddingModel } from '../../../embedding/index.js'
import type { EngineConfiguration } from '../../../modules/engines/index.js'

export const QWEN3_RETRIEVAL_INSTRUCTION = 'Given a search query, retrieve relevant passages from the document that answer the query'
const localEndpoint = 'http://127.0.0.1:8001/v1/embeddings'
const modelName = 'mlx-community/Qwen3-Embedding-0.6B-8bit'

interface Options {
  fetch?: typeof fetch
  maxResponseBytes?: number
  /** Host-owned references, never raw credentials from settings. Resolved once per operation. */
  resolveCredential?: (reference: string, signal: AbortSignal) => Promise<string | undefined>
}
interface Configuration {
  endpoint: string; model: string; dimensions: number
  maxBatchSize: number; maxInputCharacters: number; queryInstruction: string
  apiKeyRef?: string
}

function configuration(input: EngineConfiguration): Configuration {
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
  try { url = new URL(string('endpoint', localEndpoint)) } catch {
    throw new EmbeddingError('invalid-request', 'Configure a valid embedding endpoint.')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)
      || url.protocol === 'http:' && !loopback || !/\/embeddings\/?$/.test(url.pathname)) {
    throw new EmbeddingError('invalid-request', 'Use an HTTPS embedding endpoint, or HTTP on loopback, ending in /embeddings.')
  }
  const model = string('model', modelName)
  const queryInstruction = input.queryInstruction ?? ''
  if (typeof queryInstruction !== 'string' || queryInstruction.length > 512) throw new EmbeddingError('invalid-request', 'Invalid embedding instruction.')
  const apiKeyRef = input.apiKeyRef === '' ? undefined : input.apiKeyRef
  if (apiKeyRef !== undefined && (typeof apiKeyRef !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(apiKeyRef))) {
    throw new EmbeddingError('invalid-request', 'Use a credential reference such as EMBEDDING_API_KEY, not an API key.')
  }
  return { endpoint: url.toString(), model,
    dimensions: integer('dimensions', 1024, 8192), maxBatchSize: integer('maxBatchSize', 8, 16),
    maxInputCharacters: integer('maxInputCharacters', 16_000, 16_000), queryInstruction,
    ...(apiKeyRef ? { apiKeyRef } : {}) }
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
  // Keep the persisted ID so an existing service binding retains its configuration.
  const id = 'local-qwen3-embedding'
  const requestFetch = options.fetch ?? fetch
  const revisions = new Map<string, string>()
  const descriptor = { id, name: 'Embedding service', version: '3', execution: 'service' as const,
    configurationFields: [
      { key: 'endpoint', label: 'Embedding endpoint', type: 'string' as const },
      { key: 'apiKeyRef', label: 'API key reference (optional)', type: 'secret-reference' as const },
      { key: 'model', label: 'Model name', type: 'string' as const },
      { key: 'dimensions', label: 'Vector dimensions', type: 'number' as const },
      { key: 'maxBatchSize', label: 'Batch size', type: 'number' as const },
      { key: 'maxInputCharacters', label: 'Maximum input characters', type: 'number' as const },
      { key: 'queryInstruction', label: 'Query instruction', type: 'string' as const },
    ] }
  const describe = (input: EngineConfiguration): EmbeddingModel => {
    const config = configuration(input)
    const encoding = `text-instruct-l2-v1:${createHash('sha256').update(config.queryInstruction).digest('hex')}`
    const modelRevision = revisions.get(configurationIdentity(config)) ?? 'unversioned'
    const documentFingerprint = createHash('sha256').update(JSON.stringify({ engine: id, version: descriptor.version,
      endpoint: config.endpoint, model: config.model, dimensions: config.dimensions, encoding: 'document-text-l2-v1', modelRevision,
      ...(modelRevision === 'unversioned' ? { credentialScope: config.apiKeyRef ?? null } : {}) })).digest('hex')
    const fingerprint = createHash('sha256').update(JSON.stringify({ documentFingerprint, encoding })).digest('hex')
    return { engineId: id, engineVersion: descriptor.version, model: config.model, modelRevision,
      dimensions: config.dimensions, maxBatchSize: config.maxBatchSize, maxInputCharacters: config.maxInputCharacters, encoding, fingerprint,
      documentFingerprint }
  }
  // Discovery belongs to the actual service/model, independent of batch sizing
  // or the query prefix. Request/binding changes are still fenced by the caller.
  const configurationIdentity = (config: Configuration): string => createHash('sha256')
    .update(JSON.stringify([config.endpoint, config.model, config.dimensions, config.apiKeyRef ?? null])).digest('hex')
  const headers = async (config: Configuration, signal: AbortSignal): Promise<Headers> => {
    const result = new Headers({ 'content-type': 'application/json' })
    if (config.apiKeyRef) {
      let key: string | undefined
      try { key = await options.resolveCredential?.(config.apiKeyRef, signal) } catch {
        signal.throwIfAborted()
        throw new EmbeddingError('not-configured', 'The embedding API key reference could not be resolved by the Host.')
      }
      signal.throwIfAborted()
      if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[^\x21-\x7e]/.test(key)) {
        throw new EmbeddingError('not-configured', 'The embedding API key reference is unavailable or invalid.')
      }
      result.set('authorization', `Bearer ${key}`)
    }
    return result
  }
  const verifyMetadata = async (config: Configuration, signal: AbortSignal, requestHeaders: Headers): Promise<string | undefined> => {
    const url = new URL(config.endpoint)
    url.pathname = url.pathname.replace(/\/embeddings\/?$/, '/models')
    const response = await requestFetch(url.toString(), { headers: requestHeaders, redirect: 'error', signal })
    const raw = await readJson(response, 64 * 1024) as { data?: { id?: unknown; embedding?: Record<string, unknown> }[] }
    const entry = Array.isArray(raw?.data) ? raw.data.find(item => item?.id === config.model) : undefined
    if (!entry) throw new EmbeddingError('engine-unavailable', 'The embedding model is not listed by the service at /models.')
    const metadata = entry?.embedding
    // Standard OpenAI-compatible services do not have this extension. When a
    // service supplies it, honor its stronger revision and truncation contract.
    if (metadata !== undefined && (!metadata || typeof metadata.revision !== 'string' || !metadata.revision.trim()
        || metadata.revision.length > 512 || metadata.dimensions !== config.dimensions
        || metadata.truncation !== false || typeof metadata.maxInputCharacters !== 'number'
        || metadata.maxInputCharacters < config.maxInputCharacters || typeof metadata.maxBatchSize !== 'number'
        || metadata.maxBatchSize < config.maxBatchSize || metadata.queryEncoding !== 'client-instruction')) {
      throw new EmbeddingError('engine-unavailable', 'The embedding endpoint must report matching model metadata and non-truncating inputs at /v1/models.')
    }
    const identity = configurationIdentity(config)
    revisions.delete(identity)
    const revision = metadata?.revision as string | undefined
    if (revision !== undefined) {
      revisions.set(identity, revision)
      if (revisions.size > 128) revisions.delete(revisions.keys().next().value!)
    }
    return revision
  }
  const embed = async (request: EmbeddingEngineRequest, input: EngineConfiguration): Promise<EmbeddingEngineOutput> => {
    const config = configuration(input)
    request.signal.throwIfAborted()
    if (!request.texts.length || request.texts.length > config.maxBatchSize
        || request.texts.some(text => !text.trim() || text.length > config.maxInputCharacters)) {
      throw new EmbeddingError('limit-exceeded', 'The embedding inputs exceed the endpoint limits.')
    }
    const texts = request.purpose === 'query' && config.queryInstruction
      ? request.texts.map(text => `Instruct: ${config.queryInstruction}\nQuery: ${text}`) : [...request.texts]
    const requestHeaders = await headers(config, request.signal)
    const serviceRevision = await verifyMetadata(config, request.signal, requestHeaders)
    const verifiedModel = describe(input)
    request.signal.throwIfAborted()
    const response = await requestFetch(config.endpoint, { method: 'POST', redirect: 'error', signal: request.signal,
      headers: requestHeaders, body: JSON.stringify({ model: config.model, input: texts, encoding_format: 'float' }) })
    const raw = await readJson(response, options.maxResponseBytes ?? 4 * 1024 * 1024) as { model?: unknown; model_revision?: unknown; data?: unknown }
    request.signal.throwIfAborted()
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.data) || raw.data.length !== texts.length
        || serviceRevision !== undefined && raw.model_revision !== serviceRevision
        || raw.model_revision !== undefined && (typeof raw.model_revision !== 'string' || !raw.model_revision.trim() || raw.model_revision.length > 512)
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
    return { vectors, model: verifiedModel }
  }
  return { descriptor, describe, embed, async availability(config, signal) {
    const configured = configuration(config)
    signal.throwIfAborted()
    await verifyMetadata(configured, signal, await headers(configured, signal))
    return { status: 'available' }
  } }
}
