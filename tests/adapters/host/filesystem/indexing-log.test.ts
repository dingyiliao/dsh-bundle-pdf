import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIndexingLog } from '../../../../src/adapters/host/filesystem/indexing-log.ts'
import * as fileSystem from 'node:fs/promises'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-index-log-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, directory: join(root, 'logs', 'desktop') }
}

/** Exercise the same rejection on Windows without requiring symlink privileges. */
async function addLink(t: TestContext, io: typeof fileSystem, target: string, path: string, type: 'file' | 'dir' = 'file') {
  if (process.platform !== 'win32') return symlink(target, path, type)
  if (type === 'dir') await mkdir(path, { recursive: true })
  else await writeFile(path, 'simulated symbolic link')
  const readMetadata = io.lstat, readDirectory = io.readdir
  t.mock.method(io, 'lstat', async (input: Parameters<typeof fileSystem.lstat>[0]) => {
    const metadata = await readMetadata(input)
    if (String(input) === path) t.mock.method(metadata, 'isSymbolicLink', () => true)
    return metadata
  })
  t.mock.method(io, 'readdir', async (input: Parameters<typeof fileSystem.readdir>[0]) => {
    const entries = await readDirectory(input, { withFileTypes: true })
    for (const entry of entries) {
      if (join(String(input), entry.name) !== path) continue
      t.mock.method(entry, 'isFile', () => false)
      t.mock.method(entry, 'isSymbolicLink', () => true)
    }
    return entries
  })
}

test('index diagnostics append immutable timestamped JSONL and survive writer recreation', async t => {
  const { directory } = await fixture(t)
  const now = () => new Date('2026-10-31T12:30:00.000Z')
  const log = createIndexingLog({ directory, now })
  const event = { event: 'started', timestamp: 'not authoritative', count: 1 }
  log.append(event)
  event.count = 99
  log.append({ event: 'ready', count: 2 })
  await log.flush()
  const file = join(directory, 'indexing-2026-10-31.jsonl')
  assert.deepEqual((await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [
    { event: 'started', timestamp: now().toISOString(), count: 1 },
    { event: 'ready', count: 2, timestamp: now().toISOString() },
  ])
  assert.equal(log.directory, directory)
  assert.equal(log.failureCode(), undefined)
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
  await log.dispose()
  const reopened = createIndexingLog({ directory, now })
  reopened.append({ event: 'started-again' })
  await reopened.dispose()
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3)
})

test('daily logs rotate before exceeding size and retain only the latest bounded segments', async t => {
  const { directory } = await fixture(t)
  let date = '2026-10-30'
  const log = createIndexingLog({ directory, now: () => new Date(`${date}T12:00:00Z`),
    maxFileBytes: 100, maxFiles: 2 })
  log.append({ event: 'one' }); log.append({ event: 'two' }); log.append({ event: 'three' })
  await log.flush()
  assert.deepEqual((await readdir(directory)).sort(), ['indexing-2026-10-30.1.jsonl', 'indexing-2026-10-30.2.jsonl'])
  for (const file of await readdir(directory)) assert.ok((await stat(join(directory, file))).size <= 100)
  date = '2026-10-31'
  log.append({ event: 'next-day' })
  await log.dispose()
  assert.deepEqual((await readdir(directory)).sort(), ['indexing-2026-10-30.2.jsonl', 'indexing-2026-10-31.jsonl'])
})

test('retention removes only expired regular owned logs and never unrelated files or links', async t => {
  const { root, directory } = await fixture(t)
  const io = { ...fileSystem }
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'indexing-2026-10-16.jsonl'), 'expired\n')
  await writeFile(join(directory, 'indexing-2026-10-18.jsonl'), 'keep\n')
  await writeFile(join(directory, 'notes.txt'), 'unrelated')
  await writeFile(join(directory, 'indexing-2026-99-99.jsonl'), 'invalid date')
  await mkdir(join(directory, 'indexing-2026-10-01.jsonl'))
  const target = join(root, 'outside')
  await writeFile(target, 'preserve')
  const link = join(directory, 'indexing-2026-10-02.jsonl')
  await addLink(t, io, target, link)
  const log = createIndexingLog({ directory, now: () => new Date('2026-10-31T00:00:00Z'), fileSystem: io })
  log.append({ event: 'ready' })
  await log.dispose()
  assert.equal((await readdir(directory)).includes('indexing-2026-10-16.jsonl'), false)
  assert.equal(await readFile(join(directory, 'indexing-2026-10-18.jsonl'), 'utf8'), 'keep\n')
  assert.equal(await readFile(target, 'utf8'), 'preserve')
  assert.ok((await readdir(directory)).includes('indexing-2026-10-02.jsonl'))
  assert.ok((await readdir(directory)).includes('notes.txt'))
  assert.ok((await readdir(directory)).includes('indexing-2026-99-99.jsonl'))
  assert.ok((await stat(join(directory, 'indexing-2026-10-01.jsonl'))).isDirectory())
})

