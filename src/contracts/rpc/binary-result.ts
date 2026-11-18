const binaryTag = Symbol('pdf.binary-response')

/** Internal binary response carried from a host operation to its RPC transport. */
export interface BinaryResult {
  [binaryTag]: true
  value: Record<string, unknown>
  bytes: Uint8Array
  mime: string
}

/** Uses the Connection multipart attachment codec; never Base64 JSON. */
export function binaryResult(value: Record<string, unknown>, bytes: Uint8Array, mime: string): BinaryResult {
  return { [binaryTag]: true, value: { ...value, bytes: null }, bytes, mime }
}

export function isBinaryResult(value: unknown): value is BinaryResult {
  return typeof value === 'object' && value !== null && binaryTag in value
}
