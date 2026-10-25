import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import { attachTextRecoveryWorker } from '../../../src/adapters/host/ocr/text-recovery-worker.ts'
import { createLocalTextRecovery } from '../../../src/adapters/host/ocr/local-text-recovery.ts'

test('local recovery worker wires one dispatcher, shipped core/language reads, and explicitly denies networking', async () => {
  let adapter!: Parameters<NonNullable<Parameters<typeof attachTextRecoveryWorker>[2]>['setAdapter']>[0]
  let receive!: (packet: unknown) => void
  const sent: unknown[] = [], packet = { jobId: 'test-job' }
  attachTextRecoveryWorker({ on(_event, listener) { receive = listener }, postMessage(message) { sent.push(message) } },
    resolve('dist/assets/ocr/core/tesseract-core-lstm.js'), {
      setAdapter(value) { adapter = value },
      dispatchHandlers(value, send) { assert.equal(value, packet); send({ done: true }) },
    })
  assert.equal(typeof await adapter.getCore(), 'function')
  assert.ok((await adapter.readCache(resolve('dist/assets/ocr/lang/eng.traineddata.gz'))).byteLength > 0)
  assert.equal(adapter.gunzip(gzipSync('static label')).toString(), 'static label')
  await assert.rejects(adapter.fetch(), /Network access is disabled/)
  receive(packet); assert.deepEqual(sent, [{ done: true }])
})

test('failed recovery startup is observable and does not prevent disposal or a later call', async () => {
  const invalid = createLocalTextRecovery('relative-path')
  await assert.rejects(invalid.recognize(new Uint8Array(), 100, 100, new AbortController().signal), /could not start/)
  await invalid.dispose()
  const absent = createLocalTextRecovery(resolve('does-not-exist'))
  try { await assert.rejects(absent.recognize(new Uint8Array(), 100, 100, new AbortController().signal), /recovery failed/) }
  finally { await absent.dispose() }
  const exited = createLocalTextRecovery(resolve('tests/fixtures/recovery-exit'))
  try { await assert.rejects(exited.recognize(new Uint8Array(), 100, 100, new AbortController().signal), /recovery failed/) }
  finally { await exited.dispose() }
  const invalidImage = createLocalTextRecovery()
  try { await assert.rejects(invalidImage.recognize(new Uint8Array([1]), 100, 100, new AbortController().signal), /recovery failed/) }
  finally { await invalidImage.dispose() }
})
