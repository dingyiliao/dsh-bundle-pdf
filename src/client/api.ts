import { z } from 'zod'
import type { PdfClientApi, WorkspaceSnapshot } from '../shared/contracts.ts'
import { sessionFile } from '../shared/address.ts'

export interface PdfConnection {
  rpc: { call(path: string, method: string, payload: object, signal?: AbortSignal): Promise<unknown> }
}
const rect = z.tuple([z.number(), z.number(), z.number(), z.number()])
const color = z.tuple([z.number(), z.number(), z.number()])
const wireSnapshot = z.object({
  id: z.string(), path: z.string(), sourceVersion: z.string(), contentVersion: z.string(),
  revision: z.number().int(), dirty: z.boolean(), canUndo: z.boolean(), canRedo: z.boolean(), conflict: z.boolean(),
  warning: z.string().optional(), bytes: z.string().optional(), bytesHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  document: z.object({
    pageCount: z.number().int().positive(), title: z.string().optional(), signed: z.boolean(), encrypted: z.boolean(),
    readOnly: z.boolean(), readOnlyReason: z.string().optional(),
    pages: z.array(z.object({ page: z.number().int(), mediaBox: rect.optional(), cropBox: rect, rotation: z.number(), userUnit: z.number() })),
    annotations: z.array(z.object({
      id: z.string(), page: z.number().int(), subtype: z.string(), rect: rect.optional(), quadPoints: z.array(z.number()).optional(),
      color: color.optional(), opacity: z.number().optional(), contents: z.string().optional(), author: z.string().optional(),
      createdAt: z.string().optional(), modifiedAt: z.string().optional(), flags: z.number(),
      supported: z.boolean(), editable: z.boolean(), readOnlyReason: z.string().optional(),
    })),
  }).optional(),
})
const response = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
])

export function createPdfApi(connection: PdfConnection, lifetime: AbortSignal): PdfClientApi {
  const listeners = new Map<string, Set<(snapshot: WorkspaceSnapshot) => void>>()
  const latest = new Map<string, WorkspaceSnapshot>()
  const byteIdentities = new Map<string, string>()
  lifetime.addEventListener('abort', () => { listeners.clear(); latest.clear(); byteIdentities.clear() }, { once: true })
  const call = async (payload: object, signal?: AbortSignal) => {
    const result = response.parse(await connection.rpc.call('/api', 'pdf.dispatch', payload,
      signal ? AbortSignal.any([signal, lifetime]) : lifetime))
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  const snapshot = async (payload: object, signal?: AbortSignal): Promise<WorkspaceSnapshot> => {
    const requestedId = 'id' in payload && typeof payload.id === 'string' ? payload.id : undefined
    const retained = requestedId ? latest.get(requestedId) : undefined
    const knownBytesHash = requestedId && retained ? byteIdentities.get(requestedId) : undefined
    const wire = wireSnapshot.parse(await call({ ...payload, ...(knownBytesHash?.startsWith('sha256:') ? { knownBytesHash } : {}) }, signal))
    lifetime.throwIfAborted(); signal?.throwIfAborted()
    const previous = latest.get(wire.id) ?? (wire.id === requestedId ? retained : undefined)
    if (previous && previous.revision > wire.revision) return previous
    // Save/status changes retain their bytes, so the reader keeps its worker,
    // canvases and text layers instead of opening the same document again.
    let bytes: Uint8Array
    const identity = wire.bytesHash ?? wire.bytes
    const previousIdentity = previous === retained ? knownBytesHash : byteIdentities.get(wire.id)
    if (previous && identity && previousIdentity === identity) bytes = previous.bytes
    else {
      if (wire.bytes === undefined) throw new Error('PDF bytes changed without an available byte snapshot; reopen the PDF')
      const binary = atob(wire.bytes)
      bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    }
    const document = previous && previousIdentity === identity ? previous.document
      : wire.document && previous?.contentVersion === wire.contentVersion ? { ...wire.document, pages: previous.document.pages } : wire.document
    if (!document) throw new Error('PDF metadata snapshot is unavailable; reopen the PDF')
    const value: WorkspaceSnapshot = { ...wire, document, bytes }
    if (identity) byteIdentities.set(value.id, identity)
    latest.set(value.id, value)
    for (const listener of listeners.get(value.id) ?? []) listener(value)
    return value
  }
  return {
    open(sessionId, address, signal) {
      const addressed = sessionFile(address)
      if (addressed.sessionId !== sessionId) return Promise.reject(new Error('The PDF address belongs to another session'))
      return snapshot({ action: 'open', sessionId, address }, signal)
    },
    change: (sessionId, id, revision, operations, signal) => snapshot({ action: 'change', sessionId, id, revision, operations }, signal),
    undo: (sessionId, id, revision, signal) => snapshot({ action: 'undo', sessionId, id, revision }, signal),
    redo: (sessionId, id, revision, signal) => snapshot({ action: 'redo', sessionId, id, revision }, signal),
    reload: (sessionId, id, revision, signal) => snapshot({ action: 'reload', sessionId, id, revision }, signal),
    discard: (sessionId, id, revision, signal) => snapshot({ action: 'discard', sessionId, id, revision }, signal),
    async discardMany(sessionId, ids, signal) {
      const value = z.object({ discarded: z.array(z.string()) }).parse(await call({ action: 'discardMany', sessionId, ids }, signal))
      for (const id of value.discarded) { latest.delete(id); byteIdentities.delete(id); listeners.delete(id) }
    },
    async discardAddresses(sessionId, addresses, signal) {
      const value = z.object({ discarded: z.array(z.string()) }).parse(await call({ action: 'discardAddresses', sessionId, addresses }, signal))
      for (const id of value.discarded) { latest.delete(id); byteIdentities.delete(id); listeners.delete(id) }
    },
    save: (sessionId, id, revision, options, signal) => snapshot({ action: 'save', sessionId, id, revision, options }, signal),
    inspectTarget: async (sessionId, path, signal) => z.object({ version: z.string().nullable() }).parse(await call({ action: 'inspectTarget', sessionId, path }, signal)),
    subscribe(id, callback) {
      let set = listeners.get(id)
      if (!set) { set = new Set(); listeners.set(id, set) }
      set.add(callback)
      return () => { set.delete(callback); if (!set.size) { listeners.delete(id); latest.delete(id); byteIdentities.delete(id) } }
    },
  }
}
