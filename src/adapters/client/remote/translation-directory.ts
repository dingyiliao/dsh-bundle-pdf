import type { TranslationRegistry, TranslationEngineDescriptor } from '../../../translation/index.js'
import { createHostTranslationEngine } from './translation-api.js'
import type { PdfConnection } from './pdf-api.js'

/** Host registrations are authoritative. Unchanged proxies retain active tasks. */
export function createTranslationDirectoryMirror(registry: TranslationRegistry, connection: PdfConnection, lifetime: AbortSignal) {
  const installed = new Map<string, { fingerprint: string; remove(): void }>()
  return {
    update(descriptors: readonly TranslationEngineDescriptor[]) {
      const next = new Set(descriptors.map(item => item.id))
      for (const [id, entry] of installed) if (!next.has(id)) { entry.remove(); installed.delete(id) }
      for (const descriptor of descriptors) {
        const fingerprint = JSON.stringify(descriptor), previous = installed.get(descriptor.id)
        if (previous?.fingerprint === fingerprint) continue
        previous?.remove()
        installed.set(descriptor.id, { fingerprint,
          remove: registry.register(createHostTranslationEngine(connection, lifetime, descriptor)) })
      }
    },
    dispose() { for (const entry of installed.values()) entry.remove(); installed.clear() },
  }
}
