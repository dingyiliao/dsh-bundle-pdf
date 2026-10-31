import type { EngineBinding, EngineConfiguration, EngineDescriptor } from '../modules/engines/index.js'

export type EmbeddingErrorCode = 'disabled' | 'not-configured' | 'engine-unavailable'
  | 'invalid-request' | 'invalid-result' | 'limit-exceeded' | 'timeout' | 'cancelled'

export class EmbeddingError extends Error {
  constructor(readonly code: EmbeddingErrorCode, message: string) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

/** The encoding identity, not a document/session identity or access grant. */
export interface EmbeddingModel {
  engineId: string
  engineVersion: string
  model: string
  /** Provider-owned version/encoding identity; never requires a user-facing revision setting. */
  modelRevision: string
  dimensions: number
  maxBatchSize: number
  /** UTF-16 units per input. Providers must reject overlong input, never truncate. */
  maxInputCharacters: number
  /** Includes query instructions, document encoding and normalization version. */
  encoding: string
  fingerprint: string
  /** Optional identity of document vectors only. Excludes query instructions
   * and transport limits; providers own and must attest its encoding contract. */
  documentFingerprint?: string
}

export interface EmbeddingRequest {
  texts: readonly string[]
  purpose: 'query' | 'document'
  signal?: AbortSignal
  timeoutMs?: number
}
export interface EmbeddingEngineRequest extends Omit<EmbeddingRequest, 'signal' | 'timeoutMs'> {
  signal: AbortSignal
  timeoutMs: number
}
export interface EmbeddingAvailability {
  status: 'available' | 'disabled' | 'not-configured' | 'unavailable'
  reason?: string
}
export interface EmbeddingEngine {
  readonly descriptor: EngineDescriptor
  /** Synchronous, side-effect-free description used to key derived indexes. */
  describe(config: EngineConfiguration): EmbeddingModel
  availability?(config: EngineConfiguration, signal: AbortSignal): Promise<EmbeddingAvailability>
  embed(request: EmbeddingEngineRequest, config: EngineConfiguration): Promise<EmbeddingEngineOutput>
}
/** A provider may report the exact model identity verified for this operation. */
export type EmbeddingEngineOutput = readonly (readonly number[])[]
  | { vectors: readonly (readonly number[])[]; model: EmbeddingModel }
export interface EmbeddingLimits {
  timeoutMs: number
  maxBatchSize: number
  maxInputCharacters: number
  maxDimensions: number
}
export interface EmbeddingResult { vectors: number[][]; model: EmbeddingModel }
export type EmbeddingBinding = EngineBinding

export function createDisabledEmbeddingEngine(): EmbeddingEngine {
  return {
    descriptor: { id: 'none', name: 'Disabled', version: '1', execution: 'disabled' },
    describe() { throw new EmbeddingError('disabled', 'Semantic retrieval is disabled.') },
    async availability() { return { status: 'disabled' } },
    async embed() { throw new EmbeddingError('disabled', 'Semantic retrieval is disabled.') },
  }
}
