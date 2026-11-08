import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { NativeWorker, type NativeProcessRuntime } from './native-worker.js'
import { encodePng } from './png.js'
import { encryptedDocumentInfo } from './encrypted-document.js'
import { ByteCache } from '../../../shared/cache/index.js'
import { ocrRegionRenderPlan, pageRenderPlan, recoveredPageText } from '../../../modules/document/index.js'
import { CapabilityRegistry, pdfCapabilities, requiredPdfOpenCapabilities } from '../../../modules/capabilities/index.js'
import { projectedReaderOutline } from '../../../modules/outlines/index.js'
import { inspectFormPage } from '../../../modules/forms/index.js'
import { paintFormLabels } from './form-labels.js'
import type { TextRecovery } from '../ocr/local-text-recovery.js'
import { createPageOcrArtifacts, type OcrProducerIdentity, type PageOcrArtifacts } from '../ocr/page-ocr-artifacts.js'
import type { OcrOutput } from '../../../ocr/types.js'
import { NativeViewport } from '../../../shared/geometry/native-viewport.js'
import type { NativeOutlineItem, NativeTextContent, ReaderDescriptor } from '../../../shared/native.js'
import { binaryResult, type PdfDispatch } from '../dsh/index.js'
import type { createWorkingCopyService, HostWorkspaceSnapshot } from '../../../modules/working-copy/index.js'
import { recordIndexPerformance } from '../../../modules/retrieval/index.js'
import type { PdfDocumentInfo } from '../../../core/pdf-types.js'

const id = z.string().min(1).max(512)
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const integer = z.number().int()
const openProbe = z.object({ pageCount: integer.min(1).max(100000), formType: integer, signatureCount: integer })
const common = { sessionId: id, id, bytesHash: hash }
const nativeRequest = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('tile'), tile: z.object({
    page: integer.min(1).max(100000), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    rasterWidth: integer.min(1).max(1048576), rasterHeight: integer.min(1).max(1048576),
    x: integer.min(-2), y: integer.min(-2), width: integer.min(1).max(1026), height: integer.min(1).max(1026), annotations: z.boolean(),
  }).strict().refine(t => t.x + t.width <= t.rasterWidth + 2 && t.y + t.height <= t.rasterHeight + 2) }).strict(),
  z.object({ ...common, action: z.literal('text'), page: integer.min(1).max(100000), recover: z.boolean().optional() }).strict(),
  z.object({ ...common, action: z.literal('links'), page: integer.min(1).max(100000) }).strict(),
  z.object({ ...common, action: z.literal('outline') }).strict(),
  z.object({ ...common, action: z.literal('destination'), name: z.string().min(1).max(32768) }).strict(),
  z.object({ ...common, action: z.literal('inspect'), page: integer.min(1).max(100000), offset: integer.min(0), limit: integer.min(1).max(100) }).strict(),
])
const hints = z.object({ knownRevision: integer.min(0).optional(), mutationId: z.string().uuid().optional() })
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
interface Handle { hash: string; generation: number; bytes: number }
export interface PageOcrRecognition {
  producer: OcrProducerIdentity
  maxEdge: 1024 | 2048
  recognize(image: { png: Buffer; width: number; height: number }, signal: AbortSignal): Promise<OcrOutput>
  /** A trusted Host consumer may already own the identical clean 1024px raster. */
  image?: { snapshot: HostWorkspaceSnapshot; png: Buffer; width: number; height: number }
  /** Each subscriber retains its own producer/source fences, including cache hits. */
  check?(): void
}

