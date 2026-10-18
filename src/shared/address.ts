import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

/** Require a DSH session file address with a non-empty, NUL-free PDF path. */
export function sessionFile(address: string): { sessionId: string; path: string } {
  const prefix = 'dsh-resource://file/session/'
  if (!address.startsWith(prefix)) throw new Error('PDF requires a session file address')
  const parsed = parseFileAddress(address)
  if (parsed?.scope !== 'session' || !parsed.sessionId || !parsed.path || parsed.path.includes('\0')) {
    throw new Error('Invalid PDF address')
  }
  return { sessionId: parsed.sessionId, path: parsed.path }
}
