/** Browser-safe digest for text evidence and binary attachments; no Node runtime imports. */
export async function browserSha256(value: string | Uint8Array): Promise<string> {
  // TextEncoder already owns its bytes; attachments need an owned copy, including shared-buffer views.
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
