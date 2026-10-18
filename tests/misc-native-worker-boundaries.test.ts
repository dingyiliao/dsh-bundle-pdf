import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { encodeFrame, FrameDecoder } from '../src/engine/framing.ts'
import { NativeWorker, type NativeProcessRuntime } from '../src/engine/native-worker.ts'

type Reply = { requestId: string; ok: boolean; value?: unknown }

function runtime(reply: (request: { command: string; requestId: string }) => Reply,
  missingInput = false): NativeProcessRuntime {
  return {
    async resolveExecutable(command: string) { return command },
    spawn(_spec: SubprocessSpawnSpec): SubprocessHandle {
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
      let finish!: (value: { exitCode: number | null; signal: null }) => void
      const done = new Promise<{ exitCode: number | null; signal: null }>(resolve => { finish = resolve })
      const decoder = new FrameDecoder(frame => {
        const request = frame.metadata as { command: string; requestId: string }
        for (const part of encodeFrame(reply(request), new Uint8Array())) stdout.write(part)
      })
      stdin.on('data', chunk => decoder.feed(chunk))
      return { stdin: missingInput ? undefined : stdin, stdout, stderr, done, control: undefined, collected: {},
        terminate: () => { finish({ exitCode: 0, signal: null }); stdin.destroy(); stdout.destroy(); stderr.destroy() },
        waitForExit: async () => true } as unknown as SubprocessHandle
    },
  }
}

test('native worker rejects a helper with missing protocol pipes', async () => {
  const worker = new NativeWorker('/tmp/not-executed', runtime(() => { throw new Error('not reached') }, true))
  try { await assert.rejects(worker.ready(), { code: 'pdf/native-start' }) }
  finally { await worker.dispose() }
})

test('native worker rejects a helper with a mismatched PDFium build', async () => {
  const worker = new NativeWorker('/tmp/not-executed', runtime(request => ({ requestId: request.requestId,
    ok: true, value: { protocolVersion: 1, build: 'old-build' } })))
  try { await assert.rejects(worker.ready(), { code: 'pdf/native-version' }) }
  finally { await worker.dispose() }
})

test('native worker rejects an uncorrelated reply and retires its process range', async () => {
  const worker = new NativeWorker('/tmp/not-executed', runtime(request => ({
    requestId: request.command === 'hello' ? request.requestId : 'another-request', ok: true,
    value: { protocolVersion: 1, build: '156.0.8076.0' },
  })))
  try {
    await worker.ready()
    await assert.rejects(worker.request({ command: 'read' }), { code: 'pdf/native-protocol' })
  } finally { await worker.dispose() }
})
