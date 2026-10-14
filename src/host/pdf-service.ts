import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { NativeWorker } from '../engine/native-worker.ts'
import { ByteCache } from '../engine/byte-cache.ts'
import { encodePng } from '../engine/png.ts'
import { NativeViewport } from '../client/native/viewport.ts'
import type { NativeOutlineItem, NativeTextContent, ReaderDescriptor } from '../shared/native.ts'
import { binaryResult, type PdfAgent, type PdfDispatch } from './transport.ts'
import type { createWorkspaces, HostWorkspaceSnapshot } from './workspaces.ts'

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
  z.object({ ...common, action: z.literal('outline') }).strict(),
  z.object({ ...common, action: z.literal('destination'), name: z.string().min(1).max(32768) }).strict(),
  z.object({ ...common, action: z.literal('inspect'), page: integer.min(1).max(100000), offset: integer.min(0), limit: integer.min(1).max(100) }).strict(),
])
const hints = z.object({ knownRevision: integer.min(0).optional(), mutationId: z.string().uuid().optional() })
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
interface Handle { hash: string; generation: number; bytes: number }

/** Host authority is shared by UI dispatch, native reads and future Agent callers. */
export function createPdfService(workspaces: ReturnType<typeof createWorkspaces>, options: {
  executable: string; cacheBytes?: number; timeoutMs?: number
}) {
  const worker = new NativeWorker(options.executable, options.timeoutMs)
  const handles = new Map<string, Handle>()
  const openings = new Map<string, Promise<void>>()
  const tiles = new ByteCache<Buffer>(options.cacheBytes ?? 32 * 1024 * 1024)
  const histories = new Map<string, HostWorkspaceSnapshot>()
  // An idempotency entry never retains PDF bytes or a full metadata reply.
  const mutations = new Map<string, { digest: string; task: Promise<string | undefined> }>()
  let handlesBytes = 0, closed = false
  let admission: Promise<unknown> = Promise.resolve()
  let handleLease: Promise<unknown> = Promise.resolve()

  // The native worker addresses a mutable document ID. Keep an ensure/read
  // pair atomic with respect to other opens, closes and cache evictions.
  function withHandleLease<T>(task: () => Promise<T>): Promise<T> {
    const run = handleLease.catch(() => undefined).then(task)
    // Keep only completion, not a possibly large tile or text reply.
    handleLease = run.then(() => undefined, () => undefined)
    return run
  }

  async function ensure(snapshot: HostWorkspaceSnapshot, signal?: AbortSignal): Promise<void> {
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
        fail('pdf/native-unsupported', 'PDF forms, signatures or inconsistent page geometry are not supported by the native reader')
      }
      handles.set(snapshot.id, { hash: bytesHash, generation: worker.generation, bytes: snapshot.bytes.byteLength })
      handlesBytes += snapshot.bytes.byteLength
    })
    admission = task
    openings.set(snapshot.id, task)
    try { await task } finally { if (openings.get(snapshot.id) === task) openings.delete(snapshot.id) }
    signal?.throwIfAborted()
  }

  async function descriptor(snapshot: HostWorkspaceSnapshot, signal: AbortSignal): Promise<ReaderDescriptor> {
    const bytesHash = workspaces.bytesHash(snapshot.bytes)
    if (snapshot.document.encrypted) fail('pdf/native-unsupported', 'Encrypted PDFs are not supported by the native reader')
    if (snapshot.document.signed) fail('pdf/native-unsupported', 'Signed PDFs are not supported by the native reader')
    if (!existsSync(options.executable)) fail('pdf/native-unavailable', 'Native helper is unavailable; install the PDF package for this platform')
    await ensure(snapshot, signal)
    return { bytesHash, protocolVersion: 1, generation: worker.generation }
  }

  async function wire(snapshot: HostWorkspaceSnapshot, raw: Record<string, unknown>, signal: AbortSignal) {
    const reader = await withHandleLease(() => descriptor(snapshot, signal))
    const previous = histories.get(snapshot.id)
    const continuous = raw.knownBytesHash === reader.bytesHash && previous !== undefined && previous.revision === raw.knownRevision && previous.contentVersion === snapshot.contentVersion
      && workspaces.bytesHash(previous.bytes) === reader.bytesHash
    const { bytes: _bytes, document, baselineAnnotations, ...status } = snapshot
    const value: Record<string, unknown> = { ...status, reader }
    if (continuous) {
      const before = new Map(previous.document.annotations.map(a => [a.id, a]))
      value.annotationDelta = { fromRevision: previous.revision,
        remove: [...before.keys()].filter(key => !document.annotations.some(a => a.id === key)),
        upsert: document.annotations.filter(a => JSON.stringify(a) !== JSON.stringify(before.get(a.id))) }
    } else { value.document = document; value.baselineAnnotations = baselineAnnotations }
    histories.delete(snapshot.id); histories.set(snapshot.id, snapshot)
    while (histories.size > 32) histories.delete(histories.keys().next().value!)
    return value
  }

  const dispatch: PdfDispatch = async (sessionId, raw, agent, signal) => {
    const parsed = hints.parse(raw)
    const { knownRevision: _revision, mutationId: _mutation, ...requested } = raw
    // The public Client transport must never claim Agent ownership. Only the
    // in-process pdf_open tool may create a reclaimable background copy.
    const input = requested.action === 'open' ? { ...requested, owner: 'ui' } : requested
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

  const native: PdfDispatch = async (sessionId, raw, agent, signal) => withHandleLease(async () => {
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
    const command = input.action === 'outline' ? { command: 'outline' }
      : input.action === 'destination' ? { command: 'destination', name: input.name }
      : { command: input.action, pageIndex: input.page - 1, ...(input.action === 'inspect' ? { offset: input.offset, limit: input.limit } : {}) }
    const reply = await worker.request({ ...command, documentId: input.id }, undefined, signal, -5)
    return reply.value
  })
  async function readPageText(sessionId: string, documentId: string, page: number, signal: AbortSignal): Promise<{
    snapshot: HostWorkspaceSnapshot; content: NativeTextContent
  }> { return withHandleLease(async () => {
    signal.throwIfAborted()
    const snapshot = workspaces.readSnapshot(sessionId, documentId)
    if (!Number.isSafeInteger(page) || page < 1 || page > snapshot.document.pageCount) {
      fail('pdf/invalid-page', 'Page is outside the document')
    }
    await descriptor(snapshot, signal)
    const reply = await worker.request({ command: 'text', documentId, pageIndex: page - 1 }, undefined, signal, -5)
    signal.throwIfAborted()
    const content = z.object({ items: z.array(z.object({ str: z.string(), transform: z.array(z.number()),
      width: z.number(), height: z.number(), dir: z.string(), fontName: z.string(), hasEOL: z.boolean() })),
      styles: z.record(z.string(), z.object({ fontFamily: z.string(), ascent: z.number(), descent: z.number(), vertical: z.boolean() })),
      lang: z.string().nullable() }).parse(reply.value)
    return { snapshot, content }
  }) }
  async function readOutline(sessionId: string, documentId: string, signal: AbortSignal): Promise<{
    snapshot: HostWorkspaceSnapshot; items: NativeOutlineItem[] | null
  }> { return withHandleLease(async () => {
    signal.throwIfAborted()
    const snapshot = workspaces.readSnapshot(sessionId, documentId)
    await descriptor(snapshot, signal)
    const reply = await worker.request({ command: 'outline', documentId }, undefined, signal, -5)
    signal.throwIfAborted()
    const itemSchema: z.ZodType<NativeOutlineItem> = z.lazy(() => z.object({
      title: z.string().max(8191), dest: z.unknown().optional(), url: z.string().max(32768).optional(),
      items: z.array(itemSchema),
    }))
    return { snapshot, items: z.array(itemSchema).nullable().parse(reply.value) }
  }) }
  /** Render one bounded full-page PNG from the native source, without any Client/UI dependency. */
  async function renderPage(sessionId: string, documentId: string, page: number, maxEdge: number,
    signal: AbortSignal): Promise<{ snapshot: HostWorkspaceSnapshot; png: Buffer; width: number; height: number }> {
    return withHandleLease(async () => {
      signal.throwIfAborted()
      const snapshot = workspaces.readSnapshot(sessionId, documentId)
      if (!Number.isSafeInteger(page) || page < 1 || page > snapshot.document.pageCount) {
        fail('pdf/invalid-page', 'Page is outside the document')
      }
      if (!Number.isSafeInteger(maxEdge) || maxEdge < 256 || maxEdge > 1024) {
        fail('pdf/invalid-render-size', 'Page render size must be between 256 and 1024 pixels')
      }
      const geometry = snapshot.document.pages[page - 1]
      if (!geometry) fail('pdf/invalid-page', 'Page geometry is unavailable')
      const [left, bottom, right, top] = geometry.cropBox
      let pageWidth = Math.abs(right - left) * geometry.userUnit
      let pageHeight = Math.abs(top - bottom) * geometry.userUnit
      if (Math.abs(geometry.rotation) % 180 === 90) [pageWidth, pageHeight] = [pageHeight, pageWidth]
      if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
        fail('pdf/invalid-page', 'Page geometry is invalid')
      }
      const factor = maxEdge / Math.max(pageWidth, pageHeight)
      const width = Math.max(1, Math.min(1024, Math.round(pageWidth * factor)))
      const height = Math.max(1, Math.min(1024, Math.round(pageHeight * factor)))
      await descriptor(snapshot, signal)
      const reply = await worker.request({ command: 'render', documentId, pageIndex: page - 1,
        rotation: 0, rasterWidth: width, rasterHeight: height,
        x: 0, y: 0, width, height, annotations: true }, undefined, signal, 10)
      const value = z.object({ width: integer, height: integer, format: z.literal('rgba') }).parse(reply.value)
      if (value.width !== width || value.height !== height) fail('pdf/native-protocol', 'Native page dimensions do not match')
      const png = await encodePng(reply.bytes, width, height)
      signal.throwIfAborted()
      const latest = workspaces.readSnapshot(sessionId, documentId)
      if (latest.contentVersion !== snapshot.contentVersion || latest.revision !== snapshot.revision) {
        fail('pdf/stale-reader', 'PDF changed during page render; retry')
      }
      return { snapshot, png, width, height }
    })
  }
  /** Render an unannotated page or PDF-space region for OCR without transporting image bytes from Client. */
  async function renderOcrImage(sessionId: string, documentId: string, page: number,
    region: readonly [number, number, number, number] | undefined, maxEdge: number,
    signal: AbortSignal): Promise<{ snapshot: HostWorkspaceSnapshot; png: Buffer; width: number; height: number;
      pdfRegion: [number, number, number, number] }> {
    return withHandleLease(async () => {
      signal.throwIfAborted()
      const snapshot = workspaces.readSnapshot(sessionId, documentId)
      if (!Number.isSafeInteger(page) || page < 1 || page > snapshot.document.pageCount) {
        fail('pdf/invalid-page', 'Page is outside the document')
      }
      if (!Number.isSafeInteger(maxEdge) || maxEdge < 256 || maxEdge > 1024) {
        fail('pdf/invalid-render-size', 'OCR render size must be between 256 and 1024 pixels')
      }
      const geometry = snapshot.document.pages[page - 1]
      if (!geometry) fail('pdf/invalid-page', 'Page geometry is unavailable')
      const [pageLeft, pageBottom, pageRight, pageTop] = geometry.cropBox
      const pdfRegion: [number, number, number, number] = region
        ? [Math.max(pageLeft, region[0]), Math.max(pageBottom, region[1]),
          Math.min(pageRight, region[2]), Math.min(pageTop, region[3])]
        : [pageLeft, pageBottom, pageRight, pageTop]
      if (region && (region.length !== 4 || !region.every(Number.isFinite)
        || region[2] <= region[0] || region[3] <= region[1])) {
        fail('pdf/invalid-region', 'OCR region must be a finite, ordered PDF rectangle')
      }
      if (pdfRegion[2] <= pdfRegion[0] || pdfRegion[3] <= pdfRegion[1]) {
        fail('pdf/invalid-region', 'OCR region does not intersect the PDF page')
      }
      const viewport = new NativeViewport(geometry, 1)
      const first = viewport.convertToViewportPoint(pdfRegion[0], pdfRegion[1])
      const second = viewport.convertToViewportPoint(pdfRegion[2], pdfRegion[3])
      const left = Math.min(first[0], second[0]), right = Math.max(first[0], second[0])
      const top = Math.min(first[1], second[1]), bottom = Math.max(first[1], second[1])
      const span = Math.max(right - left, bottom - top)
      if (![viewport.width, viewport.height, left, right, top, bottom, span].every(Number.isFinite)
        || !(viewport.width > 0 && viewport.height > 0 && span > 0)) {
        fail('pdf/invalid-page', 'PDF page geometry is invalid')
      }
      // The native worker only allocates the clipped tile, but its virtual page
      // raster must remain within the worker's coordinate range. Cap density to
      // avoid extreme virtual dimensions for a microscopic selected region.
      const density = Math.min(4, maxEdge / span, 1_048_575 / viewport.width, 1_048_575 / viewport.height)
      if (!(density > 0)) fail('pdf/invalid-region', 'OCR region cannot be rendered at a usable size')
      const rasterWidth = Math.max(1, Math.ceil(viewport.width * density))
      const rasterHeight = Math.max(1, Math.ceil(viewport.height * density))
      // PDFium scales the two integer raster axes independently; use their
      // actual ratios so crop pixels match the worker's effective transform.
      const sx = rasterWidth / viewport.width, sy = rasterHeight / viewport.height
      const x = Math.max(0, Math.floor(left * sx)), y = Math.max(0, Math.floor(top * sy))
      const endX = Math.min(rasterWidth, Math.ceil(right * sx))
      const endY = Math.min(rasterHeight, Math.ceil(bottom * sy))
      const width = endX - x, height = endY - y
      if (width < 1 || height < 1 || width > 1026 || height > 1026) {
        fail('pdf/invalid-region', 'OCR region exceeds the native tile size')
      }
      await descriptor(snapshot, signal)
      const reply = await worker.request({ command: 'render', documentId, pageIndex: page - 1,
        rotation: 0, rasterWidth, rasterHeight, x, y, width, height, annotations: false }, undefined, signal, 10)
      const value = z.object({ width: integer, height: integer, format: z.literal('rgba') }).parse(reply.value)
      if (value.width !== width || value.height !== height) fail('pdf/native-protocol', 'Native OCR image dimensions do not match')
      const png = await encodePng(reply.bytes, width, height)
      signal.throwIfAborted()
      const latest = workspaces.readSnapshot(sessionId, documentId)
      if (latest.contentVersion !== snapshot.contentVersion || latest.revision !== snapshot.revision) {
        fail('pdf/stale-reader', 'PDF changed during OCR image render; retry')
      }
      return { snapshot, png, width, height, pdfRegion }
    })
  }
  /** Release only the native state of a working copy already removed by Workspaces. */
  async function releaseDocument(documentId: string): Promise<void> {
    await withHandleLease(async () => {
      histories.delete(documentId)
      const handle = handles.get(documentId)
      if (!handle) return
      handles.delete(documentId)
      handlesBytes -= handle.bytes
      if (!closed && handle.generation === worker.generation) {
        await worker.request({ command: 'close', documentId }).catch(() => undefined)
      }
    })
  }
  return { dispatch, native, readPageText, readOutline, renderPage, renderOcrImage, releaseDocument, diagnostics: () => ({ generation: worker.generation, workerPid: worker.pid, documents: handles.size, documentBytes: handlesBytes,
    tileCacheBytes: tiles.bytes, tileCacheEntries: tiles.size }),
    dispose() { closed = true; worker.dispose(); tiles.clear(); handles.clear(); histories.clear(); mutations.clear(); handlesBytes = 0 } }
}
