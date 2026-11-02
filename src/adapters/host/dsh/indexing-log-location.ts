import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Keep ordinary profile names readable without letting names create paths. */
function profileSegment(name: string): string {
  if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) && !name.endsWith('.')
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return name
  // Lowercase names also stay distinct on case-insensitive filesystems. '~'
  // cannot occur in that branch; hashing bounds long or non-ASCII names.
  return `~${createHash('sha256').update(name).digest('hex')}`
}

function location(profile: unknown, envHome: string | undefined, userHome: string): { home: string; profile: string } {
  if (typeof profile === 'object' && profile !== null && 'home' in profile && 'name' in profile
    && typeof profile.home === 'string' && isAbsolute(profile.home) && !profile.home.includes('\0')
    && typeof profile.name === 'string' && profile.name.trim().length > 0) {
    return { home: profile.home, profile: profileSegment(profile.name) }
  }
  const configured = envHome?.trim() && !envHome.includes('\0') ? envHome : undefined
  const home = configured === undefined ? join(userHome, '.dsh')
    : /^~(?:[\\/]|$)/.test(configured) ? join(userHome, configured.slice(2)) : configured
  return { home: resolve(home), profile: 'standalone' }
}

/** Resolve diagnostics beside the launcher's data, including custom DSH_HOME. */
export function resolveIndexingLogDirectory(profile: unknown, envHome = process.env.DSH_HOME,
  userHome = homedir()): string {
  const value = location(profile, envHome, userHome)
  return join(value.home, 'logs', 'dsh-plugin-pdf', value.profile)
}

/** Complete indexes are durable profile data, independent of the expiring legacy cache. */
export function resolveRetrievalStoreDirectory(profile: unknown, namespaceSuffix: string, envHome = process.env.DSH_HOME,
  userHome = homedir()): string {
  if (!/^[a-f0-9]{16}$/.test(namespaceSuffix)) throw new RangeError('Invalid PDF storage namespace')
  const value = location(profile, envHome, userHome)
  return join(value.home, 'storages', 'dsh-plugin-pdf', value.profile, namespaceSuffix, 'retrieval-v1')
}
