/** All OCR geometry uses pixels in the submitted image, with a top-left origin. */
export interface OcrBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type OcrJson = null | boolean | number | string | OcrJson[] | { [key: string]: OcrJson }
export type OcrConfiguration = Readonly<Record<string, OcrJson>>

export type OcrErrorCode =
  | 'disabled' | 'not-configured' | 'dependency-unavailable' | 'authentication-failed'
  | 'timeout' | 'cancelled' | 'recognition-failed' | 'invalid-request'
  | 'engine-unavailable' | 'limit-exceeded'

export class OcrError extends Error {
  constructor(readonly code: OcrErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OcrError'
  }
}

/** A confidence score is an engine score, not a calibrated probability. */
export interface OcrConfidence {
  value: number
  minimum: number
  maximum: number
  meaning: string
}

export interface OcrTextPart {
  id: string
  parentId?: string
  text: string
  box: OcrBox | null
  confidence: OcrConfidence | null
}

export interface OcrOutput {
  text: string
  blocks: OcrTextPart[]
  lines: OcrTextPart[]
  words: OcrTextPart[]
  confidence: OcrConfidence | null
  status: 'complete' | 'partial'
  /** Actual recognized image-space regions; empty means no completed coverage. */
  coverage: OcrBox[]
  warnings: string[]
}

export interface OcrProgress {
  stage: string
  /** Fraction for this stage, between 0 and 1. */
  progress: number | null
}

export interface OcrRequest {
  /** Encoded PNG/JPEG/etc bytes, not a raw RGBA pixel array. */
  image: Blob | Uint8Array
  width: number
  height: number
  languages: readonly string[]
  signal?: AbortSignal
  onProgress?: (progress: OcrProgress) => void
  timeoutMs?: number
  options?: OcrConfiguration
}

export interface OcrEngineDescriptor {
  id: string
  name: string
  version: string
  execution: 'disabled' | 'local' | 'remote'
  languages?: readonly string[]
  geometry: readonly ('block' | 'line' | 'word')[]
  confidence: boolean
  maxPixels?: number
  configurationFields?: readonly {
    key: string
    label: string
    type: 'string' | 'number' | 'boolean' | 'secret-reference'
    required?: boolean
  }[]
}

export interface OcrAvailability {
  status: 'available' | 'disabled' | 'not-configured' | 'unavailable'
  reason?: string
}

export interface OcrEngine {
  readonly descriptor: OcrEngineDescriptor
  availability?(configuration: OcrConfiguration): OcrAvailability | Promise<OcrAvailability>
  recognize(request: OcrRequest, configuration: OcrConfiguration): Promise<OcrOutput>
}

export interface OcrInstance {
  id: string
  engineId: string
  /** Change whenever settings/credentials affecting results change; contains no secret. */
  configurationRevision: string
  config: OcrConfiguration
}

export interface OcrSource {
  engineId: string
  engineVersion: string
  instanceId: string
  configurationRevision: string
  languages: readonly string[]
}

export interface OcrResult extends OcrOutput {
  source: OcrSource
  image: { width: number; height: number }
  cached: boolean
}

export interface OcrCacheIdentity {
  documentId: string
  contentVersion: string
  page: number
  /** Region in original PDF coordinates, or null for the entire page. */
  region: readonly [number, number, number, number] | null
  /** Include rotation, rendering density, annotation policy and other render options. */
  renderRevision: string
}
