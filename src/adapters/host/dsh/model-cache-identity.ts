import { createHash } from 'node:crypto'
import { canonicalEngineJson } from '../../../modules/engines/index.js'
import type { EngineJson } from '../../../modules/engines/index.js'
import type { SessionModelRoute } from './session-model-route.js'

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

/** Persist the resolved request identity, independently of sessions and Cordis proxies.
 * Service registration generations remain separate fences for in-flight work.
 * The same provider/model route is treated as the same configured model;
 * DSH does not expose immutable server-side weight revisions. */
export function sessionModelCacheIdentity(route: SessionModelRoute, info: SessionModelInfo,
  controls: EngineJson): string {
  return createHash('sha256').update(canonicalEngineJson({
    version: 2,
    route: { provider: route.provider, model: route.model,
      reasoningEffort: route.reasoningEffort || info.reasoning?.defaultEffort || null },
    controls,
  })).digest('hex')
}
