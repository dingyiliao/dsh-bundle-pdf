import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { encodeFrame, FrameDecoder } from '../src/engine/host/framing.ts'
import { NativeWorker, type NativeProcessRuntime } from '../src/engine/host/native-worker.ts'

type Request = { command: string; requestId: string; documentId?: string }
type Reply = { requestId: string; ok: boolean; value?: unknown; error?: { code: string; message: string }; bytes?: Uint8Array }

function runtime(reply: (request: Request, send: (value: Reply) => void) => Reply | void,
  missingInput = false): NativeProcessRuntime {
  return {
    async resolveExecutable(command: string) { return command },
    spawn(_spec: SubprocessSpawnSpec): SubprocessHandle {
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
      let finish!: (value: { exitCode: number | null; signal: null }) => void
      const done = new Promise<{ exitCode: number | null; signal: null }>(resolve => { finish = resolve })
      const send = ({ bytes, ...value }: Reply) => { for (const part of encodeFrame(value, bytes)) stdout.write(part) }
      const decoder = new FrameDecoder(frame => {
        const value = reply(frame.metadata as Request, send)
        if (value) send(value)
      })
      stdin.on('data', chunk => decoder.feed(chunk))
      return { stdin: missingInput ? undefined : stdin, stdout, stderr, done, control: undefined, collected: {},
        terminate: () => { finish({ exitCode: 0, signal: null }); stdin.destroy(); stdout.destroy(); stderr.destroy() },
        waitForExit: async () => true } as unknown as SubprocessHandle
    },
  }
}

// Portable queue coverage also exercises replies delivered synchronously by a stream.
test('synchronous managed pipes drain a cancelled reply before sending the next command', async () => {
  const commands: string[] = []
  let firstReceived!: () => void, releaseFirst!: () => void
  const entered = new Promise<void>(resolve => { firstReceived = resolve })
  const worker = new NativeWorker('/tmp/not-executed', runtime((request, send) => {
    commands.push(request.documentId ?? request.command)
    if (request.command === 'hello') return { requestId: request.requestId, ok: true,
      value: { protocolVersion: 2, build: '156.0.8076.0' } }
    const response = { requestId: request.requestId, ok: true, value: { closed: true } }
    if (request.documentId !== 'first') return response
    releaseFirst = () => send(response)
    firstReceived()
  }), 3000)
  try {
    await worker.ready()
    const controller = new AbortController()
    const first = worker.request({ command: 'close', documentId: 'first' }, undefined, controller.signal)
    await entered
    const second = worker.request({ command: 'close', documentId: 'second' })
    const cancelled = assert.rejects(first, { name: 'AbortError' })
    controller.abort()
    await cancelled
    assert.deepEqual(commands, ['hello', 'first'], 'cancelled work retains the wire slot until its reply arrives')
    releaseFirst()
    assert.deepEqual((await second).value, { closed: true })
    assert.deepEqual(commands, ['hello', 'first', 'second'])
    assert.equal(worker.generation, 1, 'draining cancellation must not restart the process')
  } finally { await worker.dispose() }
})

test('native worker rejects a helper with missing protocol pipes', async () => {
  const worker = new NativeWorker('/tmp/not-executed', runtime(() => { throw new Error('not reached') }, true))
  try { await assert.rejects(worker.ready(), { code: 'pdf/native-start' }) }
  finally { await worker.dispose() }
})

test('native worker rejects a helper with a mismatched PDFium build', async () => {
  const worker = new NativeWorker('/tmp/not-executed', runtime(request => ({ requestId: request.requestId,
    ok: true, value: { protocolVersion: 2, build: 'old-build' } })))
  try { await assert.rejects(worker.ready(), { code: 'pdf/native-version' }) }
  finally { await worker.dispose() }
})

