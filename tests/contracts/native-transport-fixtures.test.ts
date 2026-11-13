import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Buffer } from 'node:buffer'
import { createNativeRequestEnvelope, decodeNativeReplyEnvelope } from '../../src/engine/protocol/transport.ts'
import type { NativeRequest } from '../../src/engine/protocol/commands.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(resolve(here, 'fixtures', name), 'utf8')) as Record<string, unknown>

const splitRequest = (value: Record<string, unknown>) => {
  const { requestId, ...request } = value
  assert.equal(typeof requestId, 'string')
  return { requestId: requestId as string, request: request as NativeRequest }
}

test('Native open fixtures exercise the actual flat v2 request and correlated reply', async () => {
  const { requestId, request } = splitRequest(await fixture('native-open.request.json'))
  const reply = await fixture('native-open.reply.json')

  assert.deepEqual(createNativeRequestEnvelope(request, requestId), { requestId, ...request })
  assert.equal(request.command, 'open')
  assert.equal('nativeHandle' in request, false)
  assert.equal('hostRevision' in request, false)
  const decoded = decodeNativeReplyEnvelope(request, requestId, reply, Buffer.alloc(0))
  assert.ok('value' in decoded)
  if ('value' in decoded) assert.deepEqual(decoded.value, {
    pageCount: 1, formType: 0, signatureCount: 0, signatureStatus: 0,
  })
})

test('Native mutation fixtures exercise annotationEdit without obsolete transaction context', async () => {
  const { requestId, request } = splitRequest(await fixture('native-mutate.request.json'))

  assert.deepEqual(createNativeRequestEnvelope(request, requestId), { requestId, ...request })
  assert.equal(request.command, 'annotationEdit')
  for (const obsolete of ['nativeHandle', 'sourceDigest', 'hostRevision', 'transactionId', 'expectedRevision', 'operationId']) {
    assert.equal(obsolete in request, false, `obsolete mutation context field: ${obsolete}`)
  }
  if (request.command === 'annotationEdit') {
    assert.equal(request.pageIndex, 0)
    assert.equal(request.action, 'add')
  }
})

test('Native transport owns request correlation without changing the flat command payload', () => {
  const request = { command: 'hello' as const }
  const envelope = createNativeRequestEnvelope(request, 'req-1')
  assert.deepEqual(envelope, { command: 'hello', requestId: 'req-1' })
})

test('Native transport validates correlated success and failure replies', () => {
  const request = { command: 'close' as const, documentId: 'doc-1' }
  const success = decodeNativeReplyEnvelope(request, 'req-2', {
    requestId: 'req-2', ok: true, value: { closed: true },
  }, Buffer.alloc(0))
  assert.equal('value' in success, true)
  if ('value' in success) assert.deepEqual(success.value, { closed: true })
  const failure = decodeNativeReplyEnvelope(request, 'req-3', {
    requestId: 'req-3', ok: false, error: { code: 'pdf/test', message: 'failed' },
  }, Buffer.alloc(0))
  assert.deepEqual(failure, { error: { code: 'pdf/test', message: 'failed' } })
  assert.throws(() => decodeNativeReplyEnvelope(request, 'req-4', {
    requestId: 'other', ok: true, value: { closed: true },
  }, Buffer.alloc(0)), /correlation failed/)
})
