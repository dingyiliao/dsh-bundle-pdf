import { z } from 'zod'
import { agentNavigationRequestSchema } from '../../../contracts/navigation.js'
import { PDF_ENDPOINT, readingPositionSchema, responseSchema, wireSnapshotSchema } from '../../../contracts/rpc/index.ts'
import type { PdfReadingPosition, PdfClientApi, PdfStoredReadingPosition, WorkspaceSnapshot } from '../../../shared/contracts.ts'
import { sessionFile } from '../../../shared/address.ts'
import { measurePdfAsync } from '../../../shared/performance.ts'
import type { NativeOutlineItem, NativeReaderApi, NativeTextContent } from '../../../shared/native.ts'
import type { PdfReadingContextUpdate, PdfAgentNavigationApi } from '../../../modules/viewer/index.js'

export type { PdfReadingContextUpdate } from '../../../modules/viewer/index.js'

export interface PdfConnection {
  rpc: { call(path: string, method: string, payload: object, signal?: AbortSignal): Promise<unknown> }
}
// A wall-clock prefix survives Client hot reload; the local increment orders
// rapid page changes, hides and remounts across every Reader instance.
let lastReadingContextSequence = Date.now() * 1000
function nextReadingContextSequence(): number {
  lastReadingContextSequence = Math.max(lastReadingContextSequence + 1, Date.now() * 1000)
  return lastReadingContextSequence
}

/** Publish only transient PDF identity/page metadata through the authenticated RPC. */
export function createReadingContextReporter(connection: PdfConnection, lifetime: AbortSignal):
  (update: PdfReadingContextUpdate) => Promise<void> {
  return async (update) => {
    lifetime.throwIfAborted()
    const result = responseSchema.parse(await connection.rpc.call('/api', 'pdf.readercontext',
      { ...update, sequence: nextReadingContextSequence() }, lifetime))
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
  }
}

/** Poll only while a visible Reader holds its short-lived reading-context lease. */
export function createPdfAgentNavigationApi(connection: PdfConnection, lifetime: AbortSignal): PdfAgentNavigationApi {
  const call = async (payload: object, signal: AbortSignal) => {
    const reply = responseSchema.parse(await connection.rpc.call('/api', 'pdf.navigation', payload,
      AbortSignal.any([signal, lifetime])))
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
    return reply.value
  }
  return {
    async wait(context, signal) {
      return agentNavigationRequestSchema.nullable().parse(await call({ action: 'wait', ...context }, signal))
    },
    async watchRequest(context, signal) {
      return z.object({ active: z.boolean() }).strict().parse(await call({ action: 'watch-request', ...context }, signal))
    },
    async complete(context, signal) {
      z.object({ accepted: z.boolean() }).parse(await call({ action: 'complete', ...context }, signal))
    },
  }
}

const readingPositionStale = z.enum(['none', 'content-changed', 'page-missing'])

