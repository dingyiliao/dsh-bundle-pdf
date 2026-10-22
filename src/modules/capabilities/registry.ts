/** Stable, namespaced operation IDs; plugins may add IDs without changing this module. */
import type {} from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { pdfCapabilities: CapabilityRegistry }
}

export const pdfCapabilities = {
  renderPage: 'pdf.page.render',
  renderAcroForm: 'pdf.form.acroform.render',
  renderXfa: 'pdf.form.xfa.render',
  previewSigned: 'pdf.signature.preview',
  recognizeImage: 'ocr.image.recognize',
  understandImage: 'image.understand',
} as const

export interface CapabilityRequest {
  sessionId?: string
  signal?: AbortSignal
}

export type CapabilitySupport = { available: true } | { available: false; reason: string }

/** An implementation owns its typed API; the catalog only discovers and selects it. */
export interface CapabilityProvider<T = unknown> {
  id: string
  capabilities: readonly string[]
  implementation: T
  priority?: number
  supports?(request: CapabilityRequest): CapabilitySupport | Promise<CapabilitySupport>
}

export interface CapabilityResolution {
  capability: string
  provider?: CapabilityProvider
  reason?: string
}

const validId = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/

/** Per-Host catalog. Registration returns a Fiber-owned disposer. */
export class CapabilityRegistry {
  private readonly providers = new Map<string, CapabilityProvider>()
  private disposed = false

  register<T>(provider: CapabilityProvider<T>): () => void {
    if (this.disposed) throw new Error('Capability registry is disposed')
    if (!validId.test(provider.id) || provider.id.length > 128 || this.providers.has(provider.id)
      || !provider.capabilities.length || provider.capabilities.some(id => !validId.test(id) || id.length > 128)
      || provider.priority !== undefined && !Number.isSafeInteger(provider.priority)) {
      throw new Error('Capability provider ID, operations, or priority is invalid or duplicated')
    }
    this.providers.set(provider.id, provider)
    return () => { if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id) }
  }

  async resolve(capability: string, request: CapabilityRequest = {}, preferredProvider?: string): Promise<CapabilityResolution> {
    if (this.disposed) return { capability, reason: 'Capability registry is disposed' }
    const candidates = [...this.providers.values()].filter(provider => provider.capabilities.includes(capability)
      && (!preferredProvider || provider.id === preferredProvider))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
    if (!candidates.length) return { capability, reason: `No provider is registered for ${capability}` }
    const reasons: string[] = []
    for (const provider of candidates) {
      request.signal?.throwIfAborted()
      try {
        const support = await provider.supports?.(request) ?? { available: true }
        request.signal?.throwIfAborted()
        if (this.providers.get(provider.id) !== provider) continue
        if (support.available) return { capability, provider }
        reasons.push(`${provider.id}: ${support.reason}`)
      } catch (error) {
        request.signal?.throwIfAborted()
        reasons.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { capability, reason: reasons.join('; ') || `No active provider is available for ${capability}` }
  }

  async plan(required: readonly string[], request: CapabilityRequest = {}, preferredProvider?: string): Promise<{
    supported: boolean; resolved: CapabilityResolution[]; missing: CapabilityResolution[]
  }> {
    const resolved = await Promise.all([...new Set(required)].map(id => this.resolve(id, request, preferredProvider)))
    const missing = resolved.filter(item => !item.provider)
    return { supported: missing.length === 0, resolved, missing }
  }

  list(): { id: string; capabilities: string[] }[] {
    return [...this.providers.values()].map(provider => ({ id: provider.id, capabilities: [...provider.capabilities] }))
  }

  dispose(): void { this.disposed = true; this.providers.clear() }
}
