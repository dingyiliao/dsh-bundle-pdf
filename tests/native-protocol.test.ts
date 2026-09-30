import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrameDecoder, encodeFrame, MAX_NATIVE_REPLY } from '../src/engine/framing.ts'
import { NativeWorker } from '../src/engine/native-worker.ts'
import { ByteCache } from '../src/engine/byte-cache.ts'
import { encodePng } from '../src/engine/png.ts'
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

async function fakeWorker() {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-native-test-')), executable = join(directory, 'worker')
  await writeFile(executable, `#!/usr/bin/env node
let input = Buffer.alloc(0)
process.stdin.on('data', chunk => { input = Buffer.concat([input, chunk]); drain() })
function drain() { while (input.length >= 8) { const j=input.readUInt32LE(0),b=input.readUInt32LE(4);if(input.length<8+j+b)return;const q=JSON.parse(input.subarray(8,8+j));input=input.subarray(8+j+b);setTimeout(()=>reply(q),q.command==='hello'?0:40) } }
function reply(q) { if(q.command==='hang')return;const value=q.command==='hello'?{protocolVersion:1,build:'156.0.8076.0'}:{command:q.command};const json=Buffer.from(JSON.stringify({requestId:q.requestId,ok:true,value})),prefix=Buffer.alloc(8);prefix.writeUInt32LE(json.length);process.stdout.write(Buffer.concat([prefix,json])) }
`)
  await chmod(executable, 0o755)
  return { executable, close: () => rm(directory, { recursive: true, force: true }) }
}
test('cancelling an in-flight request consumes its reply before the next request', { skip: process.platform === 'win32' }, async () => {
  const fake = await fakeWorker(), worker = new NativeWorker(fake.executable, 1000)
  try {
    await worker.ready()
    const controller = new AbortController()
    const first = worker.request({ command: 'first' }, undefined, controller.signal)
    await new Promise<void>(resolve => setImmediate(resolve))
    const second = worker.request({ command: 'second' })
    controller.abort()
    await assert.rejects(first, { name: 'AbortError' })
    assert.deepEqual((await second).value, { command: 'second' })
  } finally { worker.dispose(); await fake.close() }
})
test('timeout kills the helper and a later handshake starts a new generation', { skip: process.platform === 'win32' }, async () => {
  const fake = await fakeWorker(), worker = new NativeWorker(fake.executable, 150)
  try {
    await worker.ready(); const firstGeneration = worker.generation
    await assert.rejects(worker.request({ command: 'hang' }), { code: 'pdf/native-timeout' })
    await worker.ready(); assert.equal(worker.generation, firstGeneration + 1)
    assert.deepEqual((await worker.request({ command: 'recovered' })).value, { command: 'recovered' })
  } finally { worker.dispose(); await fake.close() }
})
