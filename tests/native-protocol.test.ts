import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { FrameDecoder, encodeFrame, MAX_NATIVE_REPLY } from '../src/engine/host/framing.ts'
import { NativeWorker, type NativeProcessRuntime } from '../src/engine/host/native-worker.ts'
import { NativeTestSubprocess, nativeTestSubprocess } from './native-test-subprocess.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ByteCache } from '../src/shared/cache/index.ts'
import { encodePng } from '../src/adapters/host/pdfium/png.ts'
import { inflateSync } from 'node:zlib'

test('native frames survive every split boundary and one-byte stdout chunks', () => {
  const expected = { requestId: 'one', ok: true, value: { text: '中文' } }
  const encoded = Buffer.concat(encodeFrame(expected, new Uint8Array([0, 255, 10])))
  for (let split = 0; split <= encoded.length; split++) {
    const frames: unknown[] = [], decoder = new FrameDecoder(frame => frames.push(frame))
    decoder.feed(encoded.subarray(0, split)); decoder.feed(encoded.subarray(split))
    assert.deepEqual(frames, [{ metadata: expected, bytes: Buffer.from([0, 255, 10]) }]); assert.equal(decoder.incomplete, false)
  }
  let count = 0
  const decoder = new FrameDecoder(() => count++)
  for (const byte of Buffer.concat([encoded, encoded])) decoder.feed(new Uint8Array([byte]))
  assert.equal(count, 2)
})
test('native framing rejects oversized prefixes before allocating payloads', () => {
  const prefix = Buffer.alloc(8); prefix.writeUInt32LE(1); prefix.writeUInt32LE(MAX_NATIVE_REPLY + 1, 4)
  assert.throws(() => new FrameDecoder(() => {}).feed(prefix), /length/)
  prefix.writeUInt32LE(0); prefix.writeUInt32LE(0, 4)
  assert.throws(() => new FrameDecoder(() => {}).feed(prefix), /length/)
})
test('byte LRU enforces its budget and releases replaced or evicted resources', () => {
  const released: string[] = [], cache = new ByteCache<string>(10, item => released.push(item))
  cache.set('a', 'first', 6); cache.set('b', 'second', 4); cache.get('a'); cache.set('c', 'third', 4)
  assert.equal(cache.get('b'), undefined); assert.deepEqual(released, ['second']); assert.equal(cache.bytes, 10)
  cache.clear(); assert.equal(cache.bytes, 0); assert.equal(cache.size, 0)
  cache.set('large', 'oversized', 11); assert.equal(cache.size, 0); assert.equal(released.at(-1), 'oversized')
})
test('PNG transport preserves every RGBA byte without a lossy encoding', async () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 30, 255, 128])
  const png = await encodePng(rgba, 2, 1)
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  let offset = 8, compressed: Buffer = Buffer.alloc(0)
  while (offset < png.length) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') compressed = png.subarray(offset + 8, offset + 8 + size)
    offset += size + 12
  }
  assert.deepEqual(inflateSync(compressed), Buffer.from([0, ...rgba]))
})

