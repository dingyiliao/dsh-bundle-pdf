import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export interface RetrievalStoreMetric {
  stage: 'store-read' | 'store-write' | 'store-serialize' | 'store-verify'
  durationMs: number
  bytes?: number
  records?: number
  cacheHit?: boolean
}
interface RetrievalStoreOptions {
  directory: string
  maxMemoryBytes?: number
  maxRecordBytes?: number
  onMetric?(metric: RetrievalStoreMetric): void
}
interface CachedRecord { text: string; bytes: number }
interface EncodedRecord { id: string; key: string; text: string; bytes: number }
const databaseName = 'records.sqlite'
const json = z.json()
const hasCode = (error: unknown, code: string) => !!error && typeof error === 'object' && 'code' in error && error.code === code
const failure = (code: string, message: string, cause?: unknown) => Object.assign(new Error(message, { cause }), { code: `pdf/index-storage-${code}` })
function storageError(error: unknown, operation: string): Error {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('pdf/index-storage-')) return error
  if (error && typeof error === 'object' && 'errcode' in error && [11, 26].includes(Number(error.errcode) & 255)) {
    return failure('corrupt', 'The PDF index database is damaged. Rebuild its index storage.', error)
  }
  return failure(`${operation}-failed`, 'The PDF index storage operation failed. Check storage permissions and available disk space.', error)
}

/** SQLite owns complete records and atomic batches; the hot cache owns only
 * bounded, validated immutable strings. No corpus-wide key map enters memory. */
