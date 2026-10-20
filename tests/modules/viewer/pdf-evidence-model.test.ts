import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { pdfEvidenceCardModel } from '../../../src/client/toolview/pdf-evidence-model.ts'

const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

function entry(text = 'a bounded excerpt') {
  return {
    refId: 'process-local-ref', documentId: 'document-1', sourcePath: '/work/source.pdf',
    sourcePathDigest: digest('/work/source.pdf'), sourceDigest: digest('pdf bytes'),
    pageTextDigest: digest(`header${text}footer`), contentVersion: 'content-1', revision: 3, page: 2,
    locator: { kind: 'text-window', startUtf16: 5, endUtf16: 5 + text.length },
    snapshot: { text, sha256: digest(text), truncated: false },
  }
}

test('read-page replay metadata becomes one bounded card entry', () => {
  const model = pdfEvidenceCardModel('pdf_read_page', {
    kind: 'pdf-evidence-snapshot', version: 1, tool: 'pdf_read_page', status: 'ok',
    ...entry(),
  })
  assert.equal(model?.tool, 'pdf_read_page')
  assert.equal(model?.documentId, 'document-1')
  assert.deepEqual(model?.entries.map(item => [item.page, item.snapshot.text]), [[2, 'a bounded excerpt']])
  assert.equal(model?.entries[0]?.pageTextDigest, digest('headera bounded excerptfooter'))
})

test('a long source keeps only a bounded display path and a digest of the complete path', () => {
  const path = `/work/${'chapter/'.repeat(90)}source.pdf`
  const model = pdfEvidenceCardModel('pdf_read_page', {
    kind: 'pdf-evidence-snapshot', version: 1, tool: 'pdf_read_page', status: 'ok',
    ...entry(), sourcePath: path.slice(0, 512), sourcePathDigest: digest(path),
  })
  assert.equal(model?.entries[0]?.sourcePath.length, 512)
  assert.equal(model?.entries[0]?.sourcePathDigest, digest(path))
})

test('locate and context preserve result order and only expose stored evidence', () => {
  const first = entry('first')
  const second = { ...entry('second'), page: 3 }
  const common = { kind: 'pdf-evidence-snapshot', version: 1, status: 'ok', documentId: 'document-1' }
  const locate = pdfEvidenceCardModel('pdf_locate', {
    ...common, tool: 'pdf_locate', matches: [first, second], coverage: { pagesScanned: [2, 3] },
  })
  const context = pdfEvidenceCardModel('pdf_context', {
    ...common, tool: 'pdf_context', chunks: [first], candidates: [second],
  })
  assert.deepEqual(locate?.entries.map(item => item.snapshot.text), ['first', 'second'])
  assert.deepEqual(context?.entries.map(item => item.snapshot.text), ['first', 'second'])
  assert.equal(pdfEvidenceCardModel('pdf_locate', { ...common, tool: 'pdf_locate', matches: [] })?.entries.length, 0)
})

test('malformed, cross-document, mismatched-tool and oversized replay metadata is rejected', () => {
  const base = { kind: 'pdf-evidence-snapshot', version: 1, tool: 'pdf_locate', status: 'ok',
    documentId: 'document-1', matches: [entry()] }
  for (const invalid of [
    { ...base, version: 2 },
    { ...base, kind: 'not-pdf-evidence' },
    { ...base, matches: [{ ...entry(), documentId: 'document-2' }] },
    { ...base, matches: [{ ...entry(), sourceDigest: 'not-a-digest' }] },
    { ...base, matches: [{ ...entry(), sourcePathDigest: 'not-a-digest' }] },
    { ...base, matches: [{ ...entry(), pageTextDigest: 'not-a-digest' }] },
    { ...base, matches: [{ ...entry(), page: 0 }] },
    { ...base, matches: [{ ...entry(), locator: { kind: 'text-window', startUtf16: 9, endUtf16: 8 } }] },
    { ...base, matches: [{ ...entry(), locator: { kind: 'text-window', startUtf16: 5, endUtf16: 6 } }] },
    { ...base, matches: Array.from({ length: 6 }, () => entry()) },
  ]) assert.equal(pdfEvidenceCardModel('pdf_locate', invalid), null)
  assert.equal(pdfEvidenceCardModel('pdf_context', base), null)
  assert.equal(pdfEvidenceCardModel('unknown', base), null)
  assert.equal(pdfEvidenceCardModel('pdf_locate', null), null)
})

test('older replay metadata remains readable but has no whole-page revalidation digest', () => {
  const { pageTextDigest: _digest, ...legacy } = entry()
  const model = pdfEvidenceCardModel('pdf_read_page', {
    kind: 'pdf-evidence-snapshot', version: 1, tool: 'pdf_read_page', status: 'ok', ...legacy,
  })
  assert.equal(model?.entries[0]?.snapshot.text, 'a bounded excerpt')
  assert.equal(model?.entries[0]?.pageTextDigest, undefined)
})
