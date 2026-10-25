import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { WorkingCopyReadPort } from '../working-copy/index.js'
import type { createReaderContexts } from './reader-contexts.js'
import { textNavigationTargetSchema, type AgentNavigationRequest, type TextNavigationTarget } from '../../contracts/navigation.js'
import { evidenceSha256 } from '../evidence/index.js'

const id = z.string().min(1).max(512)
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('wait'), sessionId: id, tabId: id, leaseId: id,
    documentId: id, contentVersion: id }).strict(),
  z.object({ action: z.literal('watch-request'), sessionId: id, tabId: id, leaseId: id,
    documentId: id, contentVersion: id, requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('complete'), sessionId: id, tabId: id, leaseId: id,
    documentId: id, contentVersion: id, requestId: z.string().uuid(),
    targetRevision: z.number().int().nonnegative().optional(),
    sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    status: z.enum(['opened', 'stale', 'unavailable']) }).strict(),
])

type Contexts = Pick<ReturnType<typeof createReaderContexts>, 'current' | 'hasLease'>
type Pending = AgentNavigationRequest & { sessionId: string; tabId: string; leaseId: string;
  settle(status: 'opened' | 'stale' | 'unavailable'): void }

/** Volatile, session-fenced handoff from an agent tool to one visible Reader. */
export function createAgentNavigation(workspaces: WorkingCopyReadPort, contexts: Contexts,
  timeoutMs = 35_000) {
  const pending = new Map<string, Pending>()
  const listeners = new Map<string, Set<() => void>>()
  let disposed = false
  const key = (sessionId: string, tabId: string) => `${sessionId.length}:${sessionId}${tabId}`
  const notify = (target: string) => listeners.get(target)?.forEach(listener => listener())
  function targetCurrent(sessionId: string, entry: Pick<Pending, 'documentId' | 'contentVersion' | 'target'>): boolean {
    try {
      const current = workspaces.readSnapshot(sessionId, entry.documentId)
      return current.contentVersion === entry.contentVersion && (!entry.target
        || current.revision === entry.target.revision && evidenceSha256(current.bytes) === entry.target.sourceDigest && !current.conflict)
    } catch { return false }
  }

  async function navigate(sessionId: string, input: {
    documentId: string; page: number; contentVersion: string; tabId?: string; target?: TextNavigationTarget
  }, signal: AbortSignal) {
    signal.throwIfAborted()
    if (disposed) throw new Error('PDF navigation has stopped')
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    if (snapshot.contentVersion !== input.contentVersion) {
      throw Object.assign(new Error('PDF content changed; locate the evidence again'), { code: 'pdf/stale-reader' })
    }
    if (input.page < 1 || input.page > snapshot.document.pageCount) {
      throw Object.assign(new Error('Page is outside the PDF'), { code: 'pdf/invalid-page' })
    }
    const verifiedTarget = input.target === undefined ? undefined : textNavigationTargetSchema.parse(input.target)
    if (verifiedTarget && !targetCurrent(sessionId, { ...input, target: verifiedTarget })) {
      throw Object.assign(new Error('PDF changed after resolving the evidence; locate it again'), { code: 'pdf/stale-reader' })
    }
    const matches = contexts.current(sessionId).filter(item => item.documentId === input.documentId
      && item.contentVersion === input.contentVersion && (!input.tabId || item.tabId === input.tabId))
    if (!matches.length) return { status: 'unavailable' as const, reason: 'No matching PDF Reader is visible',
      requestId: null, page: input.page, tabIds: [] as string[] }
    if (matches.length > 1) return { status: 'ambiguous' as const,
      tabIds: matches.map(item => item.tabId), reason: 'Choose a Reader tabId from pdf_current',
      requestId: null, page: input.page }
    const tabId = matches[0]!.tabId
    const target = key(sessionId, tabId)
    if (pending.has(target)) return { status: 'busy' as const, reason: 'A navigation is already pending for this Reader',
      requestId: null, page: input.page, tabIds: [] as string[] }
    const requestId = randomUUID()
    return await new Promise<{ status: 'opened' | 'stale' | 'unavailable'; requestId: string; page: number;
      reason: null; tabIds: string[] }>((resolve, reject) => {
      let settled = false
      const finish = (status: 'opened' | 'stale' | 'unavailable') => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', aborted)
        if (pending.get(target) === entry) pending.delete(target)
        notify(target)
        resolve({ status, requestId, page: input.page, reason: null, tabIds: [] })
      }
      const aborted = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (pending.get(target) === entry) pending.delete(target)
        notify(target)
        reject(signal.reason ?? new Error('PDF navigation cancelled'))
      }
      const timer = setTimeout(() => finish('unavailable'), timeoutMs)
      const entry: Pending = { sessionId, tabId, leaseId: '', documentId: input.documentId,
        contentVersion: input.contentVersion, requestId, page: input.page,
        ...(verifiedTarget ? { target: verifiedTarget } : {}), settle: finish }
      pending.set(target, entry)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) { aborted(); return }
      notify(target)
    })
  }

  async function dispatch(sessionId: string, raw: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted()
    const input = request.parse(raw)
    if (input.sessionId !== sessionId) {
      throw Object.assign(new Error('Session identity mismatch'), { code: 'pdf/session-mismatch' })
    }
    const target = key(sessionId, input.tabId)
    if (input.action === 'complete') {
      const entry = pending.get(target)
      if (!entry || entry.requestId !== input.requestId || entry.leaseId !== input.leaseId
        || entry.documentId !== input.documentId || entry.contentVersion !== input.contentVersion) {
        return { accepted: false }
      }
      if (entry.target && input.status === 'opened'
        && (input.targetRevision !== entry.target.revision || input.sourceDigest !== entry.target.sourceDigest)) {
        return { accepted: false }
      }
      const current = contexts.hasLease(sessionId, input.tabId, input.leaseId, input.documentId, input.contentVersion)
        && targetCurrent(sessionId, entry)
      entry.settle(input.status === 'opened' && !current ? 'stale' : input.status)
      return { accepted: true }
    }
    if (input.action === 'watch-request') {
      const stillActive = () => {
        const entry = pending.get(target)
        return !disposed && entry?.requestId === input.requestId && entry.leaseId === input.leaseId
          && entry.documentId === input.documentId && entry.contentVersion === input.contentVersion
          && contexts.hasLease(sessionId, input.tabId, input.leaseId, input.documentId, input.contentVersion)
          && targetCurrent(sessionId, entry)
      }
      if (!stillActive()) return { active: false }
      await waitForChange(target, signal)
      return { active: stillActive() }
    }
    if (disposed) return null
    if (!contexts.hasLease(sessionId, input.tabId, input.leaseId, input.documentId, input.contentVersion)
      || workspaces.readSnapshot(sessionId, input.documentId).contentVersion !== input.contentVersion) {
      throw Object.assign(new Error('PDF Reader lease is no longer active'), { code: 'pdf/stale-reader' })
    }
    const active = () => {
      const entry = pending.get(target)
      if (!entry || entry.documentId !== input.documentId || entry.contentVersion !== input.contentVersion) return null
      if (entry.leaseId && entry.leaseId !== input.leaseId) return null
      if (!targetCurrent(sessionId, entry)) { entry.settle('stale'); return null }
      entry.leaseId = input.leaseId
      const { requestId, page, documentId, contentVersion, target: textTarget } = entry
      return { requestId, page, documentId, contentVersion,
        ...(textTarget ? { target: textTarget } : {}) } satisfies AgentNavigationRequest
    }
    let value = active()
    if (value) return value
    await waitForChange(target, signal)
    value = contexts.hasLease(sessionId, input.tabId, input.leaseId, input.documentId, input.contentVersion)
      ? active() : null
    return value
  }

  function waitForChange(target: string, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const wake = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(signal.reason ?? new Error('PDF navigation wait cancelled')) }
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        const set = listeners.get(target)
        set?.delete(wake)
        if (!set?.size) listeners.delete(target)
      }
      const timer = setTimeout(wake, 20_000)
      const set = listeners.get(target) ?? new Set<() => void>()
      set.add(wake)
      listeners.set(target, set)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
    })
  }

  return { navigate, dispatch, dispose() {
    disposed = true
    for (const entry of pending.values()) entry.settle('unavailable')
    pending.clear()
    for (const wake of listeners.values()) wake.forEach(listener => listener())
    listeners.clear()
  } }
}
