/** DSH's public, component-encoded session file address grammar. */
export function sessionFile(address: string): { sessionId: string; path: string } {
  const prefix = 'dsh-resource://file/session/'
  if (!address.startsWith(prefix)) throw new Error('PDF requires a session file address')
  const [id, ...parts] = address.slice(prefix.length).split(/[?#]/, 1)[0].split('/')
  if (!id || !parts.length) throw new Error('Invalid PDF address')
  const sessionId = decodeURIComponent(id)
  const path = parts.map(decodeURIComponent).join('/')
  if (!sessionId || !path || path.includes('\0')) throw new Error('Invalid PDF address')
  return { sessionId, path }
}
