import { randomUUID } from 'node:crypto'
import type { HostWorkspaceSnapshot, OpenWorkingCopyDocument } from './ports.js'
import type { WorkingCopyState } from './state.js'
import type { BaselineMismatchDecision } from '../../shared/contracts.js'
import type { WorkspaceRecord } from './schema.js'

export interface DocumentReferences {
  ui: Set<string>
  modelReferenceId?: string
  pins: number
  touched: number
}

export interface SuspendedCopy {
  record: WorkspaceRecord
  conflict: boolean
  baselineMismatch?: BaselineMismatchDecision
  warning?: string
  indexContentDigest?: string
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

/** Owns logical working-copy identity, owners, credentials and residency maps. */
export function createWorkingCopyRegistry() {
  const copies = new Map<string, WorkingCopyState>()
  const suspended = new Map<string, SuspendedCopy>()
  const byPath = new Map<string, string>()
  const references = new Map<string, DocumentReferences>()
  const passwords = new Map<string, string>()
  const temporaryBaselines = new Set<string>()
  const releasedReferences = new Set<string>()
  const revisionListeners = new Map<string, Set<() => void>>()
  const idleListeners = new Set<(sessionId: string, id: string) => void>()
  const documentListeners = new Set<() => void>()
  const pinWaiters = new Set<() => void>()
  let documentSignature = '[]'

  function recordFor(sessionId: string, id: string): WorkspaceRecord {
    const record = copies.get(id)?.record ?? suspended.get(id)?.record
    if (!record) fail('pdf/unknown-document', 'PDF working copy is unavailable; reopen it')
    if (record.sessionId !== sessionId) fail('pdf/session-mismatch', 'Working copy belongs to another session')
    return record
  }

  function touch(id: string): void { const refs = references.get(id); if (refs) refs.touched = Date.now() }

  function own(id: string, owner: 'ui' | 'agent', referenceId?: string): void {
    let refs = references.get(id)
    if (!refs) { refs = { ui: new Set(), pins: 0, touched: Date.now() }; references.set(id, refs) }
    if (owner === 'ui') refs.ui.add(referenceId ?? 'legacy-ui')
    else refs.modelReferenceId = referenceId ?? randomUUID()
    touch(id)
  }

  function hold(id: string, onRelease: () => void): () => void {
    const refs = references.get(id)
    if (!refs) fail('pdf/unknown-document', 'The PDF is no longer owned by this Reader or model reference')
    refs.pins += 1; touch(id)
    let released = false
    return () => {
      if (released) return
      released = true; refs.pins -= 1; touch(id); onRelease()
      if (![...references.values()].some(value => value.pins)) for (const done of [...pinWaiters]) done()
    }
  }

  function listOpenDocuments(closing: boolean): OpenWorkingCopyDocument[] {
    if (closing) return []
    return [...references].flatMap(([id, refs]) => {
      if (!refs.ui.size && refs.modelReferenceId === undefined) return []
      const active = copies.get(id), dormant = suspended.get(id)
      const record = active?.record ?? dormant?.record
      if (!record) return []
      const indexContentDigest = active?.snapshot.document.indexContentDigest ?? dormant?.indexContentDigest
      return [{ sessionId: record.sessionId, id, path: record.path, contentVersion: record.contentVersion,
        sourceDigest: record.sourceHash, ...(indexContentDigest ? { indexContentDigest } : {}),
        conflict: active?.snapshot.conflict ?? dormant!.conflict,
        title: (record.path.split(/[\\/]/).at(-1) || 'PDF').slice(0, 512) }]
    })
  }

  function notifyDocuments(closing: boolean): void {
    const signature = JSON.stringify(listOpenDocuments(closing))
    if (signature === documentSignature) return
    documentSignature = signature
    for (const listener of [...documentListeners]) {
      try { void Promise.resolve(listener()).catch(() => undefined) }
      catch { /* Passive observers cannot fail a completed document operation. */ }
    }
  }

  return { copies, suspended, byPath, references, passwords, temporaryBaselines, releasedReferences,
    revisionListeners, idleListeners, documentListeners, pinWaiters,
    recordFor, touch, own, hold, listOpenDocuments, notifyDocuments,
    snapshot(id: string): HostWorkspaceSnapshot | undefined { return copies.get(id)?.snapshot },
    listResidency() {
      return [...references.entries()].map(([id, refs]) => {
        const copy = copies.get(id)
        const record = copy?.record ?? suspended.get(id)!.record
        return { sessionId: record.sessionId, id, bytes: copy?.snapshot.bytes.byteLength ?? 0,
          resident: Boolean(copy), touched: refs.touched, uiReferences: refs.ui.size,
          modelOwned: refs.modelReferenceId !== undefined, modelReferenceId: refs.modelReferenceId, pins: refs.pins }
      })
    },
    isUiOwned(sessionId: string, id: string): boolean { recordFor(sessionId, id); return Boolean(references.get(id)?.ui.size) },
    readSnapshot(sessionId: string, id: string): HostWorkspaceSnapshot {
      const copy = copies.get(id)
      if (!copy) { recordFor(sessionId, id); fail('pdf/document-suspended', 'Acquire this PDF working copy before reading its resident snapshot') }
      if (copy.record.sessionId !== sessionId) fail('pdf/session-mismatch', 'Working copy belongs to another session')
      return copy.snapshot
    },
    clear() {
      passwords.clear(); copies.clear(); suspended.clear(); byPath.clear(); references.clear(); releasedReferences.clear()
      revisionListeners.clear(); idleListeners.clear(); documentListeners.clear(); pinWaiters.clear(); temporaryBaselines.clear()
    },
  }
}

export type WorkingCopyRegistry = ReturnType<typeof createWorkingCopyRegistry>
