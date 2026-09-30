import { z } from 'zod'
import type { PdfClientApi, WorkspaceSnapshot } from '../shared/contracts.ts'
import { sessionFile } from '../shared/address.ts'
import { measurePdfAsync } from '../shared/performance.ts'
import type { NativeReaderApi, NativeTextContent } from '../shared/native.ts'

export interface PdfConnection {
  rpc: { call(path: string, method: string, payload: object, signal?: AbortSignal): Promise<unknown> }
}
const rect = z.tuple([z.number(), z.number(), z.number(), z.number()])
const color = z.tuple([z.number(), z.number(), z.number()])
const wireAnnotation = z.object({
  sourceObjectId: z.string().optional(), popupObjectId: z.string().optional(),
  linkAction: z.string().optional(),
  id: z.string(), page: z.number().int(), subtype: z.string(), rect: rect.optional(), quadPoints: z.array(z.number()).optional(),
  color: color.optional(), opacity: z.number().optional(), contents: z.string().optional(), author: z.string().optional(),
  createdAt: z.string().optional(), modifiedAt: z.string().optional(), flags: z.number(),
  supported: z.boolean(), editable: z.boolean(), readOnlyReason: z.string().optional(),
})
const wireSnapshot = z.object({
  id: z.string(), path: z.string(), sourceVersion: z.string(), contentVersion: z.string(),
  revision: z.number().int(), dirty: z.boolean(), canUndo: z.boolean(), canRedo: z.boolean(), conflict: z.boolean(),
  warning: z.string().optional(), bytes: z.instanceof(Uint8Array).optional(), bytesHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  reader: z.object({ engine: z.enum(['native', 'pdfjs']), bytesHash: z.string(), generation: z.number().int(),
    protocolVersion: z.literal(1), fallbackReason: z.string().optional() }).optional(),
  annotationDelta: z.object({ fromRevision: z.number().int(), remove: z.array(z.string()), upsert: z.array(wireAnnotation) }).optional(),
  baselineAnnotations: z.array(wireAnnotation).optional(),
  document: z.object({
    pageCount: z.number().int().positive(), title: z.string().optional(), signed: z.boolean(), encrypted: z.boolean(),
    readOnly: z.boolean(), readOnlyReason: z.string().optional(),
    pages: z.array(z.object({ page: z.number().int(), mediaBox: rect.optional(), cropBox: rect, rotation: z.number(), userUnit: z.number() })),
    annotations: z.array(wireAnnotation),
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
  const call = async (payload: object, signal?: AbortSignal, endpoint = 'pdf.dispatch.v2') => {
    const result = response.parse(await measurePdfAsync('client.rpc', {}, () => connection.rpc.call('/api', endpoint, payload,
      signal ? AbortSignal.any([signal, lifetime]) : lifetime)))
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  const snapshot = async (payload: object, signal?: AbortSignal): Promise<WorkspaceSnapshot> => {
    const requestedId = 'id' in payload && typeof payload.id === 'string' ? payload.id : undefined
    const retained = requestedId ? latest.get(requestedId) : undefined
    const knownBytesHash = requestedId && retained ? byteIdentities.get(requestedId) : undefined
    const request = { ...payload, ...(knownBytesHash?.startsWith('sha256:') ? { knownBytesHash } : {}),
      ...(retained ? { knownRevision: retained.revision, knownReaderEngine: retained.reader?.engine } : {}),
      ...('action' in payload && ['change', 'undo', 'redo', 'save', 'reload', 'discard'].includes(String(payload.action)) ? { mutationId: crypto.randomUUID() } : {}) }
    let reply: unknown
    try { reply = await call(request, signal) } catch (error) {
      // Retry a lost transport reply with the same mutation identity, once.
      if (!('mutationId' in request) || lifetime.aborted || signal?.aborted || error instanceof Error && 'code' in error) throw error
      reply = await call(request, signal)
    }
    const wire = wireSnapshot.parse(reply)
    lifetime.throwIfAborted(); signal?.throwIfAborted()
    const previous = latest.get(wire.id) ?? (wire.id === requestedId ? retained : undefined)
    if (previous && previous.revision > wire.revision) return previous
    // Save/status changes retain their bytes, so the reader keeps its worker,
    // canvases and text layers instead of opening the same document again.
    let bytes: Uint8Array
    const identity = wire.bytesHash
    const previousIdentity = previous === retained ? knownBytesHash : byteIdentities.get(wire.id)
    if (previous && identity && previousIdentity === identity && previous.reader?.engine === wire.reader?.engine) bytes = previous.bytes
    else if (wire.reader?.engine === 'native') bytes = new Uint8Array()
    else if (wire.bytes instanceof Uint8Array) bytes = wire.bytes
    else throw new Error('PDF bytes changed without an available byte snapshot; reopen the PDF')
    // Annotation operations can change the projected metadata while retaining the
    // original PDF bytes. Reuse the byte array, but never discard fresh metadata.
    let document = wire.document
      ? previous?.contentVersion === wire.contentVersion ? { ...wire.document, pages: previous.document.pages } : wire.document
      : previous && previousIdentity === identity ? previous.document : undefined
    if (!document) throw new Error('PDF metadata snapshot is unavailable; reopen the PDF')
    if (wire.annotationDelta) {
      if (!previous || wire.annotationDelta.fromRevision !== previous.revision) throw new Error('PDF annotation delta baseline is unavailable; reopen the PDF')
      const annotations = new Map(previous.document.annotations.map(annotation => [annotation.id, annotation]))
      for (const key of wire.annotationDelta.remove) annotations.delete(key)
      for (const annotation of wire.annotationDelta.upsert) annotations.set(annotation.id, annotation)
      document = { ...document, annotations: [...annotations.values()] }
    }
    const value: WorkspaceSnapshot = { ...wire, document, bytes }
    if (!wire.baselineAnnotations && previous && previousIdentity === identity) value.baselineAnnotations = previous.baselineAnnotations
    if (identity) byteIdentities.set(value.id, identity)
    latest.set(value.id, value)
    for (const listener of listeners.get(value.id) ?? []) listener(value)
    return value
  }
  const native: NativeReaderApi = {
    async tile(sessionId, id, reader, tile, signal) {
      return z.object({ width: z.number().int().min(1).max(1026), height: z.number().int().min(1).max(1026),
        mime: z.literal('image/png'), bytes: z.instanceof(Uint8Array) }).parse(await call({ action: 'tile', sessionId, id, bytesHash: reader.bytesHash, tile }, signal, 'pdf.native'))
    },
    async text(sessionId, id, reader, page, signal) {
      const result = await call({ action: 'text', sessionId, id, bytesHash: reader.bytesHash, page }, signal, 'pdf.native')
      // The subprocess and Host enforce the detailed run and character budgets.
      return z.object({ items: z.array(z.object({ str: z.string(), transform: z.array(z.number().finite()).length(6),
        width: z.number().finite(), height: z.number().finite(), dir: z.string(), fontName: z.string(), hasEOL: z.boolean() })).max(10000),
        styles: z.record(z.string(), z.object({ fontFamily: z.string(), ascent: z.number(), descent: z.number(), vertical: z.boolean() })),
        lang: z.string().nullable() }).parse(result) as NativeTextContent
    },
    async links(sessionId, id, reader, page, signal) { return z.array(z.unknown()).max(10000).parse(await call({ action: 'links', sessionId, id, bytesHash: reader.bytesHash, page }, signal, 'pdf.native')) },
    destination: (sessionId, id, reader, name, signal) => call({ action: 'destination', sessionId, id, bytesHash: reader.bytesHash, name }, signal, 'pdf.native'),
  }
  return {
    native,
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
