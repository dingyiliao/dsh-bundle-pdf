import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { NativeReply, NativeRequest } from '../protocol/commands.js'
import { maxFormFontBytes } from '../protocol/forms.js'
import { createNativeRequestEnvelope, decodeNativeReplyEnvelope } from '../protocol/transport.js'
import { FrameDecoder, encodeFrame, type NativeFrame } from './framing.js'
import type { NativePayloadFor, NativePdfPort, NativeRequestFor } from './native-port.js'

export type { NativeReply } from '../protocol/commands.js'
/** The native worker uses DSH's execution-world lookup and managed process range. */
export type NativeProcessRuntime = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
interface Job {
  requestId: string; command: NativeRequest; bytes: Uint8Array; priority: number
  signal?: AbortSignal; abort: () => void; settled: boolean
  resolve(value: NativeReply): void; reject(error: unknown): void
}
const failure = (code: string, message: string) => Object.assign(new Error(message), { code })

/** One PDFium call at a time. Cancellation discards results at tile boundaries. */
export class NativeWorker implements NativePdfPort {
  private child?: SubprocessHandle
  private active?: Job
  private queue: Job[] = []
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private readonly lifecycleAbort = new AbortController()
  private startup?: Promise<void>
  private retiring?: Promise<void>
  private queuedBytes = 0
  generation = 0
  encryptedOpen = false
  encryptedAnnotationEdit = false
  selectionGeometry = false
  documentExtensions = false
  constructor(readonly executable: string, private readonly subprocess: NativeProcessRuntime,
    private readonly timeoutMs = 30_000) {}

  async ready(): Promise<void> {
    if (this.closed) throw failure('pdf/native-unavailable', 'Native worker is closed')
    if (this.startup) return this.startup
    const startup = this.start()
    this.startup = startup
    void startup.catch(() => { if (this.startup === startup) this.startup = undefined })
    return startup
  }

