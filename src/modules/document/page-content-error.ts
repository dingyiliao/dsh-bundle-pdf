/** Source authority, stale snapshots and cancellation cannot become a successful
 * partial extraction. Contributor adapters may wrap these typed failures. */
export function fatalContentError(error: unknown): unknown | undefined {
  const seen = new Set<object>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const code = 'code' in current && typeof current.code === 'string' ? current.code : ''
    if ('name' in current && current.name === 'AbortError'
      || ['cancelled', 'pdf/image-cancelled', 'pdf/cancelled', 'pdf/not-found', 'pdf/unknown-document',
        'pdf/unavailable', 'FS_SANDBOX_DENIED', 'EACCES', 'EPERM', 'ENOENT'].includes(code)
      || /^pdf\/(?:source-|stale-|session-|access-|permission-)/.test(code)) return current
    current = 'cause' in current ? current.cause : undefined
  }
}