async function fakeWorker(holdFirst = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-native-test-')), executable = join(directory, 'worker')
  await writeFile(executable, `#!/usr/bin/env node
let input = Buffer.alloc(0), held
process.stdin.on('data', chunk => { input = Buffer.concat([input, chunk]); drain() })
function drain() { while (input.length >= 8) { const j=input.readUInt32LE(0),b=input.readUInt32LE(4);if(input.length<8+j+b)return;const q=JSON.parse(input.subarray(8,8+j));input=input.subarray(8+j+b);setTimeout(()=>reply(q),q.command==='hello'?0:40) } }
function reply(q) {
  if(q.documentId==='hang')return
  if(${holdFirst} && q.documentId==='first') { held=q;process.stderr.write('first-received\\n');return }
  if(q.command==='release-first') { const first=held;held=undefined;replyNow(first);return }
  replyNow(q)
}
function replyNow(q) { const value=q.command==='hello'?{protocolVersion:2,build:'156.0.8076.0'}:{closed:true};const json=Buffer.from(JSON.stringify({requestId:q.requestId,ok:true,value})),prefix=Buffer.alloc(8);prefix.writeUInt32LE(json.length);process.stdout.write(Buffer.concat([prefix,json])) }
`)
  await chmod(executable, 0o755)
  return { executable, close: () => rm(directory, { recursive: true, force: true }) }
}
// Keep an OS-pipe integration proof in addition to the portable stream unit case.
test('real helper pipes retain a cancelled request until its reply is drained', { skip: process.platform === 'win32' }, async () => {
  let acknowledgeFirst!: () => void
  const firstReceived = new Promise<void>(resolve => { acknowledgeFirst = resolve })
  const sent: string[] = []
  class GatedSubprocess extends NativeTestSubprocess {
    private handle?: SubprocessHandle
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const handle = this.handle = super.spawn(spec)
      const incoming = new FrameDecoder(frame => {
        const request = frame.metadata as { command: string; documentId?: string }
        sent.push(request.documentId ?? request.command)
      })
      const stdin = handle.stdin!
      const write = stdin.write.bind(stdin)
      stdin.write = ((chunk: Uint8Array) => { incoming.feed(chunk); return write(chunk) }) as typeof stdin.write
      let diagnostics = ''
      handle.stderr!.on('data', (chunk: Buffer) => {
        diagnostics += chunk.toString()
        if (diagnostics.includes('first-received\n')) acknowledgeFirst()
      })
      return handle
    }
    releaseFirst(): void {
      this.handle!.stdin!.write(Buffer.concat(encodeFrame({ command: 'release-first' })))
    }
  }
  const fake = await fakeWorker(true), subprocess = new GatedSubprocess()
  const worker = new NativeWorker(fake.executable, subprocess, 3000)
  try {
    await worker.ready()
    const controller = new AbortController()
    const first = worker.request({ command: 'close', documentId: 'first' }, undefined, controller.signal)
    // A parent-process tick cannot prove that the child received the command.
    await Promise.race([firstReceived, first.then(() => { throw new Error('First request completed before its reply was released') })])
    const second = worker.request({ command: 'close', documentId: 'second' })
    void second.catch(() => {})
    controller.abort()
    await assert.rejects(first, { name: 'AbortError' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(sent, ['hello', 'first'], 'cancellation must retain the active slot until its reply')
    subprocess.releaseFirst()
    assert.deepEqual((await second).value, { closed: true })
    assert.deepEqual(sent, ['hello', 'first', 'release-first', 'second'])
  } finally { await worker.dispose(); await fake.close() }
})
test('timeout kills the helper and a later handshake starts a new generation', { skip: process.platform === 'win32' }, async () => {
  const fake = await fakeWorker(), worker = new NativeWorker(fake.executable, nativeTestSubprocess, 1000)
  try {
    await worker.ready(); const firstGeneration = worker.generation
    await assert.rejects(worker.request({ command: 'close', documentId: 'hang' }), { code: 'pdf/native-timeout' })
    await worker.ready(); assert.equal(worker.generation, firstGeneration + 1)
    assert.deepEqual((await worker.request({ command: 'close', documentId: 'recovered' })).value, { closed: true })
  } finally { await worker.dispose(); await fake.close() }
})

test('executable lookup failure can be retried on the next handshake', { skip: process.platform === 'win32' }, async () => {
  class FlakyLookupSubprocess extends NativeTestSubprocess {
    attempts = 0
    override async resolveExecutable(command: string): Promise<string> {
      if (++this.attempts === 1) throw new Error('temporary provider failure')
      return super.resolveExecutable(command)
    }
  }
  const fake = await fakeWorker(), subprocess = new FlakyLookupSubprocess()
  const worker = new NativeWorker(fake.executable, subprocess, 3000)
  try {
    await assert.rejects(worker.ready(), { code: 'pdf/native-unavailable' })
    await worker.ready()
    assert.equal(subprocess.attempts, 2)
    assert.equal(worker.generation, 1)
  } finally { await worker.dispose(); await fake.close() }
})

test('spawn failure can be retried on the next handshake', { skip: process.platform === 'win32' }, async () => {
  class FlakySpawnSubprocess extends NativeTestSubprocess {
    attempts = 0
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      if (++this.attempts === 1) throw new Error('temporary launch failure')
      return super.spawn(spec)
    }
  }
  const fake = await fakeWorker(), subprocess = new FlakySpawnSubprocess()
  const worker = new NativeWorker(fake.executable, subprocess, 3000)
  try {
    await assert.rejects(worker.ready(), { code: 'pdf/native-start' })
    await worker.ready()
    assert.equal(subprocess.attempts, 2)
    assert.equal(worker.generation, 1)
  } finally { await worker.dispose(); await fake.close() }
})