  private async start(): Promise<void> {
    // A replacement must not share the PDFium document world with a still-live
    // predecessor. Wait for the provider's observable process range; the macOS
    // provider uses a process-group fallback rather than a native range owner.
    if (this.retiring) await this.retiring
    if (this.closed) throw failure('pdf/native-unavailable', 'Native worker is closed')
    let executable: string
    try { executable = await this.subprocess.resolveExecutable(this.executable, undefined, this.lifecycleAbort.signal) }
    catch { throw failure('pdf/native-unavailable', 'Native helper is unavailable; install the PDF package for this platform') }
    if (this.closed) throw failure('pdf/native-unavailable', 'Native worker is closed')
    let child: SubprocessHandle
    try {
      child = this.subprocess.spawn({ argv: [executable], cwd: dirname(executable),
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 250 })
    } catch { throw failure('pdf/native-start', 'Could not launch the native PDF worker') }
    this.child = child; this.generation++
    if (!child.stdin || !child.stdout || !child.stderr) {
      const error = failure('pdf/native-start', 'Native worker did not provide the required pipes')
      this.fail(error); throw error
    }
    const decoder = new FrameDecoder(frame => this.receive(frame))
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      try { decoder.feed(chunk) } catch { this.fail(failure('pdf/native-protocol', 'Invalid native worker reply')) }
    })
    child.stdout.on('error', () => { if (this.child === child) this.fail(failure('pdf/native-crashed', 'Native worker output closed')) })
    // Do not retain unbounded diagnostics, paths or PDF contents from a subprocess.
    child.stderr.resume()
    child.stderr.on('error', () => { /* Diagnostics are intentionally discarded. */ })
    void child.done.then(
      () => { if (this.child === child) this.fail(failure('pdf/native-crashed', 'Native worker exited; reopen the PDF to recover')) },
      () => { if (this.child === child) this.fail(failure('pdf/native-start', 'Could not launch the native PDF worker')) },
    )
    child.stdin.on('error', () => { if (this.child === child) this.fail(failure('pdf/native-crashed', 'Native worker input closed')) })
    const { value } = await this.enqueue({ command: 'hello' }, new Uint8Array(), undefined, 100)
    if (value?.protocolVersion !== 2 || value.build !== '156.0.8076.0') {
      const error = failure('pdf/native-version', 'Native helper protocol or PDFium build does not match this plugin')
      this.fail(error); throw error
    }
    this.encryptedOpen = value.encryptedOpen === true
    this.encryptedAnnotationEdit = value.encryptedAnnotationEdit === true
    this.selectionGeometry = value.selectionGeometry === true
    this.documentExtensions = value.documentExtensions === true
  }

  async request<T extends NativeRequest>(command: T, bytes: Uint8Array = new Uint8Array(), signal?: AbortSignal,
    priority = 0): Promise<NativeReply<T['command']>> {
    signal?.throwIfAborted()
    await this.ready()
    signal?.throwIfAborted()
    const maxBytes = command.command === 'open' ? 256 * 1024 * 1024
      : command.command === 'applyFormFields' ? maxFormFontBytes : 0
    if (bytes.byteLength > maxBytes || (command.command === 'open' && bytes.byteLength === 0)) {
      throw failure('pdf/native-request', 'Invalid native request binary payload')
    }
    return this.enqueue(command, bytes, signal, priority)
  }

  async openDocument(documentId: string, bytes: Uint8Array,
    options: { password?: string; metadataOnly?: true } = {}): Promise<NativeReply<'open'>> {
    return this.request({ command: 'open', documentId, ...options }, bytes)
  }

  async closeDocument(documentId: string): Promise<void> {
    await this.request({ command: 'close', documentId })
  }

  inspectSecurity(request: NativePayloadFor<'security'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'security', ...request }, undefined, signal, priority)
  }
  inspectDocument(request: NativePayloadFor<'documentInfo'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'documentInfo', ...request }, undefined, signal, priority)
  }
  getPageFingerprints(request: NativePayloadFor<'fingerprints'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'fingerprints', ...request }, undefined, signal, priority)
  }
  readOutlines(request: NativePayloadFor<'documentOutlines'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'documentOutlines', ...request }, undefined, signal, priority)
  }
  readOutlineTree(request: NativePayloadFor<'outline'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'outline', ...request }, undefined, signal, priority)
  }
  listAnnotationPages(request: NativePayloadFor<'annotationPages'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'annotationPages', ...request }, undefined, signal, priority)
  }
  inspectFormFields(request: NativePayloadFor<'formFields'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'formFields', ...request }, undefined, signal, priority)
  }
  writeOutlines(request: NativePayloadFor<'applyOutlines'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'applyOutlines', ...request }, undefined, signal, priority)
  }
  writeFormFields(request: NativePayloadFor<'applyFormFields'>, bytes: Uint8Array, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'applyFormFields', ...request }, bytes, signal, priority)
  }
  readAnnotations(request: NativePayloadFor<'annotations'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'annotations', ...request }, undefined, signal, priority)
  }
  editAnnotation(request: NativePayloadFor<'annotationEdit'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'annotationEdit', ...request } as NativeRequestFor<'annotationEdit'>, undefined, signal, priority)
  }
  readText(request: NativePayloadFor<'text'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'text', ...request }, undefined, signal, priority)
  }
  readLinks(request: NativePayloadFor<'links'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'links', ...request }, undefined, signal, priority)
  }
  readSelectionGeometry(request: NativePayloadFor<'selectionGeometry'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'selectionGeometry', ...request }, undefined, signal, priority)
  }
  resolveDestination(request: NativePayloadFor<'destination'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'destination', ...request }, undefined, signal, priority)
  }
  renderPage(request: NativePayloadFor<'render'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'render', ...request }, undefined, signal, priority)
  }
  inspectPage(request: NativePayloadFor<'inspect'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'inspect', ...request }, undefined, signal, priority)
  }
  materializeCopy(request: NativePayloadFor<'saveCopy'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'saveCopy', ...request }, undefined, signal, priority)
  }
  readMaterializedChunk(request: NativePayloadFor<'saveChunk'>, signal?: AbortSignal, priority?: number) {
    return this.request({ command: 'saveChunk', ...request }, undefined, signal, priority)
  }

  private enqueue<T extends NativeRequest>(command: T, bytes: Uint8Array, signal?: AbortSignal,
    priority = 0): Promise<NativeReply<T['command']>> {
    if (this.closed || !this.child) return Promise.reject(failure('pdf/native-unavailable', 'Native worker is unavailable'))
    if (this.queue.length >= 256 || this.queuedBytes + bytes.byteLength > 256 * 1024 * 1024) return Promise.reject(failure('pdf/native-busy', 'Native worker queue is full'))
    return new Promise((resolve, reject) => {
      const job: Job = { requestId: randomUUID(), command, bytes, signal, priority,
        // The active job's command selects the response decoder before settlement.
        resolve: reply => resolve(reply as NativeReply<T['command']>), reject, settled: false,
        abort: () => {
          this.settle(job, signal?.reason ?? failure('pdf/cancelled', 'Native request cancelled'))
          const index = this.queue.indexOf(job)
          if (index >= 0) { this.queue.splice(index, 1); this.queuedBytes -= bytes.byteLength }
          // An already-running synchronous render keeps its slot until its reply.
        } }
      signal?.addEventListener('abort', job.abort, { once: true })
      if (signal?.aborted) { job.abort(); return }
      const index = this.queue.findIndex(item => item.priority < priority)
      if (index < 0) this.queue.push(job); else this.queue.splice(index, 0, job)
      this.queuedBytes += bytes.byteLength
      this.pump()
    })
  }

  private pump(): void {
    if (this.active || !this.child) return
    const job = this.queue.shift()
    if (!job) return
    this.queuedBytes -= job.bytes.byteLength; this.active = job
    this.timer = setTimeout(() => this.fail(failure('pdf/native-timeout', 'Native request timed out; reopen the PDF to recover')), this.timeoutMs)
    this.timer.unref()
    try {
      const stdin = this.child.stdin
      if (!stdin) { this.fail(failure('pdf/native-start', 'Native worker input pipe is unavailable')); return }
      stdin.cork()
      for (const part of encodeFrame(createNativeRequestEnvelope(job.command, job.requestId), job.bytes)) stdin.write(part)
      stdin.uncork()
    } catch (error) { this.fail(error) }
  }

  private receive(frame: NativeFrame): void {
    const job = this.active
    if (!job) { this.fail(failure('pdf/native-protocol', 'Native reply correlation failed')); return }
    let decoded: NativeReply | { error?: { code?: string; message?: string } }
    try { decoded = decodeNativeReplyEnvelope(job.command, job.requestId, frame.metadata, frame.bytes) }
    catch { this.fail(failure('pdf/native-protocol', 'Invalid native worker reply')); return }
    clearTimeout(this.timer); this.active = undefined
    if ('value' in decoded) this.settle(job, undefined, decoded)
    else this.settle(job, failure(typeof decoded.error?.code === 'string' ? decoded.error.code : 'pdf/native-error',
      typeof decoded.error?.message === 'string' ? decoded.error.message : 'Native request failed'))
    this.pump()
  }

  private settle(job: Job, error?: unknown, value?: NativeReply): void {
    if (job.settled) return
    job.settled = true; job.signal?.removeEventListener('abort', job.abort)
    if (error !== undefined) job.reject(error); else job.resolve(value!)
  }

  private fail(error: unknown): void {
    clearTimeout(this.timer)
    const child = this.child; this.child = undefined; this.startup = undefined
    if (this.active) this.settle(this.active, error)
    for (const job of this.queue) this.settle(job, error)
    this.active = undefined; this.queue = []; this.queuedBytes = 0
    if (child) {
      // Attach a rejection handler immediately while retaining the rejection:
      // a later ready()/dispose() must not silently treat an unobserved range
      // as safely retired.
      const retiring = (async () => {
        child.terminate()
        const [, range] = await Promise.allSettled([child.done, child.waitForExit()])
        if (range.status === 'rejected') throw range.reason
        if (!range.value) throw failure('pdf/native-unavailable', 'Native worker range did not exit')
        // A spawn/provider failure can reject done even after its range exited;
        // quiescence, not exit status, is the safe restart boundary.
      })()
      this.retiring = retiring
      void retiring.catch(() => {})
    }
  }
  async dispose(): Promise<void> {
    const startup = this.startup
    this.closed = true
    this.lifecycleAbort.abort()
    this.fail(failure('pdf/native-unavailable', 'Native worker disposed'))
    // A lookup may still be settling when dispose is called. The closed check
    // in start() prevents a late spawn, and this wait closes the startup task.
    const [, retired] = await Promise.allSettled([startup, this.retiring])
    if (retired.status === 'rejected') throw retired.reason
  }
}