export function createRetrievalStore(options: RetrievalStoreOptions) {
  const directory = resolve(options.directory), databasePath = join(directory, databaseName)
  const maxMemoryBytes = options.maxMemoryBytes ?? 8 * 1024 * 1024
  const maxRecordBytes = options.maxRecordBytes ?? 16 * 1024 * 1024
  if (!Number.isSafeInteger(maxMemoryBytes) || maxMemoryBytes < 0 || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw new RangeError('Invalid PDF index storage limits')
  }
  const sqliteCacheBytes = Math.min(8 * 1024 * 1024, Math.max(64 * 1024, maxMemoryBytes))
  const maxPendingBytes = Math.max(maxMemoryBytes, maxRecordBytes * 2)
  const hot = new Map<string, CachedRecord>()
  let memoryBytes = 0, pendingCalls = 0, pendingBytes = 0, diskReads = 0, diskWrites = 0, cacheHits = 0, commits = 0
  let sealed = false, tail = Promise.resolve(), disposal: Promise<void> | undefined
  let lastYieldAt = performance.now()
  let database: DatabaseSync | undefined, initialization: Promise<DatabaseSync> | undefined, dataVersion = 0

  function metric(event: RetrievalStoreMetric): void {
    try { void Promise.resolve(options.onMetric?.(event)).catch(() => {}) } catch { /* Passive diagnostics cannot own storage. */ }
  }
  function digest(key: string): string {
    if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/.test(key)) {
      throw failure('key', 'The PDF index record key is invalid.')
    }
    return createHash('sha256').update(key).digest('hex')
  }
  async function checkedDirectory(path: string, create = false): Promise<boolean> {
    let stat
    try { stat = await lstat(path) } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
      if (!create) return false
      await mkdir(path, { recursive: true, mode: 0o700 }); stat = await lstat(path)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('unsafe', 'The PDF index storage contains an unsafe directory.')
    if (create) await chmod(path, 0o700)
    return true
  }
  async function checkedDatabaseFiles(): Promise<void> {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const path = databasePath + suffix
      let stat
      try { stat = await lstat(path) } catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error }
      if (!stat.isFile() || stat.isSymbolicLink()) throw failure('unsafe', 'The PDF index storage contains an unsafe database file.')
      await chmod(path, 0o600)
    }
  }
  function forget(id: string): void {
    const previous = hot.get(id)
    if (previous) { hot.delete(id); memoryBytes -= previous.bytes }
  }
  function emptyHot(): void { hot.clear(); memoryBytes = 0 }
  function remember(id: string, text: string): void {
    forget(id)
    const bytes = text.length * 2 + 256
    if (bytes > maxMemoryBytes) return
    while (hot.size && (memoryBytes + bytes > maxMemoryBytes || hot.size >= 1024)) {
      const oldest = hot.entries().next().value!
      hot.delete(oldest[0]); memoryBytes -= oldest[1].bytes
    }
    hot.set(id, { text, bytes }); memoryBytes += bytes
  }
  function encode(key: string, value: unknown): EncodedRecord {
    const started = performance.now(), id = digest(key)
    let text: string
    try {
      const payload = JSON.stringify(json.parse(value))
      const checksum = createHash('sha256').update(payload).digest('hex')
      // Serialize page content once before adding the small identity wrapper.
      text = `{"version":1,"key":${JSON.stringify(key)},"payload":${payload},"checksum":"${checksum}"}`
    } catch { throw failure('invalid-record', 'The PDF index record is not valid JSON data.') }
    const bytes = Buffer.byteLength(text)
    if (bytes > maxRecordBytes) throw failure('record-too-large', 'The PDF index record exceeds its storage limit.')
    metric({ stage: 'store-serialize', durationMs: performance.now() - started, bytes, records: 1 })
    return { id, key, text, bytes }
  }
  function decode(text: string, key: string): unknown {
    const started = performance.now()
    try {
      let value: unknown
      try { value = JSON.parse(text) } catch { throw failure('corrupt', 'The PDF index record is not valid JSON.') }
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('key' in value)
        || value.key !== key || !('payload' in value) || !('checksum' in value)
        || value.checksum !== createHash('sha256').update(JSON.stringify(value.payload)).digest('hex')
        || !json.safeParse(value.payload).success) throw failure('corrupt', 'The PDF index record identity is invalid.')
      return value.payload
    } finally { metric({ stage: 'store-verify', durationMs: performance.now() - started, bytes: Buffer.byteLength(text), records: 1 }) }
  }
  function transaction(db: DatabaseSync, operation: () => void | number, records = 0, bytes = 0): void {
    const started = performance.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      const written = operation()
      if (typeof written === 'number') records = written
      db.exec('COMMIT'); commits++; diskWrites += records
    }
    catch (error) { try { db.exec('ROLLBACK') } catch { /* Preserve the original storage error. */ } throw error }
    finally { metric({ stage: 'store-write', durationMs: performance.now() - started, bytes, records }) }
  }
  function readRow(db: DatabaseSync, id: string) {
    // Read the bounded metadata first inside SQLite. A damaged length column
    // cannot make the JS runtime allocate an arbitrarily large string.
    return db.prepare('SELECT key,bytes,length(CAST(envelope AS BLOB)) AS actualBytes,CASE WHEN length(CAST(envelope AS BLOB)) <= ? THEN envelope END AS envelope FROM records WHERE id = ?')
      .get(maxRecordBytes, id)
  }
  function invalidateExternalWrites(db: DatabaseSync): void {
    const current = Number(db.prepare('PRAGMA data_version').get()!.data_version)
    if (dataVersion && current !== dataVersion) emptyHot()
    dataVersion = current
  }
  function writeRows(db: DatabaseSync, records: readonly EncodedRecord[], cache: boolean): void {
    invalidateExternalWrites(db)
    const statement = db.prepare('INSERT OR REPLACE INTO records(id,key,envelope,bytes) VALUES (?,?,?,?)')
    transaction(db, () => {
      for (const row of records) statement.run(row.id, row.key, row.text, row.bytes)
    }, records.length,
      records.reduce((sum, row) => sum + row.bytes, 0))
    for (const row of records) { if (cache) remember(row.id, row.text); else forget(row.id) }
  }
  async function ensureDatabase(): Promise<DatabaseSync> {
    if (initialization) return initialization
    const pending = (async () => {
      await checkedDirectory(directory, true)
      await checkedDatabaseFiles()
      try {
        const handle = await open(databasePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
        await handle.close()
      } catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
      const db = new DatabaseSync(databasePath)
      try {
        db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-${Math.ceil(sqliteCacheBytes / 1024)}; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA trusted_schema=OFF;`)
        const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
        if (version !== 0 && version !== 1) throw failure('corrupt', 'The PDF index database version is unsupported.')
        db.exec('CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, key TEXT NOT NULL, envelope TEXT NOT NULL, bytes INTEGER NOT NULL); PRAGMA user_version=1;')
        const columns = db.prepare('PRAGMA table_info(records)').all()
        if (columns.map(row => row.name).join(',') !== 'id,key,envelope,bytes' || Number(columns[0]?.pk) !== 1) {
          throw failure('corrupt', 'The PDF index database schema is invalid.')
        }
        await checkedDatabaseFiles()
        database = db
        dataVersion = Number(db.prepare('PRAGMA data_version').get()!.data_version)
        return db
      } catch (error) { database = undefined; db.close(); throw error }
    })()
    initialization = pending
    void pending.catch(() => { if (initialization === pending) initialization = undefined })
    return pending
  }
  function enqueue<T>(operation: string, bytes: number, run: () => Promise<T>): Promise<T> {
    if (sealed) return Promise.reject(failure('closed', 'The PDF index storage is closed.'))
    if (pendingCalls >= 256 || pendingBytes + bytes > maxPendingBytes) {
      return Promise.reject(failure('busy', 'The PDF index storage queue is full. Retry after pending work finishes.'))
    }
    pendingCalls++; pendingBytes += bytes
    const task = tail.then(async () => {
      // DatabaseSync transactions are deliberately atomic. Between operations,
      // let Host input/cancellation run instead of chaining unbounded microtasks.
      if (performance.now() - lastYieldAt >= 8) {
        await new Promise<void>(resolve => setImmediate(resolve)); lastYieldAt = performance.now()
      }
      return run()
    }).catch(error => { throw storageError(error, operation) })
    tail = task.then(() => {}, () => {}).finally(() => { pendingCalls--; pendingBytes -= bytes })
    return task
  }
  return {
    directory,
    async has(key: string): Promise<boolean> {
      const id = digest(key)
      return enqueue('read', 0, async () => {
        const started = performance.now(), db = await ensureDatabase()
        invalidateExternalWrites(db)
        // Summary restoration needs a presence fence, not a decoded page.
        // Full integrity validation remains mandatory when get reads content.
        const row = db.prepare('SELECT key,bytes FROM records WHERE id = ?').get(id)
        diskReads++
        if (row) {
          if (row.key !== key || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1) {
            throw failure('corrupt', 'The PDF index record identity is invalid.')
          }
          if (Number(row.bytes) > maxRecordBytes) throw failure('record-too-large', 'The PDF index record exceeds its storage limit.')
        }
        metric({ stage: 'store-read', durationMs: performance.now() - started, bytes: 0, records: row ? 1 : 0, cacheHit: false })
        return row !== undefined
      })
    },
    async get(key: string): Promise<unknown> {
      const id = digest(key)
      return enqueue('read', 0, async () => {
        const started = performance.now(), db = await ensureDatabase()
        invalidateExternalWrites(db)
        const cached = hot.get(id)
        if (cached) {
          hot.delete(id); hot.set(id, cached); cacheHits++
          const value = JSON.parse(cached.text).payload
          metric({ stage: 'store-read', durationMs: performance.now() - started, bytes: Buffer.byteLength(cached.text), records: 1, cacheHit: true })
          return value
        }
        const row = readRow(db, id)
        diskReads++
        if (!row) { metric({ stage: 'store-read', durationMs: performance.now() - started, records: 0, cacheHit: false }); return undefined }
        if (Number(row.actualBytes) > maxRecordBytes) throw failure('record-too-large', 'The PDF index record exceeds its storage limit.')
        if (row.key !== key || typeof row.envelope !== 'string' || Number(row.bytes) !== Buffer.byteLength(row.envelope)) {
          throw failure('corrupt', 'The PDF index record identity is invalid.')
        }
        const value = decode(row.envelope, key)
        remember(id, row.envelope)
        metric({ stage: 'store-read', durationMs: performance.now() - started, bytes: Number(row.bytes), records: 1, cacheHit: false })
        return value
      })
    },
    async set(key: string, value: unknown): Promise<void> {
      const record = encode(key, value)
      return enqueue('write', record.text.length * 2, async () => { writeRows(await ensureDatabase(), [record], true) })
    },
    async compareAndSet(key: string, expected: unknown, value: unknown): Promise<boolean> {
      const record = encode(key, value), previous = expected === undefined ? undefined : encode(key, expected)
      return enqueue('write', (record.text.length + (previous?.text.length ?? 0)) * 2, async () => {
        const db = await ensureDatabase(); invalidateExternalWrites(db)
        let changed = false
        transaction(db, () => {
          const row = readRow(db, record.id)
          if (row) {
            if (Number(row.actualBytes) > maxRecordBytes) throw failure('record-too-large', 'The PDF index record exceeds its storage limit.')
            if (row.key !== key || typeof row.envelope !== 'string' || Number(row.bytes) !== Buffer.byteLength(row.envelope)) {
              throw failure('corrupt', 'The PDF index record identity is invalid.')
            }
            decode(row.envelope, key)
            if (!previous || row.envelope !== previous.text) return 0
          } else if (previous) return 0
          db.prepare('INSERT OR REPLACE INTO records(id,key,envelope,bytes) VALUES (?,?,?,?)')
            .run(record.id, key, record.text, record.bytes)
          changed = true
          return 1
        }, 0, record.bytes)
        if (changed) remember(record.id, record.text)
        else forget(record.id)
        return changed
      })
    },
    async setMany(entries: readonly (readonly [string, unknown])[]): Promise<void> {
      if (sealed) throw failure('closed', 'The PDF index storage is closed.')
      if (!Array.isArray(entries) || entries.length > 256) throw failure('busy', 'The PDF index batch exceeds its record limit.')
      const records: EncodedRecord[] = []
      let bytes = 0
      for (const [key, value] of entries) {
        const record = encode(key, value)
        bytes += record.text.length * 2
        if (bytes > maxPendingBytes) throw failure('busy', 'The PDF index storage queue is full. Retry after pending work finishes.')
        records.push(record)
      }
      if (!records.length) return
      return enqueue('write', bytes, async () => { writeRows(await ensureDatabase(), records, true) })
    },
    async delete(key: string): Promise<void> {
      const id = digest(key)
      return enqueue('delete', 0, async () => {
        const db = await ensureDatabase(); invalidateExternalWrites(db)
        transaction(db, () => { db.prepare('DELETE FROM records WHERE id = ?').run(id) })
        forget(id)
      })
    },
    async clear(): Promise<void> {
      return enqueue('clear', 0, async () => {
        const db = await ensureDatabase()
        transaction(db, () => { db.exec('DELETE FROM records') })
        emptyHot()
      })
    },
    diagnostics() { return { backend: 'sqlite' as const, sqliteCacheBytes, memoryBytes, entries: hot.size, pendingCalls, pendingBytes, diskReads, diskWrites, cacheHits, commits } },
    dispose(): Promise<void> {
      if (disposal) return disposal
      sealed = true
      disposal = tail.then(() => {
        emptyHot()
        database?.close(); database = undefined; initialization = undefined
      })
      return disposal
    },
  }
}
