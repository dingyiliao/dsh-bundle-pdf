import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { deflateSync } from 'node:zlib'
import { NativeWorker } from '../src/engine/host/native-worker.ts'
import { classicPdf } from './native-fixture.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const requireExtensions = process.env.DSH_PDF_REQUIRE_NATIVE_EXTENSIONS === '1'
const skip = !existsSync(executable)
if (skip && (requireExtensions || process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1')) {
  throw new Error('Native metadata tests require a built helper')
}

async function hasExtensions(t: TestContext, worker: NativeWorker): Promise<boolean> {
  const { value } = await worker.request({ command: 'hello' })
  if (value.documentExtensions) return true
  assert.ok(!requireExtensions, 'This build is expected to include PDFium document extensions')
  t.skip('Native helper uses the stock PDFium SDK')
  return false
}

function contentStream(program: string, compressed = false): string {
  const payload = compressed ? deflateSync(program).toString('latin1') : program
  return `<< /Length ${payload.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n${payload}\nendstream`
}

test('native metadata reads inherited, normalized boxes and page-local UserUnit', { skip }, async t => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    if (!await hasExtensions(t, worker)) return
    const bytes = classicPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /MediaBox [600 800 10 20] /CropBox [-5 24 500 700] /Rotate -90 /UserUnit 9 >>',
      '<< /Type /Page /Parent 2 0 R /UserUnit 2.5 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /CropBox [10 20 290 380] /Rotate 0 >>',
      '<< /Type /Page /Parent 2 0 R /UserUnit /Invalid >>',
    ])
    await worker.request({ command: 'open', documentId: 'geometry' }, bytes)
    const { value: { pages } } = await worker.request({ command: 'documentInfo', documentId: 'geometry' })
    assert.deepEqual(pages, [
      { page: 1, mediaBox: [10, 20, 600, 800], cropBox: [-5, 24, 500, 700],
        visibleBox: [10, 24, 500, 700], rotation: 270, userUnit: 2.5, boxSource: 'page-dictionary',
        renderedWidth: 676, renderedHeight: 490 },
      { page: 2, mediaBox: [0, 0, 300, 400], cropBox: [10, 20, 290, 380],
        visibleBox: [10, 20, 290, 380], rotation: 0, userUnit: 1, boxSource: 'page-dictionary',
        renderedWidth: 280, renderedHeight: 360 },
      { page: 3, mediaBox: [10, 24, 500, 700], cropBox: [10, 24, 500, 700],
        visibleBox: [10, 24, 500, 700], rotation: 270, userUnit: null, boxSource: 'effective-bounds',
        renderedWidth: 676, renderedHeight: 490 },
    ])
  } finally { await worker.dispose() }
})

