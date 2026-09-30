import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { NativeWorker } from '../engine/native-worker.ts'
import { ByteCache } from '../engine/byte-cache.ts'
import { encodePng } from '../engine/png.ts'
import type { ReaderDescriptor, ReaderEngine } from '../shared/native.ts'
import type { WorkspaceSnapshot } from '../shared/contracts.ts'
import { binaryResult, type PdfAgent, type PdfDispatch } from './transport.ts'
import type { createWorkspaces } from './workspaces.ts'

const id = z.string().min(1).max(512)
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const integer = z.number().int()
const common = { sessionId: id, id, bytesHash: hash }
const nativeRequest = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('tile'), tile: z.object({
    page: integer.min(1).max(100000), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    rasterWidth: integer.min(1).max(1048576), rasterHeight: integer.min(1).max(1048576),
    x: integer.min(-2), y: integer.min(-2), width: integer.min(1).max(1026), height: integer.min(1).max(1026), annotations: z.boolean(),
  }).strict().refine(t => t.x + t.width <= t.rasterWidth + 2 && t.y + t.height <= t.rasterHeight + 2) }).strict(),
  z.object({ ...common, action: z.literal('text'), page: integer.min(1).max(100000) }).strict(),
  z.object({ ...common, action: z.literal('links'), page: integer.min(1).max(100000) }).strict(),
  z.object({ ...common, action: z.literal('destination'), name: z.string().min(1).max(32768) }).strict(),
  z.object({ ...common, action: z.literal('inspect'), page: integer.min(1).max(100000), offset: integer.min(0), limit: integer.min(1).max(100) }).strict(),
])
const hints = z.object({ knownRevision: integer.min(0).optional(), mutationId: z.string().uuid().optional(), knownReaderEngine: z.enum(['native', 'pdfjs']).optional() })
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
interface Handle { hash: string; generation: number; bytes: number }

