/** Optional bridge to the native macOS dictionary for the current DOM selection. */

export interface NativeDictionaryAdapter {
  readonly platform: 'darwin'
  /**
   * Ask an authorized host bridge to show the native dictionary beside the
   * current selection. The caller must preserve the selection and user gesture.
   */
  lookupSelection(): Promise<void>
}

export type NativeDictionaryPlatform = 'darwin' | 'other' | 'unknown'
export type NativeDictionaryUnavailableReason = 'unsupported-platform' | 'adapter-unavailable' | 'disposed'

export interface NativeDictionaryAvailability {
  readonly platform: NativeDictionaryPlatform
  readonly available: boolean
  readonly reason: NativeDictionaryUnavailableReason | null
}

export class NativeDictionaryError extends Error {
  constructor(readonly code: NativeDictionaryUnavailableReason, message: string) {
    super(message)
    this.name = 'NativeDictionaryError'
  }
}

export interface NativeDictionary {
  readonly available: boolean
  readonly availability: NativeDictionaryAvailability
  /** Stable immutable snapshot, suitable for useSyncExternalStore. */
  getSnapshot(): NativeDictionaryAvailability
  subscribe(listener: () => void): () => void
  /** Register one real host bridge. Duplicate registrations are rejected. */
  register(adapter: NativeDictionaryAdapter): () => void
  lookupSelection(): Promise<void>
  dispose(): void
}

/** Browser platform detection is presentation only; it never grants native access. */
function detectPlatform(): NativeDictionaryPlatform {
  if (typeof navigator === 'undefined') return 'unknown'
  // iPadOS can advertise MacIntel. It still cannot use a macOS dictionary bridge.
  const platform = navigator.platform ?? ''
  if (/iPad|iPhone|iPod/i.test(navigator.userAgent ?? '')
    || (/^Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return 'other'

  const browser = navigator as Navigator & { readonly userAgentData?: { readonly platform?: string } }
  const modern = browser.userAgentData?.platform?.trim()
  if (modern) {
    if (/^(macos|mac os(?: x)?|mac|darwin)$/i.test(modern)) return 'darwin'
    if (!/^unknown$/i.test(modern)) return 'other'
  }
  if (/^Mac/i.test(platform)) return 'darwin'
  return platform && !/^unknown$/i.test(platform) ? 'other' : 'unknown'
}

/**
 * Create a capability registry without importing Electron, calling the shell,
 * or assuming that DSH exposes a dictionary method. A separate, authorized
 * bridge provider may register an adapter through the plugin's pdfDictionary
 * service. Until then, macOS reports adapter-unavailable.
 */
export function createNativeDictionary(): NativeDictionary {
  const platform = detectPlatform()
  const listeners = new Set<() => void>()
  let registration: { adapter: NativeDictionaryAdapter } | undefined
  let disposed = false
  let snapshot: NativeDictionaryAvailability = Object.freeze({
    platform,
    available: false,
    reason: platform === 'darwin' ? 'adapter-unavailable' : 'unsupported-platform',
  })

  const publish = (): void => {
    const reason: NativeDictionaryUnavailableReason | null = disposed ? 'disposed'
      : platform !== 'darwin' ? 'unsupported-platform'
        : registration === undefined ? 'adapter-unavailable' : null
    if (snapshot.reason === reason) return
    snapshot = Object.freeze({ platform, available: reason === null, reason })
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue
      try { listener() } catch { /* A UI observer cannot prevent capability cleanup. */ }
    }
  }

  const unavailable = (): NativeDictionaryError => {
    const reason = snapshot.reason ?? 'adapter-unavailable'
    const message = reason === 'disposed' ? 'The native dictionary service has been disposed.'
      : reason === 'unsupported-platform' ? 'The native dictionary is available only on macOS.'
        : 'The current host does not provide a native macOS dictionary bridge.'
    return new NativeDictionaryError(reason, message)
  }

  // All methods close over their state, so passing getSnapshot or subscribe as
  // callbacks does not lose a receiver binding.
  return {
    get available() { return snapshot.available },
    get availability() { return snapshot },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    register(adapter) {
      if (disposed || platform !== 'darwin') throw unavailable()
      if (!adapter || adapter.platform !== 'darwin' || typeof adapter.lookupSelection !== 'function') {
        throw new TypeError('A native macOS dictionary adapter must provide lookupSelection().')
      }
      if (registration !== undefined) throw new Error('A native dictionary adapter is already registered.')
      const current = { adapter }
      registration = current
      publish()
      return () => {
        if (registration !== current) return
        registration = undefined
        publish()
      }
    },
    async lookupSelection() {
      const current = registration
      if (!snapshot.available || current === undefined) throw unavailable()
      // Invoke immediately, before an async boundary loses the click's user
      // activation. Native behavior and selection ownership belong to the bridge.
      await current.adapter.lookupSelection()
    },
    dispose() {
      if (disposed) return
      disposed = true
      registration = undefined
      publish()
      listeners.clear()
    },
  }
}
