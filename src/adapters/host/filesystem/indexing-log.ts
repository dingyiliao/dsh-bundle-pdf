import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

interface IndexingLogOptions {
  directory: string
  now?: () => Date
  maxFileBytes?: number
  retentionDays?: number
  maxFiles?: number
  maxPending?: number
  /** Internal filesystem port for deterministic I/O and security regressions. */
  fileSystem?: typeof fileSystem
}
const fileSystem = { chmod, lstat, mkdir, open, readdir, unlink }
interface PendingLine { line: string; date: string; bytes: number }
interface ActiveLog { date: string; segment: number; size: number; handle: Awaited<ReturnType<typeof open>> }

const filenamePattern = /^indexing-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/
const dayMilliseconds = 24 * 60 * 60 * 1000

/** Best-effort, private diagnostics. Events must already exclude document text and credentials. */
export function createIndexingLog(options: IndexingLogOptions) {
  const directory = resolve(options.directory)
  const now = options.now ?? (() => new Date())
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024
  const retentionDays = options.retentionDays ?? 14
  const maxFiles = options.maxFiles ?? 28
  const maxPending = options.maxPending ?? 128
  const io = options.fileSystem ?? fileSystem
  const queue: PendingLine[] = []
  let pending = 0, sealed = false, failure: string | undefined
  let pumping = false, active: ActiveLog | undefined
  let tail = Promise.resolve(), disposal: Promise<void> | undefined

  async function prune(current: string, date: string): Promise<void> {
    const entries = await io.readdir(directory, { withFileTypes: true })
    const files = entries.flatMap(entry => {
      const match = filenamePattern.exec(entry.name)
      if (!entry.isFile() || !match) return []
      const day = Date.parse(`${match[1]}T00:00:00.000Z`)
      return Number.isFinite(day) ? [{ name: entry.name, day, segment: Number(match[2] ?? 0) }] : []
    }).sort((a, b) => a.day - b.day || a.segment - b.segment)
    let remaining = files.length
    const cutoff = Date.parse(`${date}T00:00:00.000Z`) - (retentionDays - 1) * dayMilliseconds
    for (const file of files) {
      if (file.name === current || file.day >= cutoff && remaining <= maxFiles) continue
      await io.unlink(join(directory, file.name))
      remaining--
    }
  }

  async function closeActive(): Promise<void> {
    const current = active; active = undefined
    await current?.handle.close()
  }

  async function activate(date: string, nextSegment?: number): Promise<ActiveLog> {
    await closeActive()
    await io.mkdir(directory, { recursive: true, mode: 0o700 })
    const metadata = await io.lstat(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Invalid log directory')
    await io.chmod(directory, 0o700)
    const entries = nextSegment === undefined ? await io.readdir(directory, { withFileTypes: true }) : []
    let segment = nextSegment ?? entries.reduce((latest, entry) => {
      const match = filenamePattern.exec(entry.name)
      const value = Number(match?.[2] ?? 0)
      return match?.[1] === date && Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER
        ? Math.max(latest, value) : latest
    }, 0)
    for (;;) {
      const filename = `indexing-${date}${segment ? `.${segment}` : ''}.jsonl`
      const path = join(directory, filename)
      // Windows has no O_NOFOLLOW. Reject existing links before opening, and
      // verify the opened descriptor still belongs to the checked pathname.
      try {
        const metadata = await io.lstat(path)
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Invalid log file')
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
      }
      // O_NOFOLLOW protects the final component; O_NONBLOCK prevents a raced-in
      // pipe from retaining the Host before the descriptor is checked below.
      const handle = await io.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
        | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600)
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) throw new Error('Invalid log file')
        const current = await io.lstat(path)
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
          throw new Error('The log file changed while it was opened')
        }
        if (stat.size >= maxFileBytes) { await handle.close(); segment++; continue }
        await handle.chmod(0o600)
        await prune(filename, date)
        active = { date, segment, handle, size: stat.size }
        return active
      } catch (error) { await handle.close().catch(() => {}); throw error }
    }
  }

  async function drain(): Promise<void> {
    try {
      while (queue.length) {
        const batch: PendingLine[] = []
        try {
          const first = queue[0]!
          let current = active?.date === first.date ? active : await activate(first.date)
          if (current.size && current.size + first.bytes > maxFileBytes) current = await activate(first.date, current.segment + 1)
          let bytes = 0
          // Events serialize at admission, then share one append while retaining
          // whole JSONL records and the per-file bound across day/rotation edges.
          while (queue.length && queue[0]!.date === current.date
            && current.size + bytes + queue[0]!.bytes <= maxFileBytes
            && (!batch.length || bytes + queue[0]!.bytes <= 64 * 1024)) {
            const item = queue.shift()!; batch.push(item); bytes += item.bytes
          }
          await current.handle.writeFile(batch.map(item => item.line).join(''), 'utf8')
          current.size += bytes
        } catch {
          failure = 'pdf/index-log-write-failed'
          await closeActive().catch(() => {})
          // A failed record is best-effort, and must not retain an infinite queue.
          if (!batch.length) batch.push(queue.shift()!)
        } finally { pending -= batch.length }
      }
    } finally { pumping = false }
  }

  function schedule(): void {
    if (pumping) return
    pumping = true
    tail = tail.then(drain)
  }

  return {
    directory,
    append(event: Readonly<Record<string, unknown>>): void {
      if (sealed) return
      if (pending >= maxPending) { failure = 'pdf/index-log-queue-full'; return }
      let line: string, date: string, bytes: number
      try {
        const timestamp = now().toISOString()
        date = timestamp.slice(0, 10)
        const record: Record<string, unknown> = { ...event, timestamp }
        delete record.toJSON
        line = `${JSON.stringify(record)}\n`
        bytes = Buffer.byteLength(line)
        if (bytes > Math.min(maxFileBytes, 64 * 1024)) {
          failure = 'pdf/index-log-record-too-large'; return
        }
      } catch { failure = 'pdf/index-log-invalid-event'; return }
      pending++
      queue.push({ line, date, bytes })
      schedule()
    },
    flush(): Promise<void> { return tail },
    dispose(): Promise<void> {
      sealed = true
      return disposal ??= tail.then(() => closeActive()).catch(() => { failure = 'pdf/index-log-write-failed' })
    },
    failureCode(): string | undefined { return failure },
  }
}