export function createPdfApi(connection: PdfConnection, lifetime: AbortSignal): PdfClientApi {
  const listeners = new Map<string, Set<(snapshot: WorkspaceSnapshot) => void>>()
  const latest = new Map<string, WorkspaceSnapshot>()
  const sourceAddresses = new Map<string, { sessionId: string; address: string; references: Set<string> }>()
  const closedReferences = new Set<string>()
  const referenceKey = (sessionId: string, referenceId: string) => JSON.stringify([sessionId, referenceId])
  const watches = new Map<string, AbortController>()
  lifetime.addEventListener('abort', () => {
    for (const watch of watches.values()) watch.abort()
    watches.clear(); sourceAddresses.clear(); listeners.clear(); latest.clear()
  }, { once: true })
  const call = async (payload: object, signal?: AbortSignal, endpoint = PDF_ENDPOINT) => {
    const result = responseSchema.parse(await measurePdfAsync('client.rpc', {}, () => connection.rpc.call('/api', endpoint, payload,
      signal ? AbortSignal.any([signal, lifetime]) : lifetime)))
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value
  }
  const releaseCall = async (payload: object, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted()
    // Client-only HMR aborts ordinary requests, but must still release Host
    // references. Never let an unavailable or noncompliant carrier stall exit.
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    const timer = setTimeout(() => controller.abort(new DOMException('PDF reference cleanup timed out', 'TimeoutError')), 5000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let stop!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(controller.signal.reason)
      if (controller.signal.aborted) stop()
      else controller.signal.addEventListener('abort', stop, { once: true })
    })
    try {
      const result = responseSchema.parse(await Promise.race([
        Promise.resolve().then(() => connection.rpc.call('/api', PDF_ENDPOINT, payload, controller.signal)), cancelled,
      ]))
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', stop)
    }
  }
  const snapshot = async (payload: object, signal?: AbortSignal): Promise<WorkspaceSnapshot> => {
    const requestedId = 'id' in payload && typeof payload.id === 'string' ? payload.id : undefined
    const retained = requestedId ? latest.get(requestedId) : undefined
    const request = { ...payload, ...(retained ? { knownBytesHash: retained.reader.bytesHash, knownRevision: retained.revision } : {}),
      ...('action' in payload && ['change', 'undo', 'redo', 'save', 'reload', 'discard'].includes(String(payload.action)) ? { mutationId: crypto.randomUUID() } : {}) }
    let reply: unknown
    try { reply = await call(request, signal) } catch (error) {
      // Retry a lost transport reply with the same mutation identity, once.
      if (!('mutationId' in request) || lifetime.aborted || signal?.aborted || error instanceof Error && 'code' in error) throw error
      reply = await call(request, signal)
    }
    const wire = wireSnapshotSchema.parse(reply)
    lifetime.throwIfAborted(); signal?.throwIfAborted()
    const previous = latest.get(wire.id) ?? (wire.id === requestedId ? retained : undefined)
    if (previous && previous.revision > wire.revision) return previous
    // Annotation operations can change the projected metadata while retaining the
    // same native document. Never discard fresh metadata from the Host.
    let document = wire.document
      ? previous?.contentVersion === wire.contentVersion ? { ...wire.document, pages: previous.document.pages } : wire.document
      : previous && previous.reader.bytesHash === wire.reader.bytesHash ? previous.document : undefined
    if (!document) throw new Error('PDF metadata snapshot is unavailable; reopen the PDF')
    if (wire.annotationDelta) {
      if (!previous || wire.annotationDelta.fromRevision !== previous.revision) throw new Error('PDF annotation delta baseline is unavailable; reopen the PDF')
      const annotations = new Map(previous.document.annotations.map(annotation => [annotation.id, annotation]))
      for (const key of wire.annotationDelta.remove) annotations.delete(key)
      for (const annotation of wire.annotationDelta.upsert) annotations.set(annotation.id, annotation)
      document = { ...document, annotations: [...annotations.values()] }
    }
    const value: WorkspaceSnapshot = { ...wire, document }
    if (!wire.baselineAnnotations && previous && previous.reader.bytesHash === wire.reader.bytesHash) value.baselineAnnotations = previous.baselineAnnotations
    if (!wire.baselineOutline && previous && previous.reader.bytesHash === wire.reader.bytesHash) value.baselineOutline = previous.baselineOutline
    if (!wire.baselineFormFields && previous && previous.reader.bytesHash === wire.reader.bytesHash) value.baselineFormFields = previous.baselineFormFields
    latest.set(value.id, value)
    for (const listener of listeners.get(value.id) ?? []) listener(value)
    return value
  }
  const watch = (id: string) => {
    if (watches.get(id)?.signal.aborted === false || !sourceAddresses.has(id) || lifetime.aborted) return
    const controller = new AbortController()
    watches.set(id, controller)
    void (async () => {
      while (!controller.signal.aborted && !lifetime.aborted && listeners.has(id)) {
        const address = sourceAddresses.get(id)
        const knownRevision = latest.get(id)?.revision
        if (!address || knownRevision === undefined) break
        try {
          const started = Date.now()
          const update = z.object({ revision: z.number().int().nonnegative() }).parse(await call({
            sessionId: address.sessionId, id, knownRevision,
          }, controller.signal, 'pdf.watch'))
          if (controller.signal.aborted || lifetime.aborted) break
          if (update.revision !== latest.get(id)?.revision) {
            // A watch refresh reads the existing draft. It must not acquire a
            // new UI reference after the last tab has begun releasing its view.
            await snapshot({ action: 'refresh', sessionId: address.sessionId, id }, controller.signal)
          } else if (Date.now() - started < 250) {
            // Protect against a misconfigured endpoint returning immediately.
            await new Promise<void>(resolve => setTimeout(resolve, 250))
          }
        } catch (error) {
          if (controller.signal.aborted || lifetime.aborted) break
          // Connection can restart independently of a mounted Reader. Retry
          // quietly; the next successful watch compares with the Host revision.
          await new Promise<void>(resolve => setTimeout(resolve, 1000))
        }
      }
      if (watches.get(id) === controller) watches.delete(id)
    })()
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
        width: z.number().finite(), height: z.number().finite(), dir: z.string(), fontName: z.string(), hasEOL: z.boolean(),
        glyphs: z.array(z.tuple([z.number().finite(), z.number().finite(), z.number().finite().positive()])).max(200000).optional() })).max(10000),
        styles: z.record(z.string(), z.object({ fontFamily: z.string(), ascent: z.number(), descent: z.number(), vertical: z.boolean() })),
        lang: z.string().nullable() }).parse(result) as NativeTextContent
    },
    async links(sessionId, id, reader, page, signal) { return z.array(z.unknown()).max(10000).parse(await call({ action: 'links', sessionId, id, bytesHash: reader.bytesHash, page }, signal, 'pdf.native')) },
    async outline(sessionId, id, reader, signal) {
      const item: z.ZodType<NativeOutlineItem> = z.lazy(() => z.object({ id: z.string().max(512).optional(), title: z.string().max(8191), dest: z.unknown().optional(),
        url: z.string().max(32768).optional(), items: z.array(item).max(5000) }))
      return z.array(item).max(5000).nullable().parse(await call({ action: 'outline', sessionId, id, bytesHash: reader.bytesHash }, signal, 'pdf.native'))
    },
    destination: (sessionId, id, reader, name, signal) => call({ action: 'destination', sessionId, id, bytesHash: reader.bytesHash, name }, signal, 'pdf.native'),
  }
  const positions = {
    get: async (sessionId: string, id: string, signal?: AbortSignal): Promise<PdfStoredReadingPosition | null> =>
      z.object({ position: z.object({ position: readingPositionSchema, stale: readingPositionStale,
        updatedAt: z.string() }).strict().nullable() }).parse(
        await call({ action: 'get', sessionId, id }, signal, 'pdf.position')).position,
    async set(sessionId: string, id: string, position: PdfReadingPosition, signal?: AbortSignal): Promise<void> {
      // The wire shape rejects `documentVersion`, so a full navigation position
      // cannot be stored by accident.
      z.object({ stored: z.literal(true) }).parse(await call({ action: 'set', sessionId, id, position }, signal, 'pdf.position'))
    },
  }
  return {
    native, positions,
    async open(sessionId, address, signal, referenceId) {
      const addressed = sessionFile(address)
      if (addressed.sessionId !== sessionId) throw new Error('The PDF address belongs to another session')
      if (referenceId && closedReferences.has(referenceKey(sessionId, referenceId))) throw new DOMException('PDF view reference has closed', 'AbortError')
      const value = await snapshot({ action: 'open', sessionId, address, ...(referenceId ? { referenceId } : {}) }, signal)
      if (referenceId && closedReferences.has(referenceKey(sessionId, referenceId))) {
        if (!sourceAddresses.has(value.id)) latest.delete(value.id)
        throw new DOMException('PDF view reference has closed', 'AbortError')
      }
      const source = sourceAddresses.get(value.id) ?? { sessionId, address, references: new Set<string>() }
      source.references.add(referenceId ?? 'legacy')
      sourceAddresses.set(value.id, source)
      return value
    },
    async release(sessionId, id, referenceId, signal) {
      if (id === undefined) closedReferences.add(referenceKey(sessionId, referenceId))
      for (const [documentId, source] of sourceAddresses) {
        if (source.sessionId !== sessionId || id !== undefined && documentId !== id) continue
        source.references.delete(referenceId)
        if (!source.references.size) {
          watches.get(documentId)?.abort()
          sourceAddresses.delete(documentId); latest.delete(documentId); listeners.delete(documentId)
        }
      }
      await releaseCall({ action: 'release', sessionId, ...(id === undefined ? {} : { id }), referenceId }, signal)
    },
    change: (sessionId, id, revision, operations, signal) => snapshot({ action: 'change', sessionId, id, revision, operations }, signal),
    undo: (sessionId, id, revision, signal) => snapshot({ action: 'undo', sessionId, id, revision }, signal),
    redo: (sessionId, id, revision, signal) => snapshot({ action: 'redo', sessionId, id, revision }, signal),
    reload: (sessionId, id, revision, signal) => snapshot({ action: 'reload', sessionId, id, revision }, signal),
    discard: (sessionId, id, revision, signal) => snapshot({ action: 'discard', sessionId, id, revision }, signal),
    async discardMany(sessionId, ids, signal) {
      const value = z.object({ discarded: z.array(z.string()) }).parse(await call({ action: 'discardMany', sessionId, ids }, signal))
      for (const id of value.discarded) { watches.get(id)?.abort(); sourceAddresses.delete(id); latest.delete(id); listeners.delete(id) }
    },
    async discardAddresses(sessionId, addresses, signal) {
      const value = z.object({ discarded: z.array(z.string()) }).parse(await call({ action: 'discardAddresses', sessionId, addresses }, signal))
      for (const id of value.discarded) { watches.get(id)?.abort(); sourceAddresses.delete(id); latest.delete(id); listeners.delete(id) }
    },
    save: (sessionId, id, revision, options, signal) => snapshot({ action: 'save', sessionId, id, revision, options }, signal),
    inspectTarget: async (sessionId, path, signal) => z.object({ version: z.string().nullable() }).parse(await call({ action: 'inspectTarget', sessionId, path }, signal)),
    subscribe(id, callback) {
      let set = listeners.get(id)
      if (!set) { set = new Set(); listeners.set(id, set) }
      set.add(callback)
      watch(id)
      return () => {
        set.delete(callback)
        if (!set.size && listeners.get(id) === set) {
          watches.get(id)?.abort(); listeners.delete(id); latest.delete(id)
          // A hidden React body is not a closed tab occurrence. Keep the
          // reference inventory until lifecycle.release() ends that view.
        }
      }
    },
  }
}