test('native worker rejects an uncorrelated reply and retires its process range', async () => {
  const worker = new NativeWorker('/tmp/not-executed', runtime(request => ({
    requestId: request.command === 'hello' ? request.requestId : 'another-request', ok: true,
    value: { protocolVersion: 2, build: '156.0.8076.0' },
  })))
  try {
    await worker.ready()
    await assert.rejects(worker.request({ command: 'close', documentId: 'read' }), { code: 'pdf/native-protocol' })
  } finally { await worker.dispose() }
})

test('native worker surfaces a correlated error reply without losing its process range', async () => {
  const worker = new NativeWorker('/tmp/not-executed', runtime(request => request.command === 'hello'
    ? { requestId: request.requestId, ok: true, value: { protocolVersion: 2, build: '156.0.8076.0' } }
    : request.documentId === 'invalid'
      ? { requestId: request.requestId, ok: false,
          error: { code: 'pdf/invalid-page', message: 'Page does not exist' } }
      : { requestId: request.requestId, ok: true, value: { closed: true } }))
  try {
    await worker.ready()
    const generation = worker.generation
    await assert.rejects(worker.request({ command: 'close', documentId: 'invalid' }), { code: 'pdf/invalid-page',
      message: 'Page does not exist' })
    assert.deepEqual((await worker.request({ command: 'close', documentId: 'valid' })).value, { closed: true })
    assert.equal(worker.generation, generation)
  } finally { await worker.dispose() }
})

test('native worker rejects a correlated success with the wrong command response', async () => {
  const worker = new NativeWorker('/tmp/not-executed', runtime(request => ({
    requestId: request.requestId, ok: true, value: { protocolVersion: 2, build: '156.0.8076.0' },
  })))
  try {
    await worker.ready()
    await assert.rejects(worker.request({ command: 'close', documentId: 'invalid' }), { code: 'pdf/native-protocol' })
    await worker.ready()
    assert.equal(worker.generation, 2, 'a malformed success retires the untrusted helper')
  } finally { await worker.dispose() }
})

test('native worker rejects incomplete raster bytes despite matching metadata', async () => {
  const worker = new NativeWorker('/tmp/not-executed', runtime(request => ({
    requestId: request.requestId, ok: true,
    ...(request.command === 'hello'
      ? { value: { protocolVersion: 2, build: '156.0.8076.0' } }
      : { value: { format: 'rgba', width: 1, height: 1 }, bytes: new Uint8Array(3) }),
  })))
  try {
    await assert.rejects(worker.request({ command: 'render', documentId: 'invalid', pageIndex: 0,
      rotation: 0, rasterWidth: 1, rasterHeight: 1, x: 0, y: 0, width: 1, height: 1 }),
    { code: 'pdf/native-protocol' })
  } finally { await worker.dispose() }
})

test('native worker rejects unexpected request bytes without sending the command', async () => {
  const seen: string[] = []
  const worker = new NativeWorker('/tmp/not-executed', runtime(request => {
    seen.push(request.command)
    return { requestId: request.requestId, ok: true, value: { protocolVersion: 2, build: '156.0.8076.0' } }
  }))
  try {
    await assert.rejects(worker.request({ command: 'open', documentId: 'empty' }), { code: 'pdf/native-request' })
    await assert.rejects(worker.request({ command: 'close', documentId: 'invalid' }, new Uint8Array(1)), { code: 'pdf/native-request' })
    assert.deepEqual(seen, ['hello'])
    assert.equal(worker.generation, 1)
  } finally { await worker.dispose() }
})

test('native worker retires the helper when an error reply carries bytes', async () => {
  const worker = new NativeWorker('/tmp/not-executed', runtime(request => request.command === 'hello'
    ? { requestId: request.requestId, ok: true, value: { protocolVersion: 2, build: '156.0.8076.0' } }
    : { requestId: request.requestId, ok: false, error: { code: 'pdf/invalid-page', message: 'Page does not exist' },
      bytes: new Uint8Array(1) }))
  try {
    await assert.rejects(worker.request({ command: 'close', documentId: 'invalid' }), { code: 'pdf/native-protocol' })
    await worker.ready()
    assert.equal(worker.generation, 2)
  } finally { await worker.dispose() }
})
