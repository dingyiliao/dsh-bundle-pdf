import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { FrameDecoder, encodeFrame, type NativeFrame } from './framing.ts'

export interface NativeReply { value: unknown; bytes: Buffer }
interface Job {
  requestId: string; command: object; bytes: Uint8Array; priority: number
  signal?: AbortSignal; abort: () => void; settled: boolean
  resolve(value: NativeReply): void; reject(error: unknown): void
}
const failure = (code: string, message: string) => Object.assign(new Error(message), { code })

/** One PDFium call at a time. Cancellation discards results at tile boundaries. */
export class NativeWorker {
  private child?: ChildProcessWithoutNullStreams
  private active?: Job
  private queue: Job[] = []
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private startup?: Promise<void>
  private queuedBytes = 0
  generation = 0
  get pid(): number | undefined { return this.child?.pid }
  constructor(readonly executable: string, private readonly timeoutMs = 30_000) {}

  async ready(): Promise<void> {
    if (this.closed) throw failure('pdf/native-unavailable', 'Native worker is closed')
    if (this.startup) return this.startup
    const child = spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child; this.generation++
    const decoder = new FrameDecoder(frame => this.receive(frame))
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      try { decoder.feed(chunk) } catch { this.fail(failure('pdf/native-protocol', 'Invalid native worker reply')) }
    })
    // Do not retain unbounded diagnostics, paths or PDF contents from a subprocess.
    child.stderr.resume()
    child.on('error', () => { if (this.child === child) this.fail(failure('pdf/native-start', 'Could not launch the native PDF worker')) })
    child.on('exit', () => { if (this.child === child) this.fail(failure('pdf/native-crashed', 'Native worker exited; reopen the PDF to recover')) })
    child.stdin.on('error', () => { if (this.child === child) this.fail(failure('pdf/native-crashed', 'Native worker input closed')) })
    const handshake = this.enqueue({ command: 'hello' }, new Uint8Array(), undefined, 100).then(reply => {
      const value = reply.value as { protocolVersion?: number; build?: string }
      if (value?.protocolVersion !== 1 || value.build !== '156.0.8076.0') {
        const error = failure('pdf/native-version', 'Native helper protocol or PDFium build does not match this plugin')
        this.fail(error); throw error
      }
    })
    this.startup = handshake
    try { await handshake } catch (error) { if (this.startup === handshake) this.startup = undefined; throw error }
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
    child?.kill('SIGKILL')
  }
  dispose(): void { this.closed = true; this.fail(failure('pdf/native-unavailable', 'Native worker disposed')) }
}