test('bounded pending writes drop excess events without blocking admitted writes or shutdown', async t => {
  const { directory } = await fixture(t)
  const log = createIndexingLog({ directory, maxPending: 2, now: () => new Date('2026-10-31') })
  log.append({ event: 'first' }); log.append({ event: 'second' }); log.append({ event: 'dropped' })
  assert.equal(log.failureCode(), 'pdf/index-log-queue-full')
  await log.flush()
  log.append({ event: 'after-flush' })
  const disposal = log.dispose()
  assert.equal(log.dispose(), disposal)
  log.append({ event: 'after-dispose' })
  await disposal
  const events = (await readFile(join(directory, 'indexing-2026-10-31.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event)
  assert.deepEqual(events, ['first', 'second', 'after-flush'])
})

test('invalid, circular and oversized events are isolated and later valid events still persist', async t => {
  const { directory } = await fixture(t)
  const log = createIndexingLog({ directory, maxFileBytes: 256 })
  const circular: Record<string, unknown> = {}; circular.self = circular
  log.append(circular)
  assert.equal(log.failureCode(), 'pdf/index-log-invalid-event')
  log.append({ event: 'x'.repeat(300) })
  assert.equal(log.failureCode(), 'pdf/index-log-record-too-large')
  log.append({ event: 'valid' })
  log.append({ event: 'still-json', toJSON: () => undefined })
  await log.dispose()
  assert.equal((await readdir(directory)).length, 1)
  const serialized = await readFile(join(directory, (await readdir(directory))[0]!), 'utf8')
  assert.deepEqual(serialized.trim().split('\n').map(line => JSON.parse(line).event), ['valid', 'still-json'])
  const large = createIndexingLog({ directory })
  large.append({ event: 'x'.repeat(65536) })
  assert.equal(large.failureCode(), 'pdf/index-log-record-too-large')
  await large.dispose()
  const invalidClock = createIndexingLog({ directory, now: () => new Date(NaN) })
  invalidClock.append({ event: 'bad-clock' })
  assert.equal(invalidClock.failureCode(), 'pdf/index-log-invalid-event')
  await invalidClock.flush()
})

test('I/O failures resolve safely without leaking error details and a later write can recover', async t => {
  const { root } = await fixture(t)
  const directory = join(root, 'blocked')
  await writeFile(directory, 'not a directory')
  const log = createIndexingLog({ directory, now: () => new Date('2026-10-31') })
  log.append({ event: 'failed' })
  await log.flush()
  assert.equal(log.failureCode(), 'pdf/index-log-write-failed')
  await rm(directory)
  log.append({ event: 'recovered' })
  await log.dispose()
  assert.match(await readFile(join(directory, 'indexing-2026-10-31.jsonl'), 'utf8'), /recovered/)
})

test('log-file and directory symlinks cannot redirect diagnostic writes', async t => {
  const { root, directory } = await fixture(t)
  const io = { ...fileSystem }, opening = t.mock.method(io, 'open')
  await mkdir(directory, { recursive: true })
  const target = join(root, 'target')
  await writeFile(target, 'untouched')
  await addLink(t, io, target, join(directory, 'indexing-2026-10-31.jsonl'))
  const log = createIndexingLog({ directory, now: () => new Date('2026-10-31'), fileSystem: io })
  log.append({ event: 'unsafe' })
  await log.dispose()
  assert.equal(log.failureCode(), 'pdf/index-log-write-failed')
  assert.equal(await readFile(target, 'utf8'), 'untouched')
  const linkedDirectory = join(root, 'linked-logs')
  await addLink(t, io, directory, linkedDirectory, 'dir')
  const linked = createIndexingLog({ directory: linkedDirectory, fileSystem: io })
  linked.append({ event: 'unsafe-directory' })
  await linked.dispose()
  assert.equal(linked.failureCode(), 'pdf/index-log-write-failed')
  assert.equal(opening.mock.callCount(), 0, 'links are refused before opening or changing either target')
})

test('filesystem metadata rejects links and special files before opening even without OS no-follow support', async t => {
  for (const kind of ['link', 'special', 'unreadable'] as const) {
    const { directory } = await fixture(t), path = join(directory, 'indexing-2026-11-01.jsonl')
    await mkdir(directory, { recursive: true }); await writeFile(path, 'untouched')
    const io = { ...fileSystem }, opening = t.mock.method(io, 'open')
    t.mock.method(io, 'lstat', async (input: Parameters<typeof fileSystem.lstat>[0]) => {
      const metadata = await fileSystem.lstat(input)
      if (String(input) !== path) return metadata
      if (kind === 'unreadable') throw Object.assign(new Error('private filesystem detail'), { code: 'EACCES' })
      if (kind === 'link') t.mock.method(metadata, 'isSymbolicLink', () => true)
      else t.mock.method(metadata, 'isFile', () => false)
      return metadata
    })
    const log = createIndexingLog({ directory, now: () => new Date('2026-11-01'), fileSystem: io })
    log.append({ event: 'unsafe' }); await log.dispose()
    assert.equal(log.failureCode(), 'pdf/index-log-write-failed', kind)
    assert.equal(opening.mock.callCount(), 0, kind)
    assert.equal(await readFile(path, 'utf8'), 'untouched', kind)
  }
})

test('opening a descriptor for a different file never changes its permissions or contents', async t => {
  const { root, directory } = await fixture(t), target = join(root, 'outside')
  await mkdir(directory, { recursive: true }); await writeFile(target, 'untouched', { mode: 0o644 })
  await writeFile(join(directory, 'indexing-2026-11-01.jsonl'), '')
  let closes = 0, changes = 0
  const io = { ...fileSystem, open: async () => {
    const handle = await fileSystem.open(target, 'a'), close = handle.close.bind(handle)
    t.mock.method(handle, 'chmod', async () => { changes++ })
    t.mock.method(handle, 'writeFile', async () => { changes++ })
    t.mock.method(handle, 'close', async () => { closes++; await close() })
    return handle
  } }
  const log = createIndexingLog({ directory, now: () => new Date('2026-11-01'), fileSystem: io })
  log.append({ event: 'unsafe' }); await log.dispose()
  assert.equal(log.failureCode(), 'pdf/index-log-write-failed')
  assert.equal(closes, 1); assert.equal(changes, 0)
  assert.equal(await readFile(target, 'utf8'), 'untouched')
})

test('bursts share one append and later flushes reuse a private descriptor without rescanning the directory', async t => {
  const { directory } = await fixture(t)
  let writes = 0, closes = 0
  const io = { ...fileSystem, mkdir: t.mock.fn(fileSystem.mkdir), lstat: t.mock.fn(fileSystem.lstat),
    chmod: t.mock.fn(fileSystem.chmod), readdir: t.mock.fn(fileSystem.readdir),
    open: t.mock.fn(async (...args: Parameters<typeof fileSystem.open>) => {
      const handle = await fileSystem.open(...args), write = handle.writeFile.bind(handle), close = handle.close.bind(handle)
      t.mock.method(handle, 'writeFile', async (...input: Parameters<typeof handle.writeFile>) => { writes++; return write(...input) })
      t.mock.method(handle, 'close', async () => { closes++; return close() })
      return handle
    }),
  }
  const log = createIndexingLog({ directory, now: () => new Date('2026-11-01'), fileSystem: io })
  try {
    for (let index = 0; index < 32; index++) log.append({ event: 'progress', index })
    await log.flush()
    assert.equal(writes, 1, 'Serialized records in one burst share a bounded append')
    for (let index = 32; index < 42; index++) { log.append({ event: 'progress', index }); await log.flush() }
    assert.equal(writes, 11)
    assert.equal(io.mkdir.mock.callCount(), 1); assert.equal(io.lstat.mock.callCount(), 3)
    assert.equal(io.chmod.mock.callCount(), 1); assert.equal(io.readdir.mock.callCount(), 2)
    assert.equal(io.open.mock.callCount(), 1); assert.equal(closes, 0)
  } finally { await log.dispose() }
  assert.equal(closes, 1)
  const events = (await readFile(join(directory, 'indexing-2026-11-01.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(events.map(event => event.index), Array.from({ length: 42 }, (_, index) => index))
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'indexing-2026-11-01.jsonl'))).mode & 0o777, 0o600)
})

test('in-flight batched records count toward backpressure and dispose drains all admitted records once', async t => {
  const { directory } = await fixture(t)
  let release!: () => void, start!: () => void, writes = 0
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { start = resolve })
  const io = { ...fileSystem, open: async (...args: Parameters<typeof fileSystem.open>) => {
    const handle = await fileSystem.open(...args), write = handle.writeFile.bind(handle)
    t.mock.method(handle, 'writeFile', async (...input: Parameters<typeof handle.writeFile>) => {
      writes++; start(); await gate; return write(...input)
    })
    return handle
  } }
  const log = createIndexingLog({ directory, maxPending: 3, fileSystem: io, now: () => new Date('2026-11-01') })
  try {
    log.append({ event: 'first' }); log.append({ event: 'second' })
    await started
    log.append({ event: 'third' }); log.append({ event: 'dropped' })
    assert.equal(log.failureCode(), 'pdf/index-log-queue-full')
    const flushing = log.flush(), disposal = log.dispose()
    assert.equal(log.dispose(), disposal)
    log.append({ event: 'sealed' }); release()
    await flushing; await disposal
    assert.equal(writes, 2)
    const events = (await readFile(join(directory, 'indexing-2026-11-01.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event)
    assert.deepEqual(events, ['first', 'second', 'third'])
  } finally { release(); await log.dispose() }
})

test('rotation revalidates the private directory rather than following a replacement symlink', async t => {
  const { root, directory } = await fixture(t), outside = join(root, 'outside')
  const io = { ...fileSystem }
  await mkdir(outside)
  const log = createIndexingLog({ directory, maxFileBytes: 100, now: () => new Date('2026-11-01'), fileSystem: io })
  try {
    log.append({ event: 'first' }); await log.flush()
    if (process.platform !== 'win32') await rm(directory, { recursive: true })
    await addLink(t, io, outside, directory, 'dir')
    log.append({ event: 'rotated' }); await log.flush()
    assert.equal(log.failureCode(), 'pdf/index-log-write-failed')
    assert.deepEqual(await readdir(outside), [])
  } finally { await log.dispose() }
})

test('reopening a full segment advances without overwriting its existing records', async t => {
  const { directory } = await fixture(t)
  await mkdir(directory, { recursive: true })
  const full = 'x'.repeat(100), path = join(directory, 'indexing-2026-11-01.jsonl')
  await writeFile(path, full)
  const log = createIndexingLog({ directory, maxFileBytes: 100, now: () => new Date('2026-11-01') })
  log.append({ event: 'after-restart' }); await log.dispose()
  assert.equal(await readFile(path, 'utf8'), full)
  assert.equal(JSON.parse((await readFile(join(directory, 'indexing-2026-11-01.1.jsonl'), 'utf8')).trim()).event, 'after-restart')
  assert.equal(log.failureCode(), undefined)
})

test('descriptor, append and close faults remain best-effort and never retain admitted queue entries', async t => {
  const { directory } = await fixture(t)
  let mode: 'stat' | 'append' | 'dispose' = 'stat', closes = 0
  const io = { ...fileSystem, open: async (...args: Parameters<typeof fileSystem.open>) => {
    const handle = await fileSystem.open(...args), write = handle.writeFile.bind(handle), close = handle.close.bind(handle)
    if (mode === 'stat') t.mock.method(handle, 'stat', async () => { throw new Error('private stat detail') })
    t.mock.method(handle, 'writeFile', async (...input: Parameters<typeof handle.writeFile>) => {
      if (mode === 'append') throw Object.assign(new Error('private disk detail'), { code: 'ENOSPC' })
      return write(...input)
    })
    t.mock.method(handle, 'close', async () => { closes++; await close(); throw new Error('private close detail') })
    return handle
  } }
  const log = createIndexingLog({ directory, fileSystem: io, now: () => new Date('2026-11-01') })
  log.append({ event: 'stat-fault' }); await log.flush()
  assert.equal(log.failureCode(), 'pdf/index-log-write-failed'); assert.equal(closes, 1)
  mode = 'append'; log.append({ event: 'append-fault' }); await log.flush()
  assert.equal(log.failureCode(), 'pdf/index-log-write-failed'); assert.equal(closes, 2)
  mode = 'dispose'; log.append({ event: 'persisted' }); await log.dispose()
  assert.equal(log.failureCode(), 'pdf/index-log-write-failed'); assert.equal(closes, 3)
  assert.equal(JSON.parse((await readFile(join(directory, 'indexing-2026-11-01.jsonl'), 'utf8')).trim()).event, 'persisted')
})
