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
  type Listener = { id: string; callback(snapshot: WorkspaceSnapshot): void }
  const listeners = new Map<string, Set<Listener>>()
  const latest = new Map<string, WorkspaceSnapshot>()
  const sourceAddresses = new Map<string, { sessionId: string; address: string; references: Set<string> }>()
  // A Host restart can give the same visible tab a new working-copy ID.
  // Refresh/release resolve aliases; writes still require the new snapshot ID.
  const replacedIds = new Map<string, string>()
  const recoveries = new Map<string, { controller: AbortController; promise: Promise<WorkspaceSnapshot> }>()
  const failedWatchRecoveries = new Set<string>()
  const closedReferences = new Set<string>()
  const referenceKey = (sessionId: string, referenceId: string) => JSON.stringify([sessionId, referenceId])
  const currentId = (id: string): string => {
    let current = id
    for (let count = 0; count < 32; count++) {
      const next = replacedIds.get(current)
      if (!next || next === current) break
      current = next
    }
    return current
  }
  const watches = new Map<string, AbortController>()
  lifetime.addEventListener('abort', () => {
    for (const watch of watches.values()) watch.abort()
    for (const recovery of recoveries.values()) recovery.controller.abort()
    watches.clear(); recoveries.clear(); failedWatchRecoveries.clear(); replacedIds.clear()
    sourceAddresses.clear(); listeners.clear(); latest.clear()
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
  const snapshot = async (payload: object, signal?: AbortSignal,
    beforePublish?: (snapshot: WorkspaceSnapshot) => void): Promise<WorkspaceSnapshot> => {
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
    // An explicit unlock may be the first acquisition after a Host restart;
    // an old in-memory revision must not suppress its fresh native baseline.
    const previous = 'action' in payload && payload.action === 'unlock' ? undefined
      : latest.get(wire.id) ?? (wire.id === requestedId ? retained : undefined)
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
    beforePublish?.(value)
    latest.set(value.id, value)
    for (const listener of listeners.get(value.id) ?? []) listener.callback(value)
    return value
  }
  const unknownDocument = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'pdf/unknown-document'
  const transportFailure = (error: unknown) => error instanceof Error && !('code' in error)
    && !['AbortError', 'TimeoutError', 'ZodError'].includes(error.name)
  const viewEnded = () => new DOMException('PDF view reference has closed', 'AbortError')
  const invalidRecovery = (message: string) => Object.assign(new Error(message), { code: 'pdf/recovery-integrity' })
  const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
    if (signal.aborted) return resolve()
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
  const recoveryEligible = (id: string, source: { sessionId: string; address: string; references: Set<string> },
    references: readonly string[]): boolean => !lifetime.aborted && sourceAddresses.get(id) === source
      && !!listeners.get(id)?.size && references.length > 0
      && references.length === source.references.size && references.every(referenceId =>
        source.references.has(referenceId) && !closedReferences.has(referenceKey(source.sessionId, referenceId)))

  /** A lost Host ID is explicit evidence to reacquire, not permission to retry arbitrary errors. */
  const reacquire = (id: string): Promise<WorkspaceSnapshot> => {
    const existing = recoveries.get(id)
    if (existing) return existing.promise
    const source = sourceAddresses.get(id)
    const references = [...source?.references ?? []]
    if (!source || !recoveryEligible(id, source, references)) return Promise.reject(viewEnded())
    const controller = new AbortController()
    const acquired: Array<{ id: string; referenceId: string }> = []
    const promise = (async () => {
      try {
        let value: WorkspaceSnapshot | undefined
        const previous = latest.get(id)
        for (const referenceId of references) {
          if (controller.signal.aborted || !recoveryEligible(id, source, references)) throw viewEnded()
          // An open response is intentionally private until every surviving
          // reference has been reacquired. In particular, do not compare its
          // revision to the stale, possibly higher revision from the old Host.
          const wire = wireSnapshotSchema.parse(await call({ action: 'open', sessionId: source.sessionId,
            address: source.address, referenceId }, controller.signal))
          acquired.push({ id: wire.id, referenceId })
          if (!wire.document || wire.annotationDelta || previous && wire.path !== previous.path
            || value && (wire.id !== value.id || wire.path !== value.path)) {
            throw invalidRecovery('PDF recovery returned a different source or incomplete snapshot')
          }
          value = { ...wire, document: wire.document }
        }
        if (!value || controller.signal.aborted || !recoveryEligible(id, source, references)) throw viewEnded()
        const replacementId = value.id
        const otherSource = replacementId === id ? undefined : sourceAddresses.get(replacementId)
        if (otherSource && (otherSource.sessionId !== source.sessionId || otherSource.address !== source.address)) {
          throw invalidRecovery('PDF recovery crossed source ownership')
        }
        const fresher = replacementId === id ? undefined : latest.get(replacementId)
        if (fresher && fresher.revision > value.revision) value = fresher
        const oldListeners = listeners.get(id)
        if (!oldListeners?.size) throw viewEnded()
        if (replacementId !== id) {
          const nextListeners = listeners.get(replacementId) ?? new Set<Listener>()
          for (const listener of oldListeners) { listener.id = replacementId; nextListeners.add(listener) }
          listeners.delete(id); listeners.set(replacementId, nextListeners)
          sourceAddresses.delete(id)
          const nextSource = otherSource ?? { sessionId: source.sessionId, address: source.address, references: new Set<string>() }
          for (const referenceId of references) nextSource.references.add(referenceId)
          sourceAddresses.set(replacementId, nextSource)
          latest.delete(id)
          for (const [old, current] of replacedIds) if (current === id) replacedIds.set(old, replacementId)
          replacedIds.set(id, replacementId)
        }
        latest.set(replacementId, value)
        failedWatchRecoveries.delete(id)
        watches.get(id)?.abort()
        // The new Host may restart its revision counter even when its ID is
        // reused. Replace the old long poll before publishing the snapshot.
        watch(replacementId)
        acquired.length = 0
        for (const listener of listeners.get(replacementId) ?? []) listener.callback(value)
        return value
      } catch (error) {
        // Hiding a Reader or releasing a view while RPC is in flight must not
        // leave the newly acquired Host reference attached to an old tab.
        await Promise.allSettled(acquired.map(entry => releaseCall({ action: 'release', sessionId: source.sessionId,
          id: entry.id, referenceId: entry.referenceId })))
        throw error
      } finally {
        if (recoveries.get(id)?.controller === controller) recoveries.delete(id)
      }
    })()
    recoveries.set(id, { controller, promise })
    return promise
  }
  const watch = (id: string) => {
    if (watches.get(id)?.signal.aborted === false || !sourceAddresses.has(id) || lifetime.aborted) return
    const controller = new AbortController()
    watches.set(id, controller)
    void (async () => {
      let retryDelay = 250
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
          retryDelay = 250
          if (update.revision !== latest.get(id)?.revision) {
            // A watch refresh reads the existing draft. It must not acquire a
            // new UI reference after the last tab has begun releasing its view.
            await snapshot({ action: 'refresh', sessionId: address.sessionId, id }, controller.signal)
          } else if (Date.now() - started < 250) {
            // Protect against a misconfigured endpoint returning immediately.
            await pause(250, controller.signal)
          }
        } catch (error) {
          if (controller.signal.aborted || lifetime.aborted) break
          if (unknownDocument(error)) {
            if (failedWatchRecoveries.has(id)) break
            try { await reacquire(id) } catch (recoveryError) {
              if (controller.signal.aborted || lifetime.aborted) break
              if (recoveryError instanceof Error && recoveryError.name === 'AbortError') break
              if (transportFailure(recoveryError)) {
                // Recheck the old ID after reconnection. Only another explicit
                // unknown-document reply may authorize a subsequent open.
                await pause(retryDelay, controller.signal)
                retryDelay = Math.min(retryDelay * 2, 8000)
                continue
              }
              failedWatchRecoveries.add(id)
              break
            }
            break
          }
          // Ordinary transport failures do not authorize an implicit open.
          await pause(retryDelay, controller.signal)
          retryDelay = Math.min(retryDelay * 2, 8000)
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
    async text(sessionId, id, reader, page, signal, options) {
      const result = await call({ action: 'text', sessionId, id, bytesHash: reader.bytesHash, page,
        ...(options?.recover === undefined ? {} : { recover: options.recover }) }, signal, 'pdf.native')
      // The subprocess and Host enforce the detailed run and character budgets.
      return z.object({ items: z.array(z.object({ str: z.string(), transform: z.array(z.number().finite()).length(6),
        width: z.number().finite(), height: z.number().finite(), dir: z.string(), fontName: z.string(), hasEOL: z.boolean(),
        glyphs: z.array(z.tuple([z.number().finite(), z.number().finite(), z.number().finite().positive()])).max(200000).optional() })).max(10000),
        styles: z.record(z.string(), z.object({ fontFamily: z.string(), ascent: z.number(), descent: z.number(), vertical: z.boolean() })),
        lang: z.string().nullable(), quality: z.object({ unmappedCharacters: z.number().int().nonnegative() }).optional(),
        extraction: z.literal('local-ocr').optional(), warnings: z.array(z.string()).optional() }).parse(result) as NativeTextContent
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
    async unlock(sessionId, address, password, signal, referenceId) {
      const addressed = sessionFile(address)
      if (addressed.sessionId !== sessionId) throw new Error('The PDF address belongs to another session')
      if (!password || password.length > 1024 || password.includes('\0')) throw new Error('Invalid PDF password')
      if (!referenceId) throw new Error('A PDF view reference is required to unlock')
      const key = referenceKey(sessionId, referenceId)
      const assertViewOpen = () => {
        if (closedReferences.has(key)) throw viewEnded()
      }
      assertViewOpen()
      const value = await snapshot({ action: 'unlock', sessionId, address, referenceId, password }, signal, next => {
        // Fence late replies before they can replace another view's snapshot.
        assertViewOpen()
        const source = sourceAddresses.get(next.id) ?? { sessionId, address, references: new Set<string>() }
        source.references.add(referenceId)
        sourceAddresses.set(next.id, source)
      })
      assertViewOpen()
      failedWatchRecoveries.delete(value.id)
      if (listeners.get(value.id)?.size) watch(value.id)
      return value
    },
    async refresh(sessionId, id, signal) {
      const activeId = currentId(id)
      try { return await snapshot({ action: 'refresh', sessionId, id: activeId }, signal) } catch (error) {
        if (!unknownDocument(error) || signal?.aborted || lifetime.aborted
          || sourceAddresses.get(activeId)?.sessionId !== sessionId) throw error
        const recovered = await reacquire(activeId)
        signal?.throwIfAborted()
        return recovered
      }
    },
    async release(sessionId, id, referenceId, signal) {
      if (id === undefined) closedReferences.add(referenceKey(sessionId, referenceId))
      const requestedId = id === undefined ? undefined : currentId(id)
      for (const [documentId, source] of sourceAddresses) {
        if (source.sessionId !== sessionId || requestedId !== undefined && documentId !== requestedId) continue
        if (source.references.delete(referenceId)) {
          const recovery = recoveries.get(documentId)
          if (recovery) {
            recovery.controller.abort()
            watches.get(documentId)?.abort()
            // A surviving view still needs a watch. Wait for the old attempt
            // to clean any late Host references before reacquiring its subset.
            if (source.references.size && listeners.get(documentId)?.size) {
              void recovery.promise.catch(() => {}).finally(() => {
                if (sourceAddresses.get(documentId) === source && source.references.size
                  && listeners.get(documentId)?.size && !lifetime.aborted) watch(documentId)
              })
            }
          }
        }
        if (!source.references.size) {
          watches.get(documentId)?.abort()
          sourceAddresses.delete(documentId); latest.delete(documentId); listeners.delete(documentId)
          for (const alias of [...replacedIds.keys()]) if (currentId(alias) === documentId) replacedIds.delete(alias)
        }
      }
      await releaseCall({ action: 'release', sessionId,
        ...(requestedId === undefined ? {} : { id: requestedId }), referenceId }, signal)
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
      if (!set) { set = new Set(); listeners.set(id, set); failedWatchRecoveries.delete(id) }
      const listener: Listener = { id, callback }
      set.add(listener)
      watch(id)
      return () => {
        const current = listener.id
        const currentSet = listeners.get(current)
        currentSet?.delete(listener)
        if (!currentSet?.size && listeners.get(current) === currentSet) {
          watches.get(current)?.abort(); recoveries.get(current)?.controller.abort()
          listeners.delete(current)
          // React replaces the old-ID subscription after receiving a recovered
          // snapshot. Its new subscription still needs this revision baseline
          // to start a watch. Keep it for the live UI reference, and let the
          // final release clear it with the source inventory.
          if (!sourceAddresses.get(current)?.references.size) latest.delete(current)
        }
      }
    },
  }
}
