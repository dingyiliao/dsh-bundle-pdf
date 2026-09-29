export type TranslationJson = null | boolean | number | string | TranslationJson[] | { [key: string]: TranslationJson }
export type TranslationConfiguration = Readonly<Record<string, TranslationJson>>

export type TranslationErrorCode =
  | 'disabled' | 'not-configured' | 'engine-unavailable' | 'authentication-failed'
  | 'invalid-request' | 'limit-exceeded' | 'timeout' | 'cancelled' | 'stale-result' | 'translation-failed'

export class TranslationError extends Error {
  constructor(readonly code: TranslationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TranslationError'
  }
}

export interface TranslationRequest {
  /** Exact user-selected text. The service never silently truncates it. */
  text: string
  /** Omit or use "auto" to let the selected engine detect the language. */
  sourceLanguage?: string
  targetLanguage: string
  signal?: AbortSignal
  /** May shorten the registry's configured deadline, but cannot extend it. */
  timeoutMs?: number
  /** Optional Host routing context; never a conversation transcript. Other engines may ignore it. */
  context?: {
    sessionId: string
    documentId?: string
    contentVersion?: string
    pages?: readonly number[]
  }
}

export interface TranslationLimits {
  timeoutMs: number
  /** Measured in JavaScript UTF-16 code units, including whitespace. */
  maxInputCharacters: number
  /** Engines must also stop accumulation at this limit while streaming. */
  maxOutputCharacters: number
}

export interface TranslationEngineRequest extends Omit<TranslationRequest, 'signal' | 'timeoutMs'> {
  signal: AbortSignal
  timeoutMs: number
  maxOutputCharacters: number
}

export interface TranslationOutput {
  text: string
  status: 'complete' | 'partial'
  /** Stable warning identifiers suitable for localization by the consuming UI. */
  warnings: string[]
  detectedSourceLanguage?: string
}

export interface TranslationEngineDescriptor {
  id: string
  name: string
  version: string
  execution: 'disabled' | 'local' | 'remote'
  maxInputCharacters?: number
}

export interface TranslationAvailability {
  status: 'available' | 'disabled' | 'not-configured' | 'unavailable'
  reason?: string
}

/** Engines own vendor/model details; they must forward cancellation to their I/O. */
export interface TranslationEngine {
  readonly descriptor: TranslationEngineDescriptor
  availability?(configuration: TranslationConfiguration): TranslationAvailability | Promise<TranslationAvailability>
  translate(request: TranslationEngineRequest, configuration: TranslationConfiguration): Promise<TranslationOutput>
}

export interface TranslationInstance {
  id: string
  engineId: string
  /** Changes whenever configuration or referenced credentials change. Never contains a secret. */
  configurationRevision: string
  config: TranslationConfiguration
}

export interface TranslationResult extends TranslationOutput {
  source: {
    engineId: string
    engineVersion: string
    instanceId: string
    configurationRevision: string
  }
}

export interface TranslationDocumentIdentity {
  documentId: string
  contentVersion: string
}

export interface DocumentTranslationResult extends TranslationResult {
  document: TranslationDocumentIdentity
  /** Monotonic within this reader's TranslationService instance. */
  requestId: number
}
