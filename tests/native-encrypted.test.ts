import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { NativeWorker } from '../src/adapters/host/pdfium/native-worker.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native tests require a built helper')
const skip = !existsSync(executable)
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}.pdf`, import.meta.url))

test('native document info exposes encrypted geometry without fabricating UserUnit', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    assert.deepEqual((await worker.request({ command: 'hello' })).value,
      { protocolVersion: 1, engine: 'pdfium', build: '156.0.8076.0', encryptedOpen: true })
    const opened = (await worker.request({ command: 'open', documentId: 'empty-password' },
      await fixture('encrypted-object-stream'))).value
    assert.deepEqual(opened, { pageCount: 2, formType: 0, signatureCount: 0 }, 'plain open reply remains compatible')
    const security = (await worker.request({ command: 'security', documentId: 'empty-password' })).value as {
      securityRevision: number; permissions: number
    }
    const info = (await worker.request({ command: 'documentInfo', documentId: 'empty-password' })).value as {
      securityRevision: number; permissions: number; title?: string; pages: Array<{
        page: number; mediaBox: number[]; cropBox: number[]; rotation: number; userUnit: number | null
        renderedWidth: number; renderedHeight: number
      }>
    }
    assert.ok(info.securityRevision >= 0)
    assert.ok(Number.isSafeInteger(info.permissions))
    assert.deepEqual(security, { securityRevision: info.securityRevision, permissions: info.permissions })
    assert.equal(info.title, 'Encrypted compatibility fixture')
    assert.deepEqual(info.pages, [
      { page: 1, mediaBox: [0, 0, 400, 600], cropBox: [20, 30, 340, 530], rotation: 90,
        visibleBox: [20, 30, 340, 530], boxSource: 'page-dictionary',
        renderedWidth: 500, renderedHeight: 320, userUnit: null },
      { page: 2, mediaBox: [0, 0, 300, 500], cropBox: [0, 0, 300, 500], rotation: 0,
        visibleBox: [0, 0, 300, 500], boxSource: 'effective-bounds',
        renderedWidth: 300, renderedHeight: 500, userUnit: null },
    ])
    const secondPage = (await worker.request({ command: 'documentInfo', documentId: 'empty-password',
      offset: 1, limit: 1 })).value as { pages: unknown[] }
    assert.deepEqual(secondPage.pages, [info.pages[1]], 'paged documentInfo retains original page numbers')
    await worker.request({ command: 'close', documentId: 'empty-password' })
    await assert.rejects(worker.request({ command: 'documentInfo', documentId: 'empty-password' }),
      { code: 'pdf/native-document' })
  } finally { await worker.dispose() }
})

test('native document info reads inherited encrypted geometry through PDFium effective bounds', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    const bytes = await fixture('encrypted-inherited-boxes')
    await worker.request({ command: 'open', documentId: 'inherited', password: 'fixture-password' }, bytes)
    const info = (await worker.request({ command: 'documentInfo', documentId: 'inherited' })).value as {
      title: string; pages: unknown[]
    }
    assert.equal(info.title, 'Inherited 😀 geometry')
    assert.deepEqual(info.pages, [{ page: 1, mediaBox: [20, 30, 340, 530], cropBox: [20, 30, 340, 530],
      visibleBox: [20, 30, 340, 530], boxSource: 'effective-bounds', rotation: 90,
      renderedWidth: 500, renderedHeight: 320, userUnit: null }])
    assert.deepEqual((await worker.request({ command: 'documentInfo', documentId: 'inherited', offset: 1,
      limit: 1 })).value, { ...info, pages: [] })
    for (const invalid of [{ offset: -1 }, { limit: 0 }, { offset: 2 }, { limit: 2049 }]) {
      await assert.rejects(worker.request({ command: 'documentInfo', documentId: 'inherited', ...invalid }),
        { code: 'pdf/native-request' })
    }
  } finally { await worker.dispose() }
})

test('native security probe distinguishes a plain PDF without enumerating pages', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    const pdf = await PDFDocument.create()
    pdf.addPage([200, 300])
    await worker.request({ command: 'open', documentId: 'plain' }, await pdf.save())
    assert.deepEqual((await worker.request({ command: 'security', documentId: 'plain' })).value,
      { securityRevision: -1, permissions: 0xffffffff })
  } finally { await worker.dispose() }
})

test('native password errors are fixed, retries leave no ghost handle, and valid credentials unlock', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  const bytes = await fixture('password-object-stream')
  try {
    await assert.rejects(worker.request({ command: 'open', documentId: 'protected' }, bytes),
      { code: 'pdf/password-required' })
    await assert.rejects(worker.request({ command: 'open', documentId: 'protected', password: 'wrong' }, bytes),
      { code: 'pdf/password-incorrect' })
    assert.deepEqual((await worker.request({ command: 'open', documentId: 'protected', password: 'fixture-password' }, bytes)).value,
      { pageCount: 2, formType: 0, signatureCount: 0 })
    const info = (await worker.request({ command: 'documentInfo', documentId: 'protected' })).value as { securityRevision: number }
    assert.ok(info.securityRevision >= 0)
  } finally { await worker.dispose() }
})

test('native password validation and unsupported security fail without exposing credential text', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  const bytes = await fixture('password-object-stream')
  try {
    for (const password of [42, 'x'.repeat(4097), 'before\0after']) {
      await assert.rejects(worker.request({ command: 'open', documentId: 'invalid-password', password }, bytes), error => {
        assert.equal((error as { code: string }).code, 'pdf/native-request')
        assert.ok(!String(error).includes(String(password)))
        return true
      })
    }
    const original = bytes.toString('latin1')
    const unsupported = original.replace('/Filter /Standard', '/Filter /Stundard')
    assert.notEqual(unsupported, original, 'the synthetic fixture must contain a standard security dictionary')
    await assert.rejects(worker.request({ command: 'open', documentId: 'unsupported', password: 'fixture-password' },
      Buffer.from(unsupported, 'latin1')), { code: 'pdf/security-unsupported' })
    await assert.rejects(worker.request({ command: 'open', documentId: 'malformed' }, Buffer.from('not a PDF')),
      { code: 'pdf/native-open' })
  } finally { await worker.dispose() }
})
