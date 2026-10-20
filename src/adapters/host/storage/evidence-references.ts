import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { EvidenceReferenceStore, SavedReference } from '../../../modules/evidence/index.js'

const MAX_REFERENCES = 256
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Bounded derived data. Session identity is checked by the evidence use case on every read. */
export function createEvidenceReferenceStore(table: Pick<KvTable<string, SavedReference>, 'get' | 'put' | 'delete' | 'entries'>,
  now: () => number = Date.now): EvidenceReferenceStore {
  return {
    get(refId) {
      const saved = table.get(refId)
      return saved && now() - saved.createdAt <= MAX_AGE_MS ? saved : undefined
    },
    async put(refId, saved) {
      await table.put(refId, saved)
      const entries = [...table.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)
      const expired = entries.filter(([, value]) => now() - value.createdAt > MAX_AGE_MS).map(([key]) => key)
      const excess = entries.slice(0, Math.max(0, entries.length - MAX_REFERENCES)).map(([key]) => key)
      for (const key of new Set([...expired, ...excess])) await table.delete(key)
    },
    async delete(refId) { await table.delete(refId) },
    async deleteSession(sessionId) {
      for (const [key, value] of table.entries()) if (value.sessionId === sessionId) await table.delete(key)
    },
  }
}