test('native signature inspection covers catalog permissions, nested fields, and compressed objects', { skip }, async t => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    if (!await hasExtensions(t, worker)) return
    const pageTree = [
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>',
    ]
    const nested = (value: string) => classicPdf([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>',
      ...pageTree,
      `<< /T (Parent) /Kids [5 0 R] >>`,
      `<< /Parent 4 0 R /T (Signature) /FT /Sig ${value} >>`,
    ])
    const catalogOnly = classicPdf([
      '<< /Type /Catalog /Pages 2 0 R /Perms << /DocMDP << /Contents <0102> >> >> >>',
      ...pageTree,
    ])
    const brokenPermissions = classicPdf(['<< /Type /Catalog /Pages 2 0 R /Perms 9 0 R >>', ...pageTree])
    const recoveredUnsigned = await readFile(new URL('./fixtures/v1-storage/source.pdf', import.meta.url))
    const catalogBody = Buffer.from(catalogOnly).toString('latin1').split('\nxref\n', 1)[0]
    const recoveredSigned = Buffer.from(`${catalogBody}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1')
    for (const [id, bytes, expected] of [
      ['unsigned-field', nested(''), 0],
      ['nested-field', nested('/V << /ByteRange [0 10 12 15] /Contents <0102> >>'), 1],
      ['catalog-only', catalogOnly, 1],
      ['broken-permissions', brokenPermissions, -1],
      ['recovered-unsigned', recoveredUnsigned, 0],
      ['recovered-signed', recoveredSigned, 1],
    ] as const) {
      const { value } = await worker.request({ command: 'open', documentId: id }, bytes)
      assert.equal(value.signatureCount, 0, `upstream top-level-only count for ${id}`)
      assert.equal(value.signatureStatus, expected, id)
      if (expected !== 0) {
        await assert.rejects(worker.request({ command: 'annotationEdit', documentId: id,
          pageIndex: 0, action: 'add', annotation: { id: 'denied', subtype: 'Text', rect: [12, 12, 30, 30] } }),
        { code: 'pdf/annotation-permission' })
        await assert.rejects(worker.request({ command: 'saveCopy', documentId: id }), { code: 'pdf/annotation-permission' })
      }
    }
  } finally { await worker.dispose() }
})

function indexedPdf(options: { annotation?: boolean; paint?: string; cyclic?: boolean } = {}): Uint8Array {
  return classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 200 300] >>',
    `<< /Type /Page /Parent 2 0 R /Contents ${options.annotation ? '[5 0 R]' : '5 0 R'} ${
      options.annotation ? '/Annots [7 0 R] /Resources << /ProcSet [/PDF] /Font << >> >>' :
      options.cyclic ? '/Resources << /XObject << /Bad 8 0 R >> >>' : ''
    } >>`,
    '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>',
    contentStream(`${options.paint ?? '0.2'} g 10 10 40 50 re f\n`, options.annotation),
    contentStream('0.6 g 20 20 40 50 re f\n'),
    '<< /Type /Annot /Subtype /Text /Rect [30 30 45 45] /Contents (Note) >>',
    '<< /Loop 8 0 R >>',
  ])
}

test('native content fingerprints preserve annotation-only rewrites and isolate changed or unsafe pages', { skip }, async t => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    if (!await hasExtensions(t, worker)) return
    const fingerprints = async (documentId: string, bytes: Uint8Array, offset = 0, limit = 2) => {
      await worker.request({ command: 'open', documentId }, bytes)
      return (await worker.request({ command: 'fingerprints', documentId, offset, limit })).value.digests
    }
    const original = await fingerprints('original', indexedPdf())
    assert.ok(original.every(digest => digest?.startsWith('sha256:')))
    assert.deepEqual(await fingerprints('rewritten', indexedPdf({ annotation: true })), original)
    const changed = await fingerprints('changed', indexedPdf({ paint: '0.7' }))
    assert.notEqual(changed[0], original[0])
    assert.equal(changed[1], original[1])
    assert.deepEqual(await fingerprints('second-page', indexedPdf(), 1, 1), original.slice(1))
    assert.deepEqual(await fingerprints('cyclic', indexedPdf({ cyclic: true })), [null, original[1]])
  } finally { await worker.dispose() }
})

test('saving a new annotation through PDFium preserves the original page fingerprints', { skip }, async t => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    if (!await hasExtensions(t, worker)) return
    const documentId = 'original'
    await worker.request({ command: 'open', documentId }, indexedPdf())
    const request = { command: 'fingerprints', documentId, offset: 0, limit: 2 } as const
    const before = (await worker.request(request)).value.digests
    assert.ok(before.every(digest => digest?.startsWith('sha256:')))
    await worker.request({ command: 'annotationEdit', documentId, pageIndex: 0, action: 'add',
      annotation: { id: 'fingerprint-note', subtype: 'Text', rect: [12, 12, 40, 40], contents: 'Added note' } })
    assert.deepEqual((await worker.request(request)).value.digests, before)
    const { value: { size } } = await worker.request({ command: 'saveCopy', documentId })
    const { bytes } = await worker.request({ command: 'saveChunk', documentId, offset: 0, length: size })
    await worker.request({ command: 'open', documentId: 'saved' }, bytes)
    const { value: { annotations } } = await worker.request({
      command: 'annotations', documentId: 'saved', pageIndex: 0, offset: 0, limit: 8,
    })
    assert.equal(annotations[0]?.contents, 'Added note')
    assert.deepEqual((await worker.request({ ...request, documentId: 'saved' })).value.digests, before)
  } finally { await worker.dispose() }
})
