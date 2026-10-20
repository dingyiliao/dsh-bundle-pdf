import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { FrameDecoder, encodeFrame, type NativeFrame } from '../../../engine/framing.js'

export interface NativeReply { value: unknown; bytes: Buffer }
/** The native worker uses DSH's execution-world lookup and managed process range. */
export type NativeProcessRuntime = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
interface Job {
  requestId: string; command: object; bytes: Uint8Array; priority: number
  signal?: AbortSignal; abort: () => void; settled: boolean
  resolve(value: NativeReply): void; reject(error: unknown): void
}
const failure = (code: string, message: string) => Object.assign(new Error(message), { code })

/** One PDFium call at a time. Cancellation discards results at tile boundaries. */
export class NativeWorker {
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
    const reply = await this.enqueue({ command: 'hello' }, new Uint8Array(), undefined, 100)
    const value = reply.value as { protocolVersion?: number; build?: string }
    if (value?.protocolVersion !== 1 || value.build !== '156.0.8076.0') {
      const error = failure('pdf/native-version', 'Native helper protocol or PDFium build does not match this plugin')
      this.fail(error); throw error
    }
  }

  async request(command: object, bytes: Uint8Array = new Uint8Array(), signal?: AbortSignal, priority = 0): Promise<NativeReply> {
    signal?.throwIfAborted()
    await this.ready()
    signal?.throwIfAborted()
    return this.enqueue(command, bytes, signal, priority)
  }

  private enqueue(command: object, bytes: Uint8Array, signal?: AbortSignal, priority = 0): Promise<NativeReply> {
    if (this.closed || !this.child) return Promise.reject(failure('pdf/native-unavailable', 'Native worker is unavailable'))
    if (this.queue.length >= 256 || this.queuedBytes + bytes.byteLength > 256 * 1024 * 1024) return Promise.reject(failure('pdf/native-busy', 'Native worker queue is full'))
    return new Promise((resolve, reject) => {
      const job: Job = { requestId: randomUUID(), command, bytes, signal, priority, resolve, reject, settled: false,
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
      for (const part of encodeFrame({ ...job.command, requestId: job.requestId }, job.bytes)) stdin.write(part)
      stdin.uncork()
    } catch (error) { this.fail(error) }
  }

  private receive(frame: NativeFrame): void {
    const job = this.active
    const data = frame.metadata as { requestId?: unknown; ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } }
    if (!job || !data || data.requestId !== job.requestId || typeof data.ok !== 'boolean') {
      this.fail(failure('pdf/native-protocol', 'Native reply correlation failed')); return
    }
    clearTimeout(this.timer); this.active = undefined
    if (data.ok) this.settle(job, undefined, { value: data.value, bytes: frame.bytes })
    else this.settle(job, failure(typeof data.error?.code === 'string' ? data.error.code : 'pdf/native-error',
      typeof data.error?.message === 'string' ? data.error.message : 'Native request failed'))
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