/** Host authority is shared by UI dispatch, native reads and future Agent callers. */
export function createPdfService(workspaces: ReturnType<typeof createWorkingCopyService>, options: {
  executable: string; subprocess: NativeProcessRuntime; cacheBytes?: number; timeoutMs?: number
  capabilities?: CapabilityRegistry
  textRecovery?: TextRecovery
  /** The PDF service owns this derivative coordinator and drains it on disposal. */
  ocrArtifacts?: PageOcrArtifacts
  /** Internal encoder port for controlled compression and native-lease tests. */
  encodeOcrPng?: typeof encodePng
}) {
  const worker = new NativeWorker(options.executable, options.subprocess, options.timeoutMs)
  const capabilities = options.capabilities ?? new CapabilityRegistry()
  const unregisterNative = capabilities.register({ id: 'pdfium.native',
    capabilities: [pdfCapabilities.renderPage, pdfCapabilities.renderAcroForm, pdfCapabilities.previewSigned,
      pdfCapabilities.unlockDocument], implementation: worker })
  const handles = new Map<string, Handle>()
  const openings = new Map<string, Promise<void>>()
  const tiles = new ByteCache<Buffer>(options.cacheBytes ?? 32 * 1024 * 1024)
  const histories = new Map<string, HostWorkspaceSnapshot>()
  const ocrArtifacts = options.ocrArtifacts ?? createPageOcrArtifacts()
  const localProducer: OcrProducerIdentity = options.textRecovery?.producer ?? {
    id: 'local-text-recovery', version: 'unattested', fingerprint: randomUUID(), reusable: false,
  }
  const recoveryLifetime = new AbortController()
  // An idempotency entry never retains PDF bytes or a full metadata reply.
  const mutations = new Map<string, { digest: string; task: Promise<string | undefined> }>()
  let handlesBytes = 0, closed = false
  let admission: Promise<unknown> = Promise.resolve()
  let handleLease: Promise<unknown> = Promise.resolve()
  let localRecognition: Promise<unknown> = Promise.resolve()

  // The native worker addresses a mutable document ID. Keep an ensure/read
  // pair atomic with respect to other opens, closes and cache evictions.
  function withHandleLease<T>(task: () => Promise<T>): Promise<T> {
    const run = handleLease.catch(() => undefined).then(task)
    // Keep only completion, not a possibly large tile or text reply.
    handleLease = run.then(() => undefined, () => undefined)
    return run
  }

  async function admitBytes(bytes: number): Promise<void> {
    const limit = 128 * 1024 * 1024
    if (bytes > limit) fail('pdf/native-size', 'PDF exceeds the native working-set limit')
    for (const [key, handle] of handles) {
      if (handle.generation !== worker.generation) { handles.delete(key); handlesBytes -= handle.bytes }
    }
    while (handles.size >= 16 || handlesBytes + bytes > limit) {
      const key = handles.keys().next().value
      if (key === undefined) break
      const old = handles.get(key)!
      handles.delete(key); handlesBytes -= old.bytes
      await worker.request({ command: 'close', documentId: key })
    }
  }

  function inspectEncrypted(bytes: Uint8Array, password: string | undefined, signal: AbortSignal): Promise<PdfDocumentInfo | undefined> {
    return withHandleLease(async () => {
      signal.throwIfAborted()
      if (closed) fail('pdf/unavailable', 'PDF service is unloading')
      await worker.ready()
      if (!worker.encryptedOpen) {
        if (password !== undefined) fail('pdf/security-unsupported', 'Update the native PDF plugin to open protected PDFs')
        return undefined
      }
      await admitBytes(bytes.byteLength)
      signal.throwIfAborted()
      const documentId = randomUUID()
      const generation = worker.generation
      let opened = false
      try {
        const reply = await worker.request({ command: 'open', documentId, ...(password !== undefined ? { password } : {}) }, bytes)
        opened = true
        const value = openProbe.parse(reply.value)
        const security = await worker.request({ command: 'security', documentId }, undefined, signal)
        const { securityRevision } = z.object({ securityRevision: integer }).parse(security.value)
        if (securityRevision < 0) return undefined
        const plan = await capabilities.plan(requiredPdfOpenCapabilities(value, undefined, true), { signal }, 'pdfium.native')
        if (!plan.supported) {
          fail('pdf/native-unsupported', `PDF requires unavailable capabilities: ${plan.missing.map(item => item.capability).join(', ')}`)
        }
        return await encryptedDocumentInfo(value, async (offset, limit) =>
          (await worker.request({ command: 'documentInfo', documentId, offset, limit }, undefined, signal)).value)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'pdf/native-open' && password === undefined) return undefined
        throw error
      } finally {
        if (opened && !closed && generation === worker.generation) {
          await worker.request({ command: 'close', documentId }).catch(() => undefined)
        }
      }
    })
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
      await admitBytes(snapshot.bytes.byteLength)
      const password = snapshot.document.encrypted ? workspaces.passwordFor(snapshot.id, bytesHash) : undefined
      const reply = await worker.request({ command: 'open', documentId: snapshot.id,
        ...(password !== undefined ? { password } : {}) }, snapshot.bytes)
      try {
        const value = openProbe.parse(reply.value)
        if (value.pageCount !== snapshot.document.pageCount) {
          fail('pdf/native-unsupported', 'PDF page counts differ between the parser and native reader')
        }
        if (snapshot.document.formKind === 'acroform' && value.formType === 0) {
          fail('pdf/native-unsupported', 'The native reader did not recognize this AcroForm; its fields may be missing')
        }
        const required = requiredPdfOpenCapabilities({ ...value,
          signatureCount: Math.max(value.signatureCount, snapshot.document.signed ? 1 : 0) }, snapshot.document.formKind, snapshot.document.encrypted)
        const plan = await capabilities.plan(required, { signal }, 'pdfium.native')
        if (!plan.supported) {
          fail('pdf/native-unsupported', `PDF requires unavailable capabilities: ${plan.missing.map(item => item.capability).join(', ')}`)
        }
      } catch (error) {
        await worker.request({ command: 'close', documentId: snapshot.id }).catch(() => undefined)
        throw error
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
    await ensure(snapshot, signal)
    return { bytesHash, protocolVersion: 1, generation: worker.generation }
  }

  async function wire(snapshot: HostWorkspaceSnapshot, raw: Record<string, unknown>, signal: AbortSignal) {
    const reader = await withHandleLease(() => descriptor(snapshot, signal))
    const previous = histories.get(snapshot.id)
    const continuous = raw.knownBytesHash === reader.bytesHash && previous !== undefined && previous.revision === raw.knownRevision && previous.contentVersion === snapshot.contentVersion
      && workspaces.bytesHash(previous.bytes) === reader.bytesHash
    const { bytes: _bytes, document, baselineAnnotations, baselineOutline, baselineFormFields, ...status } = snapshot
    const value: Record<string, unknown> = { ...status, reader }
    // Form fields are part of document metadata, not annotation deltas. Send
    // the complete document when their projected values change.
    if (continuous && JSON.stringify(previous.document.formFields) === JSON.stringify(document.formFields)
      && JSON.stringify(previous.document.outline) === JSON.stringify(document.outline)
      && previous.document.outlineReadOnlyReason === document.outlineReadOnlyReason) {
      const before = new Map(previous.document.annotations.map(a => [a.id, a]))
      value.annotationDelta = { fromRevision: previous.revision,
        remove: [...before.keys()].filter(key => !document.annotations.some(a => a.id === key)),
        upsert: document.annotations.filter(a => JSON.stringify(a) !== JSON.stringify(before.get(a.id))) }
    } else {
      const { indexContentDigest: _indexContent, indexPageDigests: _indexPages, ...readerDocument } = document
      value.document = readerDocument
      value.baselineAnnotations = baselineAnnotations
      value.baselineOutline = baselineOutline
      value.baselineFormFields = baselineFormFields
    }
    histories.delete(snapshot.id); histories.set(snapshot.id, snapshot)
    while (histories.size > 32) histories.delete(histories.keys().next().value!)
    return value
  }

  const dispatchRequest: PdfDispatch = async (sessionId, raw, agent, signal) => {
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
    // Open may have finished before a concurrent view close was admitted.
    // Keep its descriptor/response alive without reacquiring a UI reference.
    const release = await workspaces.acquire(sessionId, result.id, agent, signal)
    try { return await wire(result, raw, signal) } finally { release() }
  }

  const dispatch: PdfDispatch = async (sessionId, raw, agent, signal) => {
    if (raw.action === 'release' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 512) {
      return dispatchRequest(sessionId, raw, agent, signal)
    }
    const release = await workspaces.acquire(sessionId, raw.id, agent, signal)
    try { return await dispatchRequest(sessionId, raw, agent, signal) } finally { release() }
  }

  const nativeRequestDispatch: PdfDispatch = async (sessionId, raw, agent, signal) => {
    // A local OCR pass must not hold the native handle lease or block tiles.
    if (raw.action === 'text') {
      const input = nativeRequest.parse(raw)
      if (input.action !== 'text') fail('pdf/invalid-request', 'Expected a text request')
      if (input.sessionId !== sessionId || agent.session.id !== sessionId) fail('pdf/session-mismatch', 'Session identity mismatch')
      const snapshot = workspaces.readSnapshot(sessionId, input.id)
      if (workspaces.bytesHash(snapshot.bytes) !== input.bytesHash) fail('pdf/stale-reader', 'PDF baseline changed; use the latest reader snapshot')
      const read = await readPageText(sessionId, input.id, input.page, signal, { recover: input.recover, reader: true })
      if (workspaces.bytesHash(read.snapshot.bytes) !== input.bytesHash) fail('pdf/stale-reader', 'PDF changed while the text request waited; use the latest reader snapshot')
      return read.content
    }
    return withHandleLease(async () => {
    if (closed) fail('pdf/unavailable', 'PDF service is unloading')
    const input = nativeRequest.parse(raw)
    if (input.sessionId !== sessionId || agent.session.id !== sessionId) fail('pdf/session-mismatch', 'Session identity mismatch')
    const snapshot = workspaces.readSnapshot(sessionId, input.id)
    if (workspaces.bytesHash(snapshot.bytes) !== input.bytesHash) fail('pdf/stale-reader', 'PDF baseline changed; use the latest reader snapshot')
    if ('page' in input && input.page > snapshot.document.pageCount || 'tile' in input && input.tile.page > snapshot.document.pageCount) fail('pdf/invalid-page', 'Page is outside the document')
    await ensure(snapshot, signal)
    if (input.action === 'tile') {
      const encrypted = snapshot.document.encrypted
      const t = encrypted ? { ...input.tile, annotations: true } : input.tile
      const key = JSON.stringify([input.bytesHash, t])
      let png = encrypted ? undefined : tiles.get(key)
      if (!png) {
        const reply = await worker.request({ command: 'render', documentId: input.id, ...t, pageIndex: t.page - 1 }, undefined, signal, 10)
        const value = z.object({ width: integer, height: integer, format: z.literal('rgba') }).parse(reply.value)
        if (value.width !== t.width || value.height !== t.height) fail('pdf/native-protocol', 'Native tile dimensions do not match')
        png = await encodePng(reply.bytes, t.width, t.height)
        signal.throwIfAborted()
        // A completed old render cannot update a newly saved working copy's cache.
        if (!encrypted) tiles.set(key, png, png.byteLength)
      }
      signal.throwIfAborted()
      return binaryResult({ width: t.width, height: t.height, mime: 'image/png' }, png, 'image/png')
    }
    if (snapshot.document.encrypted && input.action === 'inspect') {
      fail('pdf/protected-document', 'Protected PDFs can only be viewed in the Reader')
    }
    const command = input.action === 'outline' ? { command: 'outline' }
      : input.action === 'destination' ? { command: 'destination', name: input.name }
      : { command: input.action, pageIndex: input.page - 1, ...(input.action === 'inspect' ? { offset: input.offset, limit: input.limit } : {}) }
    const reply = await worker.request({ ...command, documentId: input.id }, undefined, signal, -5)
    return input.action === 'outline'
      ? projectedReaderOutline(snapshot.document, snapshot.baselineOutline, reply.value as NativeOutlineItem[] | null)
      : reply.value
    })
  }
  const native: PdfDispatch = async (sessionId, raw, agent, signal) => {
    const input = nativeRequest.parse(raw)
    if (input.sessionId !== sessionId || agent.session.id !== sessionId) fail('pdf/session-mismatch', 'Session identity mismatch')
    const release = await workspaces.acquire(sessionId, input.id, agent, signal)
    try { return await nativeRequestDispatch(sessionId, raw, agent, signal) } finally { release() }
  }
  async function readPageText(sessionId: string, documentId: string, page: number, signal: AbortSignal,
    readOptions?: { recover?: boolean; reader?: boolean }): Promise<{
    snapshot: HostWorkspaceSnapshot; content: NativeTextContent
  }> {
    const read = await withHandleLease(async () => {
    signal.throwIfAborted()
    const snapshot = workspaces.readSnapshot(sessionId, documentId)
    if (!Number.isSafeInteger(page) || page < 1 || page > snapshot.document.pageCount) {
      fail('pdf/invalid-page', 'Page is outside the document')
    }
    if (snapshot.document.encrypted) {
      if (!readOptions?.reader) fail('pdf/protected-document', 'Protected PDFs can only be viewed in the Reader')
      if (!snapshot.document.allowTextExtraction) return { snapshot, content: { items: [], styles: {}, lang: null } }
    }
    await descriptor(snapshot, signal)
    const reply = await worker.request({ command: 'text', documentId, pageIndex: page - 1 }, undefined, signal, -5)
    signal.throwIfAborted()
    const content = z.object({ items: z.array(z.object({ str: z.string(), transform: z.array(z.number()),
      width: z.number(), height: z.number(), dir: z.string(), fontName: z.string(), hasEOL: z.boolean(),
      glyphs: z.array(z.tuple([z.number().finite(), z.number().finite(), z.number().finite().positive()])).max(200000).optional() })),
      styles: z.record(z.string(), z.object({ fontFamily: z.string(), ascent: z.number(), descent: z.number(), vertical: z.boolean() })),
      lang: z.string().nullable(), quality: z.object({ unmappedCharacters: integer.min(0) }).optional() }).parse(reply.value)
    return { snapshot, content }
    })
    if (read.snapshot.document.encrypted || readOptions?.recover === false
      || !read.content.quality?.unmappedCharacters || !options.textRecovery) return read
    const { snapshot, artifact } = await readOcrArtifact(sessionId, documentId, page, signal, undefined, read.snapshot)
    return { snapshot, content: recoveredPageText(artifact.output, read.snapshot.document.pages[page - 1],
      artifact.input.render.width, artifact.input.render.height) }
  }
  /** Both text repair and indexing consume the same raw, provenance-bearing OCR derivative. */
  async function readOcrArtifact(sessionId: string, documentId: string, page: number, signal: AbortSignal,
    recognition?: PageOcrRecognition, expectedSnapshot?: HostWorkspaceSnapshot) {
    const active = AbortSignal.any([signal, recoveryLifetime.signal])
    active.throwIfAborted()
    if (closed) fail('pdf/unavailable', 'PDF service is unloading')
    const snapshot = workspaces.readSnapshot(sessionId, documentId)
    rejectProtected(snapshot)
    const bytesHash = workspaces.bytesHash(snapshot.bytes)
    if (expectedSnapshot && workspaces.bytesHash(expectedSnapshot.bytes) !== bytesHash) fail('pdf/stale-reader', 'PDF changed before text recovery')
    const geometry = snapshot.document.pages[page - 1]
    if (!Number.isSafeInteger(page) || page < 1 || !geometry) fail('pdf/invalid-page', 'Page is outside the document')
    if (!recognition && !options.textRecovery) fail('pdf/text-recovery-unavailable', 'Local PDF text recovery is unavailable')
    const maxEdge = recognition?.maxEdge ?? 2048
    const viewport = new NativeViewport(geometry, 1), factor = maxEdge / Math.max(viewport.width, viewport.height)
    const plan = maxEdge === 1024 ? ocrRegionRenderPlan(geometry, undefined, maxEdge) : {
      rasterWidth: Math.max(1, Math.round(viewport.width * factor)), rasterHeight: Math.max(1, Math.round(viewport.height * factor)),
      x: 0, y: 0, width: Math.max(1, Math.round(viewport.width * factor)), height: Math.max(1, Math.round(viewport.height * factor)),
    }
    const { width, height } = plan
    const image = recognition?.image
    if (image && (image.width !== width || image.height !== height || image.snapshot.path !== snapshot.path
      || workspaces.bytesHash(image.snapshot.bytes) !== bytesHash)) fail('pdf/stale-reader', 'OCR image does not match its canonical source')
    const check = () => {
      active.throwIfAborted()
      if (closed) fail('pdf/unavailable', 'PDF service is unloading')
      const current = workspaces.readSnapshot(sessionId, documentId)
      if (current.conflict || current.path !== snapshot.path || current.contentVersion !== snapshot.contentVersion
        || workspaces.bytesHash(current.bytes) !== bytesHash) fail('pdf/stale-reader', 'PDF changed during page recognition')
      recognition?.check?.()
    }
    check()
    const artifact = await ocrArtifacts.read({
      input: { path: snapshot.path, sourceDigest: bytesHash, page, render: {
        renderer: 'pdfium/156.0.8076.0;native-protocol/1',
        profile: `clean-page-${maxEdge}-rgba8-png-filter0-zlib1-v1`, geometry,
        width, height, annotations: false, forms: false,
      } }, producer: recognition?.producer ?? localProducer, signal: active, check,
      async produce(producerSignal) {
        const produce = async () => {
          producerSignal.throwIfAborted()
          let png = image?.png
          if (!png) {
            const rgba = Buffer.alloc(width * height * 4)
            // The immutable admitted snapshot is derivative input, not a session
            // lease. Surviving subscribers validate their own source and access.
            for (let y = 0; y < height; y += 1024) for (let x = 0; x < width; x += 1024) {
              const w = Math.min(1024, width - x), h = Math.min(1024, height - y)
              const tile = await withHandleLease(async () => {
                producerSignal.throwIfAborted()
                await descriptor(snapshot, producerSignal)
                const started = performance.now()
                try { return await worker.request({ command: 'render', documentId: snapshot.id, pageIndex: page - 1, rotation: 0,
                  rasterWidth: plan.rasterWidth, rasterHeight: plan.rasterHeight, x: plan.x + x, y: plan.y + y,
                  width: w, height: h, annotations: false, forms: false }, undefined, producerSignal) }
                finally { recordIndexPerformance({ stage: 'native-render', durationMs: performance.now() - started, records: 1 }) }
              })
              const shape = z.object({ width: integer, height: integer, format: z.literal('rgba') }).parse(tile.value)
              if (shape.width !== w || shape.height !== h || tile.bytes.length !== w * h * 4) fail('pdf/native-protocol', 'Invalid OCR artifact tile')
              for (let row = 0; row < h; row++) rgba.set(tile.bytes.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * width + x) * 4)
            }
            producerSignal.throwIfAborted()
            const started = performance.now()
            try { png = await (options.encodeOcrPng ?? encodePng)(rgba, width, height, maxEdge === 2048 ? 2048 : 1026) }
            finally { recordIndexPerformance({ stage: 'png-encode', durationMs: performance.now() - started, records: 1, bytes: rgba.byteLength }) }
          }
          producerSignal.throwIfAborted()
          const output = recognition ? await recognition.recognize({ png, width, height }, producerSignal)
            : await options.textRecovery!.recognize(png, width, height, producerSignal)
          producerSignal.throwIfAborted()
          return { inputDigest: `sha256:${createHash('sha256').update(png).digest('hex')}`, output }
        }
        if (recognition) return produce()
        // Cache hits bypass admission. Cold local jobs remain bounded to one
        // owned Tesseract worker; cancellation never blocks another subscriber.
        const task = localRecognition.catch(() => undefined).then(produce)
        localRecognition = task.then(() => undefined, () => undefined)
        return task
      },
    })
    check()
    return { snapshot, artifact }
  }
  async function readOutline(sessionId: string, documentId: string, signal: AbortSignal): Promise<{
    snapshot: HostWorkspaceSnapshot; items: NativeOutlineItem[] | null
  }> { return withHandleLease(async () => {
    signal.throwIfAborted()
    const snapshot = workspaces.readSnapshot(sessionId, documentId)
    rejectProtected(snapshot)
    await descriptor(snapshot, signal)
    const reply = await worker.request({ command: 'outline', documentId }, undefined, signal, -5)
    signal.throwIfAborted()
    const itemSchema: z.ZodType<NativeOutlineItem> = z.lazy(() => z.object({
      title: z.string().max(8191), dest: z.unknown().optional(), url: z.string().max(32768).optional(),
      items: z.array(itemSchema),
    }))
    return { snapshot, items: projectedReaderOutline(snapshot.document, snapshot.baselineOutline,
      z.array(itemSchema).nullable().parse(reply.value)) }
  }) }
  /** Inspection reads base-page ink, not widget appearances; values come from the same draft snapshot. */
  async function renderPageImage(sessionId: string, documentId: string, page: number, maxEdge: number,
    signal: AbortSignal, form?: { includeValues: boolean }) {
    signal.throwIfAborted()
    if (closed) fail('pdf/unavailable', 'PDF service is unloading')
    const snapshot = workspaces.readSnapshot(sessionId, documentId)
    rejectProtected(snapshot)
    if (!Number.isSafeInteger(page) || page < 1 || page > snapshot.document.pageCount) {
      fail('pdf/invalid-page', 'Page is outside the document')
    }
    const geometry = snapshot.document.pages[page - 1]
    if (!geometry) fail('pdf/invalid-page', 'Page geometry is unavailable')
    const formInspection = form ? inspectFormPage(snapshot.document, page, maxEdge, form.includeValues) : undefined
    const plan = formInspection ? {
      width: formInspection.pageRect[2] - formInspection.pageRect[0],
      height: formInspection.pageRect[3] - formInspection.pageRect[1],
    } : pageRenderPlan(geometry, maxEdge)
    const { width, height } = plan
    return withHandleLease(async () => {
      signal.throwIfAborted()
      const current = workspaces.readSnapshot(sessionId, documentId)
      if (current.revision !== snapshot.revision || current.contentVersion !== snapshot.contentVersion) {
        fail('pdf/stale-reader', 'PDF changed before page render; retry')
      }
      await descriptor(snapshot, signal)
      const pixels = new Uint8Array(width * height * 4)
      // Keep the native per-tile bound even for a high-resolution inspection page.
      for (let y = 0; y < height; y += 1024) for (let x = 0; x < width; x += 1024) {
        const tileWidth = Math.min(1024, width - x), tileHeight = Math.min(1024, height - y)
        const reply = await worker.request({ command: 'render', documentId, pageIndex: page - 1,
          rotation: 0, rasterWidth: width, rasterHeight: height, x, y, width: tileWidth, height: tileHeight,
          annotations: !form, forms: !form }, undefined, signal, 10)
        const value = z.object({ width: integer, height: integer, format: z.literal('rgba') }).parse(reply.value)
        if (value.width !== tileWidth || value.height !== tileHeight || reply.bytes.length !== tileWidth * tileHeight * 4) {
          fail('pdf/native-protocol', 'Native page dimensions do not match')
        }
        for (let row = 0; row < tileHeight; row++) {
          pixels.set(reply.bytes.subarray(row * tileWidth * 4, (row + 1) * tileWidth * 4), ((y + row) * width + x) * 4)
        }
      }
      const rgba = formInspection ? paintFormLabels(pixels, width, height, formInspection) : pixels
      const png = await encodePng(rgba, width, height, form ? 2048 : 1026)
      signal.throwIfAborted()
      const latest = workspaces.readSnapshot(sessionId, documentId)
      if (latest.contentVersion !== snapshot.contentVersion || latest.revision !== snapshot.revision) {
        fail('pdf/stale-reader', 'PDF changed during page render; retry')
      }
      return { snapshot, png, width, height, formInspection }
    })
  }
  function renderPage(sessionId: string, documentId: string, page: number, maxEdge: number, signal: AbortSignal) {
    return renderPageImage(sessionId, documentId, page, maxEdge, signal)
  }
  async function renderFormPage(sessionId: string, documentId: string, page: number, maxEdge: number,
    includeValues: boolean, signal: AbortSignal) {
    const rendered = await renderPageImage(sessionId, documentId, page, maxEdge, signal, { includeValues })
    if (!rendered.formInspection) fail('pdf/form-inspection-unavailable', 'Form mapping is unavailable')
    return { ...rendered, formInspection: rendered.formInspection }
  }
  /** Render an unannotated page or PDF-space region for OCR without transporting image bytes from Client. */
  async function renderOcrImage(sessionId: string, documentId: string, page: number,
    region: readonly [number, number, number, number] | undefined, maxEdge: number,
    signal: AbortSignal, forms = true): Promise<{ snapshot: HostWorkspaceSnapshot; png: Buffer; width: number; height: number;
      pdfRegion: [number, number, number, number] }> {
    const raster = await withHandleLease(async () => {
      signal.throwIfAborted()
      const snapshot = workspaces.readSnapshot(sessionId, documentId)
      rejectProtected(snapshot)
      if (!Number.isSafeInteger(page) || page < 1 || page > snapshot.document.pageCount) {
        fail('pdf/invalid-page', 'Page is outside the document')
      }
      const geometry = snapshot.document.pages[page - 1]
      if (!geometry) fail('pdf/invalid-page', 'Page geometry is unavailable')
      const { pdfRegion, ...render } = ocrRegionRenderPlan(geometry, region, maxEdge)
      const { width, height } = render
      const { bytesHash } = await descriptor(snapshot, signal)
      const started = performance.now()
      let reply: Awaited<ReturnType<NativeWorker['request']>>
      try {
        reply = await worker.request({ command: 'render', documentId, pageIndex: page - 1,
          rotation: 0, ...render, annotations: false, forms }, undefined, signal, 10)
      } finally { recordIndexPerformance({ stage: 'native-render', durationMs: performance.now() - started, records: 1 }) }
      const value = z.object({ width: integer, height: integer, format: z.literal('rgba') }).parse(reply.value)
      if (value.width !== width || value.height !== height || reply.bytes.length !== width * height * 4) {
        fail('pdf/native-protocol', 'Native OCR image dimensions do not match')
      }
      return { snapshot, rgba: reply.bytes, bytesHash, width, height, pdfRegion }
    })
    // The reply owns its pixels. Compression no longer holds the mutable native
    // document lease, so queued UI/native reads may proceed while zlib works.
    signal.throwIfAborted()
    if (closed) fail('pdf/unavailable', 'PDF service is unloading')
    const started = performance.now()
    let png: Buffer
    try { png = await (options.encodeOcrPng ?? encodePng)(raster.rgba, raster.width, raster.height) }
    finally { recordIndexPerformance({ stage: 'png-encode', durationMs: performance.now() - started, records: 1, bytes: raster.rgba.byteLength }) }
    signal.throwIfAborted()
    if (closed) fail('pdf/unavailable', 'PDF service is unloading')
    const latest = workspaces.readSnapshot(sessionId, documentId)
    if (latest.contentVersion !== raster.snapshot.contentVersion || latest.revision !== raster.snapshot.revision
        || workspaces.bytesHash(latest.bytes) !== raster.bytesHash) {
      fail('pdf/stale-reader', 'PDF changed during OCR image render; retry')
    }
    const { rgba: _rgba, bytesHash: _bytesHash, ...image } = raster
    return { ...image, png }
  }
  /** Reclaim render state; the registry keeps the document ID and durable draft. */
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
  return { dispatch, native, inspectEncrypted, readPageText, readOutline, readOcrArtifact,
    localOcrIdentity: () => options.textRecovery?.producer,
    renderPage, renderFormPage, renderOcrImage, releaseDocument, diagnostics: () => ({ generation: worker.generation, documents: handles.size, documentBytes: handlesBytes,
    tileCacheBytes: tiles.bytes, tileCacheEntries: tiles.size }),
    async dispose() { closed = true; recoveryLifetime.abort(); tiles.clear(); handles.clear(); histories.clear(); mutations.clear(); handlesBytes = 0
      unregisterNative()
      if (!options.capabilities) capabilities.dispose()
      // Stop producers while draining subscribers: an adapter may need its
      // dispose hook to release recognition that has not observed abort yet.
      const disposed = await Promise.allSettled([ocrArtifacts.dispose(), options.textRecovery?.dispose(), worker.dispose()])
      const rejected = disposed.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
    } }
}

function rejectProtected(snapshot: HostWorkspaceSnapshot): void {
  if (snapshot.document.encrypted) fail('pdf/protected-document', 'Protected PDFs can only be viewed in the Reader')
}