test('disposing during executable lookup prevents the pending startup from spawning', { skip: process.platform === 'win32' }, async () => {
  class DelayedLookupSubprocess extends NativeTestSubprocess {
    releaseLookup!: () => void
    lookupStarted!: () => void
    private readonly lookupGate = new Promise<void>(resolve => { this.releaseLookup = resolve })
    readonly enteredLookup = new Promise<void>(resolve => { this.lookupStarted = resolve })
    spawns = 0
    override async resolveExecutable(command: string): Promise<string> {
      this.lookupStarted()
      await this.lookupGate
      return super.resolveExecutable(command)
    }
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      this.spawns++
      return super.spawn(spec)
    }
  }
  const fake = await fakeWorker(), subprocess = new DelayedLookupSubprocess()
  const worker = new NativeWorker(fake.executable, subprocess, 3000)
  try {
    const startup = worker.ready()
    await subprocess.enteredLookup
    const disposal = worker.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(disposed, false, 'dispose waits for the pending lookup to settle')
    subprocess.releaseLookup()
    await assert.rejects(startup, { code: 'pdf/native-unavailable' })
    await disposal
    assert.equal(subprocess.spawns, 0)
  } finally { subprocess.releaseLookup(); await worker.dispose(); await fake.close() }
})

test('a replacement waits for the previous managed process range to exit', async () => {
  // This is a range-ordering proof, independent of OS process startup speed.
  // The real-pipe timeout/restart test above covers the actual deadline path.
  class DelayedRangeSubprocess implements NativeProcessRuntime {
    spawns = 0
    lookups = 0
    exitFirst!: () => void
    releaseRange!: () => void
    private enteredRange!: () => void
    readonly waitingForRange = new Promise<void>(resolve => { this.enteredRange = resolve })
    private readonly rangeGate = new Promise<void>(resolve => { this.releaseRange = resolve })
    async resolveExecutable(command: string): Promise<string> { this.lookups++; return command }
    spawn(_spec: SubprocessSpawnSpec): SubprocessHandle {
      const generation = ++this.spawns
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
      let exit!: () => void
      const done = new Promise<{ exitCode: number; signal: null }>(resolve => {
        exit = () => resolve({ exitCode: 0, signal: null })
      })
      if (generation === 1) this.exitFirst = exit
      const decoder = new FrameDecoder(frame => {
        const request = frame.metadata as { command: string; requestId: string }
        const value = request.command === 'hello'
          ? { protocolVersion: 2, build: '156.0.8076.0' } : { closed: true }
        for (const part of encodeFrame({ requestId: request.requestId, ok: true, value })) stdout.write(part)
      })
      stdin.on('data', chunk => decoder.feed(chunk))
      return { stdin, stdout, stderr, done, control: undefined, collected: {},
        terminate: () => { exit(); stdin.destroy(); stdout.destroy(); stderr.destroy() },
        waitForExit: async () => {
          if (generation === 1) { this.enteredRange(); await this.rangeGate }
          await done
          return true
        },
      } as unknown as SubprocessHandle
    }
  }
  const subprocess = new DelayedRangeSubprocess()
  const worker = new NativeWorker('/not-executed/native-worker', subprocess, 1000)
  try {
    await worker.ready()
    subprocess.exitFirst()
    // Process completion alone is insufficient: the provider is still waiting
    // for its entire managed process range. Synchronize on that actual boundary.
    await subprocess.waitingForRange
    const restart = worker.ready()
    let restarted = false
    void restart.then(() => { restarted = true }, () => {})
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(subprocess.spawns, 1, 'must not overlap native process generations')
    assert.equal(subprocess.lookups, 1, 'replacement startup cannot begin before the old range exits')
    assert.equal(restarted, false)
    subprocess.releaseRange()
    await restart
    assert.equal(subprocess.spawns, 2)
    assert.equal(worker.generation, 2)
    assert.deepEqual((await worker.request({ command: 'close', documentId: 'recovered' })).value, { closed: true })
  } finally { subprocess.releaseRange(); await worker.dispose() }
})
