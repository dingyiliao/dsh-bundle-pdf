import type { EngineJson } from './types.js'

/** Canonical configuration serialization is shared by Host identity and browser-safe SDKs. */
export function canonicalEngineJson(value: EngineJson): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEngineJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalEngineJson(value[key]!)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
