import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, rename, rmdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

interface LegacyRetrievalStore {
  entries(): Iterable<[string, { payload: unknown }]>
  close(): Promise<void>
}
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
const markerName = 'legacy-v1-complete.json'
const databaseName = 'records.sqlite'
const recordName = /^[a-f0-9]{64}\.json$/
const temporaryName = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/
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
  const migrationRetired = Symbol('migration already completed or cleared')
  const hot = new Map<string, CachedRecord>()
  let memoryBytes = 0, pendingCalls = 0, pendingBytes = 0, diskReads = 0, diskWrites = 0, cacheHits = 0, commits = 0, importedRecords = 0
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
  async function readLegacyText(path: string, maximum = maxRecordBytes): Promise<string | undefined> {
    let handle
    try {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw failure('unsafe', 'The PDF index storage contains an unsafe legacy record.')
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined
      if (hasCode(error, 'ELOOP')) throw failure('unsafe', 'The PDF index storage contains an unsafe legacy record.')
      throw error
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw failure('unsafe', 'The PDF index storage contains an unsafe legacy record.')
      if (stat.size > maximum) throw failure('record-too-large', 'The PDF index record exceeds its storage limit.')
      const bytes = Buffer.alloc(stat.size + 1)
      let count = 0
      while (count < bytes.length) {
        const result = await handle.read(bytes, count, bytes.length - count, count)
        if (!result.bytesRead) break
        count += result.bytesRead
      }
      if (count > maximum || count !== stat.size) throw failure('corrupt', 'The legacy PDF index record changed while it was read.')
      return bytes.subarray(0, count).toString('utf8')
    } finally { await handle.close() }
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
      // Preserve the V1 envelope byte format without traversing positioned
      // page content a second time just to add its small identity wrapper.
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
  function transaction(db: DatabaseSync, operation: () => void, records = 0, bytes = 0): void {
    const started = performance.now()
    db.exec('BEGIN IMMEDIATE')
    try { operation(); db.exec('COMMIT'); commits++; diskWrites += records }
    catch (error) { try { db.exec('ROLLBACK') } catch { /* Preserve the original storage error. */ } throw error }
    finally { metric({ stage: 'store-write', durationMs: performance.now() - started, bytes, records }) }
  }
  function marker(db: DatabaseSync, name: string): boolean {
    const row = db.prepare('SELECT value FROM meta WHERE name = ?').get(name)
    if (row && row.value !== '1') throw failure('corrupt', 'The PDF index migration metadata is invalid.')
    return row !== undefined
  }
  const setMarker = (db: DatabaseSync, name: string) => { db.prepare('INSERT OR REPLACE INTO meta(name,value) VALUES (?,?)').run(name, '1') }
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
  function writeRows(db: DatabaseSync, records: readonly EncodedRecord[], cache: boolean, completedMarker?: string): void {
    invalidateExternalWrites(db)
    const statement = db.prepare('INSERT OR REPLACE INTO records(id,key,envelope,bytes) VALUES (?,?,?,?)')
    transaction(db, () => {
      // A different store may clear while this instance awaits a legacy source.
      // Check under the same write lock as clear, before reviving any old row.
      if (completedMarker && marker(db, completedMarker)) throw migrationRetired
      for (const row of records) statement.run(row.id, row.key, row.text, row.bytes)
    }, records.length,
      records.reduce((sum, row) => sum + row.bytes, 0))
    for (const row of records) { if (cache) remember(row.id, row.text); else forget(row.id) }
  }
  function matchingRecord(db: DatabaseSync, record: EncodedRecord): boolean {
    const previous = readRow(db, record.id)
    if (!previous) return false
    try {
      if (previous.key !== record.key || typeof previous.envelope !== 'string' || Number(previous.actualBytes) > maxRecordBytes
        || Number(previous.bytes) !== Number(previous.actualBytes)) return false
      decode(previous.envelope, record.key)
      return JSON.parse(previous.envelope).checksum === JSON.parse(record.text).checksum
    } catch (error) { if (hasCode(error, 'pdf/index-storage-corrupt')) return false; throw error }
  }
  async function mirrorLegacyMarker(): Promise<void> {
    const path = join(directory, markerName), previous = await readLegacyText(path, 512)
    if (previous === '{"version":1}') return
    if (previous !== undefined) {
      try { if (JSON.parse(previous)?.version === 1) return } catch { /* Invalid markers must not be overwritten. */ }
      throw failure('corrupt', 'The PDF index migration marker is invalid.')
    }
    const temporary = join(directory, `${randomUUID()}.migration.tmp`)
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { await handle.writeFile('{"version":1}'); await handle.sync() } finally { await handle.close() }
      await rename(temporary, path)
      if (process.platform !== 'win32') {
        const parent = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
        try { await parent.sync() } finally { await parent.close() }
      }
    } finally { await unlink(temporary).catch(() => {}) }
  }
  async function importFiles(db: DatabaseSync, signal?: AbortSignal): Promise<void> {
    if (marker(db, 'file-v1-imported')) return
    const oldMarker = await readLegacyText(join(directory, markerName), 512)
    if (oldMarker !== undefined) {
      try { if (JSON.parse(oldMarker)?.version !== 1) throw new Error('Invalid version') }
      catch { throw failure('corrupt', 'The PDF index migration marker is invalid.') }
    }
    for await (const entry of await opendir(directory)) {
      signal?.throwIfAborted()
      if (!/^[a-f0-9]{2}$/.test(entry.name)) continue
      const bucket = join(directory, entry.name)
      await checkedDirectory(bucket)
      for await (const file of await opendir(bucket)) {
        signal?.throwIfAborted()
        if (marker(db, 'file-v1-imported')) return
        if (!recordName.test(file.name)) continue
        const path = join(bucket, file.name), text = await readLegacyText(path)
        if (text === undefined) continue
        let key: string
        try { key = JSON.parse(text).key; if (digest(key) !== file.name.slice(0, -5)) throw new Error('Wrong key') }
        catch { throw failure('corrupt', 'The legacy PDF index record identity is invalid.') }
        decode(text, key)
        const record = { id: digest(key), key, text, bytes: Buffer.byteLength(text) }
        if (!matchingRecord(db, record)) {
          try { writeRows(db, [record], false, 'file-v1-imported'); importedRecords++ }
          catch (error) { if (error === migrationRetired) return; throw error }
        }
        signal?.throwIfAborted()
        await unlink(path).catch(error => { if (!hasCode(error, 'ENOENT')) throw error })
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      try { await rmdir(bucket) } catch (error) { if (!hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'ENOENT')) throw error }
    }
    signal?.throwIfAborted()
    transaction(db, () => { setMarker(db, 'file-v1-imported'); if (oldMarker !== undefined) setMarker(db, 'legacy-v1-complete') })
  }
  async function ensureDatabase(signal?: AbortSignal, skipImport = false): Promise<DatabaseSync> {
    if (initialization) return initialization
    const pending = (async () => {
      signal?.throwIfAborted()
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
        db.exec('CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, key TEXT NOT NULL, envelope TEXT NOT NULL, bytes INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS meta(name TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;')
        const columns = db.prepare('PRAGMA table_info(records)').all()
        const metaColumns = db.prepare('PRAGMA table_info(meta)').all()
        if (columns.map(row => row.name).join(',') !== 'id,key,envelope,bytes' || Number(columns[0]?.pk) !== 1
          || metaColumns.map(row => row.name).join(',') !== 'name,value' || Number(metaColumns[0]?.pk) !== 1) {
          throw failure('corrupt', 'The PDF index database schema is invalid.')
        }
        db.exec('CREATE INDEX IF NOT EXISTS records_key ON records(key COLLATE BINARY)')
        const keyIndex = db.prepare('PRAGMA index_xinfo(records_key)').all().filter(row => row.key === 1)
        if (keyIndex.length !== 1 || keyIndex[0]!.name !== 'key' || keyIndex[0]!.coll !== 'BINARY') {
          throw failure('corrupt', 'The PDF index database key index is invalid.')
        }
        await checkedDatabaseFiles()
        database = db
        if (!skipImport) await importFiles(db, signal)
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
  async function removeLegacyFiles(): Promise<void> {
    for await (const entry of await opendir(directory)) {
      if (!/^[a-f0-9]{2}$/.test(entry.name)) continue
      const bucket = join(directory, entry.name)
      await checkedDirectory(bucket)
      for await (const file of await opendir(bucket)) {
        if (!recordName.test(file.name) && !temporaryName.test(file.name)) continue
        if (file.isDirectory()) throw failure('unsafe', 'The PDF index storage contains an unsafe legacy record.')
        await unlink(join(bucket, file.name))
      }
      try { await rmdir(bucket) } catch (error) { if (!hasCode(error, 'ENOTEMPTY')) throw error }
    }
  }
  return {
    directory,
    /** Ordered, page-local snapshots for bounded derived-data migrations.
     * Consumers own returned payloads; the hot cache never retains scan pages.
     * One large record may exceed the page's memory target, but never its
     * record limit, so low-memory callers can still make forward progress. */
    async scan(prefix: string, afterKey?: string, limit = 16): Promise<{ entries: [string, unknown][]; nextKey?: string }> {
      digest(prefix)
      if (afterKey !== undefined) {
        digest(afterKey)
        if (!afterKey.startsWith(prefix)) throw failure('key', 'The PDF index scan cursor belongs to a different prefix.')
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw failure('limit', 'The PDF index scan page limit is invalid.')
      return enqueue('read', 0, async () => {
        const started = performance.now(), db = await ensureDatabase()
        invalidateExternalWrites(db)
        db.exec('BEGIN')
        try {
          // Only bounded metadata enters JS before the byte budget is known.
          // All valid keys are ASCII; DEL is a strict upper prefix boundary.
          const rows = db.prepare('SELECT id,key,bytes,length(CAST(envelope AS BLOB)) AS actualBytes FROM records WHERE key COLLATE BINARY >= ? AND key COLLATE BINARY < ? AND key COLLATE BINARY > ? ORDER BY key COLLATE BINARY LIMIT ?')
            .all(prefix, `${prefix}\u007f`, afterKey ?? '', limit + 1)
          const entries: [string, unknown][] = []
          let bytes = 0, more = false
          for (const row of rows) {
            if (entries.length === limit) { more = true; break }
            let id: string
            try { id = digest(row.key as string) } catch { throw failure('corrupt', 'The PDF index record identity is invalid.') }
            const size = Number(row.actualBytes)
            if (row.id !== id || !(row.key as string).startsWith(prefix) || !Number.isSafeInteger(row.bytes)
              || !Number.isSafeInteger(size) || size < 1 || row.bytes !== size) {
              throw failure('corrupt', 'The PDF index record identity is invalid.')
            }
            if (size > maxRecordBytes) throw failure('record-too-large', 'The PDF index record exceeds its storage limit.')
            if (entries.length && bytes + size > maxMemoryBytes) { more = true; break }
            const record = readRow(db, id)
            diskReads++
            if (!record || record.key !== row.key || typeof record.envelope !== 'string'
              || Buffer.byteLength(record.envelope) !== size) throw failure('corrupt', 'The PDF index record identity is invalid.')
            entries.push([row.key as string, decode(record.envelope, row.key as string)])
            bytes += size
          }
          db.exec('COMMIT')
          metric({ stage: 'store-read', durationMs: performance.now() - started, bytes, records: entries.length, cacheHit: false })
          return { entries, ...(more ? { nextKey: entries.at(-1)![0] } : {}) }
        } catch (error) { try { db.exec('ROLLBACK') } catch { /* Preserve the original read error. */ } throw error }
      })
    },
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
        const db = await ensureDatabase(undefined, true)
        transaction(db, () => { db.exec('DELETE FROM records'); setMarker(db, 'file-v1-imported'); setMarker(db, 'legacy-v1-complete') })
        emptyHot()
        await removeLegacyFiles()
        await mirrorLegacyMarker()
      })
    },
    async migrateLegacy(loader: () => Promise<LegacyRetrievalStore>, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted()
      return enqueue('migration', 0, async () => {
        signal?.throwIfAborted()
        const db = await ensureDatabase(signal)
        signal?.throwIfAborted()
        if (marker(db, 'legacy-v1-complete')) { await mirrorLegacyMarker(); return }
        const legacy = await loader()
        try {
          signal?.throwIfAborted()
          for (const [key, value] of legacy.entries()) {
            signal?.throwIfAborted()
            if (marker(db, 'legacy-v1-complete')) break
            const record = encode(key, value.payload)
            if (!matchingRecord(db, record)) {
              try { writeRows(db, [record], false, 'legacy-v1-complete') }
              catch (error) { if (error === migrationRetired) break; throw error }
            }
            signal?.throwIfAborted()
            await new Promise<void>(resolve => setImmediate(resolve))
          }
        } finally { await legacy.close() }
        signal?.throwIfAborted()
        transaction(db, () => setMarker(db, 'legacy-v1-complete'))
        await mirrorLegacyMarker()
      }).catch(error => { signal?.throwIfAborted(); throw error })
    },
    diagnostics() { return { backend: 'sqlite' as const, sqliteCacheBytes, memoryBytes, entries: hot.size, pendingCalls, pendingBytes, diskReads, diskWrites, cacheHits, commits, importedRecords } },
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
