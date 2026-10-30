import { createHash, randomUUID } from 'node:crypto'
import { symbols } from '@deepseek-ai/cordis'
import { canonicalEngineJson, type BackendCacheIdentity } from '../../../modules/engines/index.js'
import type { EngineJson } from '../../../modules/engines/index.js'
import type { OcrModelRoute } from './ocr-model-route.js'

/** Public model metadata only. Provider connection settings and credentials never enter the cache key. */
export interface SessionModelInfo {
  provider?: string
  id?: string
  name?: string
  description?: string
  inputModalities?: readonly string[]
  context?: { contextWindow: number }
  defaultMaxTokens?: number
  reasoning?: { efforts: readonly { id: string; name: string }[]; defaultEffort?: string }
  systemPromptUpdate?: string
  toolUpdate?: string
}

const runtimes = new WeakMap<object, string>()

/** DSH exposes no immutable provider registration/config revision, so these identities are runtime scoped. */
export function sessionModelCacheIdentity(runtime: object, route: OcrModelRoute, info: SessionModelInfo,
  controls: EngineJson): BackendCacheIdentity {
  // Cordis creates a fresh context-aware proxy on each service access. Unwrap
  // only the identity key; model calls must still use the caller's traced proxy.
  const original: unknown = Reflect.get(runtime, symbols.original)
  const instance = original !== null && (typeof original === 'object' || typeof original === 'function') ? original : runtime
  let generation = runtimes.get(instance)
  if (!generation) { generation = randomUUID(); runtimes.set(instance, generation) }
  const metadata: Record<string, EngineJson> = {}
  for (const key of ['provider', 'id', 'name', 'description', 'systemPromptUpdate', 'toolUpdate'] as const) {
    if (typeof info[key] === 'string') metadata[key] = info[key]!
  }
  if (info.inputModalities) metadata.inputModalities = [...info.inputModalities]
  if (info.context) metadata.contextWindow = info.context.contextWindow
  if (info.defaultMaxTokens !== undefined) metadata.defaultMaxTokens = info.defaultMaxTokens
  if (info.reasoning) metadata.reasoning = {
    efforts: info.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name })),
    defaultEffort: info.reasoning.defaultEffort ?? null,
  }
  return { reusable: false, identity: createHash('sha256').update(canonicalEngineJson({
    generation, route: { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort ?? null },
    metadata, controls,
  })).digest('hex') }
}
