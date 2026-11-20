import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PdfDocumentError } from '../../../src/shared/pdf-types.ts'
import { classifyBaselineFailure, createBaselineGateway } from '../../../src/layers/document/working-copy/baseline-gateway.ts'
import type { PdfDocumentPort, ProtectedDocumentPort } from '../../../src/layers/document/working-copy/ports.ts'

const source = { path: '/book.pdf', digest: `sha256:${'a'.repeat(64)}`, version: 'fs-1', size: 3,
  bytes: new Uint8Array([1, 2, 3]) }
const document = { pageCount: 1, pages: [], annotations: [], signed: false, encrypted: false, readOnly: false }

test('baseline gateway acquires an ordinary immutable baseline without owning credentials', async () => {
  const remembered: string[] = []
  const gateway = createBaselineGateway({ async inspect(bytes) {
    assert.equal(bytes, source.bytes)
    return document
  }, async materialize() { throw new Error('unused') } } as PdfDocumentPort, undefined,
  (_bytes, hash) => remembered.push(hash))
  const result = await gateway.acquire(source, { owner: 'agent' })
  assert.equal(result.kind, 'acquired')
  if (result.kind === 'acquired') {
    assert.equal(result.baseline.baselineId, source.digest)
    assert.equal(result.baseline.source, source)
    assert.equal(result.baseline.document, document)
  }
  assert.deepEqual(remembered, [source.digest])
})

test('baseline gateway classifies protected acquisition and never persists access', async () => {
  const pdf = { async inspect() { throw new PdfDocumentError('encrypted', 'password required') },
    async materialize() { throw new Error('unused') } } as PdfDocumentPort
  let password = ''
  const protectedDocument = { async inspect(_bytes, value) {
    password = value ?? ''
    if (!value) throw Object.assign(new Error('password required'), { code: 'pdf/password-required' })
    return { ...document, encrypted: true }
  }, release() {} } as ProtectedDocumentPort
  const gateway = createBaselineGateway(pdf, protectedDocument)
  const missing = await gateway.acquire(source, { owner: 'agent' })
  assert.equal(missing.kind, 'failed')
  if (missing.kind === 'failed') assert.deepEqual({ kind: missing.error.kind, code: missing.error.code },
    { kind: 'protected', code: 'pdf/password-required' })
  const opened = await gateway.acquire(source, { owner: 'agent', password: 'secret' })
  assert.equal(opened.kind, 'acquired')
  assert.equal(password, 'secret')
  if (opened.kind === 'acquired') assert.equal(opened.baseline.document.encrypted, true)
})

test('baseline gateway normalizes protected password and parser failures', async () => {
  const encrypted = new PdfDocumentError('encrypted', 'encrypted')
  const pdf = { async inspect() { throw encrypted }, async materialize() { throw new Error('unused') } } as PdfDocumentPort
  const required = Object.assign(new Error('native password prompt'), { code: 'pdf/password-required' })
  const protectedDocument = { async inspect(_bytes: Uint8Array, password?: string) {
    if (password === 'bad') throw required
    return undefined
  }, release() {} } as ProtectedDocumentPort
  const gateway = createBaselineGateway(pdf, protectedDocument)
  const bad = await gateway.acquire(source, { owner: 'agent', password: 'bad' })
  assert.equal(bad.kind, 'failed')
  if (bad.kind === 'failed') assert.deepEqual({ kind: bad.error.kind, code: bad.error.code },
    { kind: 'protected', code: 'pdf/password-required' })
  const ui = await gateway.acquire(source, { owner: 'ui' })
  assert.equal(ui.kind, 'failed')
  if (ui.kind === 'failed') assert.equal(ui.error.cause, encrypted)
  const agent = await gateway.acquire(source, { owner: 'agent' })
  assert.equal(agent.kind, 'failed')
  if (agent.kind === 'failed') assert.equal(agent.error.code, 'pdf/password-required')
})

test('baseline failure classification preserves capacity and unavailable facts', () => {
  assert.equal(classifyBaselineFailure(Object.assign(new Error('busy'), { code: 'pdf/native-busy' })).kind, 'capacity')
  assert.equal(classifyBaselineFailure(Object.assign(new Error('gone'), { code: 'pdf/native-unavailable' })).kind,
    'native-unavailable')
  assert.equal(classifyBaselineFailure(new Error('other')).kind, 'unknown')
})