/** Host authority is shared by UI dispatch, native reads and future Agent callers. */
export function createPdfService(workspaces: ReturnType<typeof createWorkspaces>, options: {
  executable: string; engine: () => ReaderEngine; cacheBytes?: number; timeoutMs?: number
}) {
  const worker = new NativeWorker(options.executable, options.timeoutMs)
  const handles = new Map<string, Handle>()
  const openings = new Map<string, Promise<void>>()
  const tiles = new ByteCache<Buffer>(options.cacheBytes ?? 32 * 1024 * 1024)
  const histories = new Map<string, WorkspaceSnapshot>()
  // An idempotency entry never retains PDF bytes or a full metadata reply.
  const mutations = new Map<string, { digest: string; task: Promise<string | undefined> }>()
  let handlesBytes = 0, closed = false
  let admission: Promise<unknown> = Promise.resolve()

  async function ensure(snapshot: WorkspaceSnapshot, signal?: AbortSignal): Promise<void> {
    if (closed) fail('pdf/unavailable', 'PDF service is unloading')
    await worker.ready()
    const bytesHash = workspaces.bytesHash(snapshot.bytes)
    const existing = handles.get(snapshot.id)
    if (existing?.hash === bytesHash && existing.generation === worker.generation) {
      handles.delete(snapshot.id); handles.set(snapshot.id, existing); return
    }
    const pending = openings.get(snapshot.id)
    if (pending) { await pending; return ensure(snapshot, signal) }
    // Opening is an internal transaction, not bound to a single reader's abort.
    // This keeps an abandoned open from leaving an untracked native handle.
    const task = admission.catch(() => undefined).then(async () => {
      if (existing) { handles.delete(snapshot.id); handlesBytes -= existing.bytes }
      for (const [key, handle] of handles) {
        if (handle.generation !== worker.generation) { handles.delete(key); handlesBytes -= handle.bytes }
      }
      while (handles.size >= 16 || handlesBytes + snapshot.bytes.byteLength > 128 * 1024 * 1024) {
        const key = handles.keys().next().value
        if (key === undefined) break
        const old = handles.get(key)!
        handles.delete(key); handlesBytes -= old.bytes
        await worker.request({ command: 'close', documentId: key })
      }
      if (snapshot.bytes.byteLength > 128 * 1024 * 1024) fail('pdf/native-size', 'PDF exceeds the native working-set limit')
      const reply = await worker.request({ command: 'open', documentId: snapshot.id }, snapshot.bytes)
      const value = z.object({ pageCount: integer, formType: integer, signatureCount: integer }).parse(reply.value)
      if (value.pageCount !== snapshot.document.pageCount || value.formType !== 0 || value.signatureCount > 0) {
        await worker.request({ command: 'close', documentId: snapshot.id })
        fail('pdf/native-compatibility', 'PDF forms, signatures or inconsistent page geometry require the compatibility reader')
      }
      handles.set(snapshot.id, { hash: bytesHash, generation: worker.generation, bytes: snapshot.bytes.byteLength })
      handlesBytes += snapshot.bytes.byteLength
    })
    admission = task
    openings.set(snapshot.id, task)
    try { await task } finally { if (openings.get(snapshot.id) === task) openings.delete(snapshot.id) }
    signal?.throwIfAborted()
  }

  async function descriptor(snapshot: WorkspaceSnapshot, signal: AbortSignal): Promise<ReaderDescriptor> {
    const bytesHash = workspaces.bytesHash(snapshot.bytes)
    const base = { bytesHash, protocolVersion: 1 as const }
    const engine = options.engine()
    if (engine === 'pdfjs') return { ...base, engine: 'pdfjs', generation: 0 }
    const reason = snapshot.document.encrypted ? 'Encrypted PDF requires the compatibility reader'
      : snapshot.document.signed ? 'Signed PDF requires the compatibility reader'
      : !existsSync(options.executable) ? 'Native helper is not installed; run npm run native:build' : undefined
    if (reason) {
      if (engine === 'native') fail('pdf/native-unavailable', reason)
      return { ...base, engine: 'pdfjs', generation: 0, fallbackReason: reason }
    }
    try {
      await ensure(snapshot, signal)
      return { ...base, engine: 'native', generation: worker.generation }
    } catch (error) {
      signal.throwIfAborted()
      if (engine === 'native') throw error
      return { ...base, engine: 'pdfjs', generation: 0, fallbackReason: error instanceof Error ? error.message : 'Native reader unavailable' }
    }
  }

  async function wire(snapshot: WorkspaceSnapshot, raw: Record<string, unknown>, signal: AbortSignal) {
    const reader = await descriptor(snapshot, signal)
    const previous = histories.get(snapshot.id)
    const sameBytes = raw.knownBytesHash === reader.bytesHash
    const continuous = sameBytes && previous !== undefined && previous.revision === raw.knownRevision && previous.contentVersion === snapshot.contentVersion
      && workspaces.bytesHash(previous.bytes) === reader.bytesHash
    const { bytes: _bytes, document, baselineAnnotations, ...status } = snapshot
    const value: Record<string, unknown> = { ...status, bytesHash: reader.bytesHash, reader }
    if (continuous) {
      const before = new Map(previous.document.annotations.map(a => [a.id, a]))
      value.annotationDelta = { fromRevision: previous.revision,
        remove: [...before.keys()].filter(key => !document.annotations.some(a => a.id === key)),
        upsert: document.annotations.filter(a => JSON.stringify(a) !== JSON.stringify(before.get(a.id))) }
    } else { value.document = document; value.baselineAnnotations = baselineAnnotations }
    histories.delete(snapshot.id); histories.set(snapshot.id, snapshot)
    while (histories.size > 32) histories.delete(histories.keys().next().value!)
    if (reader.engine === 'native' || sameBytes && raw.knownReaderEngine === 'pdfjs') return value
    return binaryResult(value, snapshot.bytes, 'application/pdf')
  }

  const dispatch: PdfDispatch = async (sessionId, raw, agent, signal) => {
    const parsed = hints.parse(raw)
    const { knownRevision: _revision, mutationId: _mutation, knownReaderEngine: _engine, ...input } = raw
    let result: Awaited<ReturnType<typeof workspaces.execute>>
    const mutating = ['change', 'undo', 'redo', 'save', 'reload', 'discard'].includes(String(input.action))
    if (parsed.mutationId && mutating) {
      const key = JSON.stringify([sessionId, parsed.mutationId])
      const { knownBytesHash: _hash, ...identity } = input
      const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
      let entry = mutations.get(key)
      if (entry && entry.digest !== digest) fail('pdf/mutation-mismatch', 'A mutation ID was reused with different content')
      if (!entry) {
        const task = workspaces.execute(sessionId, input, agent, signal).then(value => 'bytes' in value ? value.id : undefined)
        entry = { digest, task }; mutations.set(key, entry)
        void task.catch(() => { if (mutations.get(key) === entry) mutations.delete(key) })
        while (mutations.size > 256) mutations.delete(mutations.keys().next().value!)
      }
      const documentId = await entry.task
      if (!documentId) fail('pdf/invalid-request', 'Idempotent request did not identify a document')
      result = workspaces.readSnapshot(sessionId, documentId)
    } else result = await workspaces.execute(sessionId, input, agent, signal)
    if (!('bytes' in result)) {
      if ('discarded' in result && result.discarded) for (const key of result.discarded) {
        histories.delete(key)
        const handle = handles.get(key)
        if (handle) { handles.delete(key); handlesBytes -= handle.bytes; await worker.request({ command: 'close', documentId: key }).catch(() => undefined) }
      }
      return result
    }
    return wire(result, raw, signal)
  }

  const native: PdfDispatch = async (sessionId, raw, agent, signal) => {
    if (closed) fail('pdf/unavailable', 'PDF service is unloading')
    const input = nativeRequest.parse(raw)
    if (input.sessionId !== sessionId || agent.session.id !== sessionId) fail('pdf/session-mismatch', 'Session identity mismatch')
    const snapshot = workspaces.readSnapshot(sessionId, input.id)
    if (workspaces.bytesHash(snapshot.bytes) !== input.bytesHash) fail('pdf/stale-reader', 'PDF baseline changed; use the latest reader snapshot')
    if ('page' in input && input.page > snapshot.document.pageCount || 'tile' in input && input.tile.page > snapshot.document.pageCount) fail('pdf/invalid-page', 'Page is outside the document')
    await ensure(snapshot, signal)
    if (input.action === 'tile') {
      const t = input.tile
      const key = JSON.stringify([input.bytesHash, t])
      let png = tiles.get(key)
      if (!png) {
        const reply = await worker.request({ command: 'render', documentId: input.id, ...t, pageIndex: t.page - 1 }, undefined, signal, 10)
        const value = z.object({ width: integer, height: integer, format: z.literal('rgba') }).parse(reply.value)
        if (value.width !== t.width || value.height !== t.height) fail('pdf/native-protocol', 'Native tile dimensions do not match')
        png = await encodePng(reply.bytes, t.width, t.height)
        signal.throwIfAborted()
        // A completed old render cannot update a newly saved working copy's cache.
        tiles.set(key, png, png.byteLength)
      }
      signal.throwIfAborted()
      return binaryResult({ width: t.width, height: t.height, mime: 'image/png' }, png, 'image/png')
    }
    const command = input.action === 'destination' ? { command: 'destination', name: input.name }
      : { command: input.action, pageIndex: input.page - 1, ...(input.action === 'inspect' ? { offset: input.offset, limit: input.limit } : {}) }
    const reply = await worker.request({ ...command, documentId: input.id }, undefined, signal, -5)
    return reply.value
  }
  return { dispatch, native, diagnostics: () => ({ generation: worker.generation, workerPid: worker.pid, documents: handles.size, documentBytes: handlesBytes,
    tileCacheBytes: tiles.bytes, tileCacheEntries: tiles.size }),
    dispose() { closed = true; worker.dispose(); tiles.clear(); handles.clear(); histories.clear(); mutations.clear(); handlesBytes = 0 } }
}
