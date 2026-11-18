import type { EngineConfiguration, EngineDescriptor, EngineJson } from './types.js'
import { canonicalEngineJson } from './serialization.js'

/** A plain string attests to persistent identity; scoped metadata cannot attest to reuse after restart. */
export type BackendCacheIdentity = string | { identity: string; reusable: false } | undefined
export interface EngineCacheIdentity {
  fingerprint: string
  /** Runtime registration lifetime, also checked before committing asynchronous derivations. */
  generation: string
  reusable: boolean
  backendId: string
  backendVersion: string
}

/** The caller supplies its platform hash; this shared SDK keeps no Host runtime dependency. */
export function engineCacheIdentity(descriptor: EngineDescriptor, config: EngineConfiguration,
  generation: string, sessionId: string, backendIdentity: BackendCacheIdentity,
  hash: (canonical: string) => string, context: EngineJson = null): EngineCacheIdentity {
  const identity = typeof backendIdentity === 'string' ? backendIdentity : backendIdentity?.identity
  if (identity !== undefined && (typeof identity !== 'string' || !identity.trim() || identity.length > 16_384)) {
    throw new Error('The engine returned an invalid cache identity')
  }
  const reusable = typeof backendIdentity === 'string'
  const fingerprint = hash(canonicalEngineJson({
    backendId: descriptor.id, backendVersion: descriptor.version, config: { ...config },
    capabilities: descriptor.capabilities ? [...descriptor.capabilities].sort() : null,
    identity: identity ?? null, context,
    ...reusable ? {} : { generation, sessionId },
  }))
  return { fingerprint, generation, reusable, backendId: descriptor.id, backendVersion: descriptor.version }
}
