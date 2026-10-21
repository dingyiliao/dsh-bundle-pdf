import { z } from 'zod'
import type { WorkingCopyReadPort } from '../working-copy/index.js'

const readerRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set'), sessionId: z.string().min(1).max(512),
    tabId: z.string().min(1).max(512), leaseId: z.string().min(1).max(128),
    sequence: z.number().int().nonnegative().safe(), documentId: z.string().min(1).max(512),
    contentVersion: z.string().min(1).max(512), page: z.number().int().min(1).max(100000) }).strict(),
  z.object({ action: z.literal('clear'), sessionId: z.string().min(1).max(512),
    tabId: z.string().min(1).max(512), leaseId: z.string().min(1).max(128),
    sequence: z.number().int().nonnegative().safe() }).strict(),
])

export interface ReaderContext {
  tabId: string
  documentId: string
  contentVersion: string
  page: number
}

/** Volatile UI presence hints, never a source of document authorization or PDF text. */
export function createReaderContexts(workspaces: WorkingCopyReadPort,
  ttlMs = 90_000, now: () => number = Date.now) {
  const bySession = new Map<string, Map<string, ReaderContext & { leaseId: string; sequence: number; seenAt: number }>>()
  const latest = new Map<string, Map<string, { sequence: number; seenAt: number }>>()

  function purge(sessionId: string): void {
    const tabs = bySession.get(sessionId)
    if (tabs) {
      for (const [tabId, entry] of tabs) if (now() - entry.seenAt > ttlMs) tabs.delete(tabId)
      if (!tabs.size) bySession.delete(sessionId)
    }
    const sequences = latest.get(sessionId)
    if (sequences) {
      for (const [tabId, entry] of sequences) {
        if (!tabs?.has(tabId) && now() - entry.seenAt > ttlMs * 2) sequences.delete(tabId)
      }
      if (!sequences.size) latest.delete(sessionId)
    }
  }

  function update(sessionId: string, raw: Record<string, unknown>): { ok: true } {
    const input = readerRequest.parse(raw)
    if (input.sessionId !== sessionId) throw Object.assign(new Error('Session identity mismatch'), { code: 'pdf/session-mismatch' })
    purge(sessionId)
    // Order updates per tab, not per session: an older tab's delayed clear
    // must not suppress a newer tab's independent set.
    const sequences = latest.get(sessionId) ?? new Map()
    if (input.sequence <= (sequences.get(input.tabId)?.sequence ?? -1)) return { ok: true }
    sequences.set(input.tabId, { sequence: input.sequence, seenAt: now() })
    latest.set(sessionId, sequences)
    const tabs = bySession.get(sessionId) ?? new Map()
    if (input.action === 'clear') {
      const prior = tabs.get(input.tabId)
      if (prior?.leaseId === input.leaseId) tabs.delete(input.tabId)
      if (!tabs.size) bySession.delete(sessionId)
      return { ok: true }
    }
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    if (snapshot.contentVersion !== input.contentVersion) {
      throw Object.assign(new Error('PDF working copy changed; refresh the reader'), { code: 'pdf/stale-reader' })
    }
    if (input.page > snapshot.document.pageCount) {
      throw Object.assign(new Error('Page is outside the document'), { code: 'pdf/invalid-page' })
    }
    tabs.set(input.tabId, { tabId: input.tabId, leaseId: input.leaseId,
      sequence: input.sequence, documentId: input.documentId, contentVersion: input.contentVersion,
      page: input.page, seenAt: now() })
    bySession.set(sessionId, tabs)
    return { ok: true }
  }

  function current(sessionId: string): ReaderContext[] {
    purge(sessionId)
    return [...(bySession.get(sessionId)?.values() ?? [])].map(({ tabId, documentId, contentVersion, page }) =>
      ({ tabId, documentId, contentVersion, page }))
  }

  function hasLease(sessionId: string, tabId: string, leaseId: string,
    documentId: string, contentVersion: string): boolean {
    purge(sessionId)
    const current = bySession.get(sessionId)?.get(tabId)
    return current?.leaseId === leaseId && current.documentId === documentId
      && current.contentVersion === contentVersion
  }

  return { update, current, hasLease, dispose() { bySession.clear(); latest.clear() } }
}
