import assert from 'node:assert/strict'
import test from 'node:test'
import { contextPresentationMeta, locatePresentationMeta, readPagePresentationMeta } from
  '../../../../src/adapters/host/dsh/pdf-evidence-meta.ts'
import { evidenceSha256, type PdfTextEvidence } from '../../../../src/modules/evidence/index.ts'

const evidence = (text: string, refId = 'pdfref_test'): PdfTextEvidence => ({
  refId, documentId: 'document-1', sourcePath: '/paper.pdf', sourceDigest: 'sha256:source',
  sourceVersion: 'fs-version', contentVersion: 'content-version', revision: 3,
  page: 7, source: 'pdf-text', pageTextDigest: evidenceSha256(text),
  snapshot: { text, sha256: evidenceSha256(text) },
  locator: { kind: 'text-window', startUtf16: 10, endUtf16: 10 + text.length,
    rectsPdf: [[0, 0, 10, 10]] }, precision: 'approximate-geometry', limitations: ['Approximate geometry'],
})

test('read-page presentation metadata preserves a bounded exact snapshot independent of process references', () => {
  const source = '文'.repeat(8_200)
  const result = readPagePresentationMeta({ documentId: 'document-1', path: '/a'.repeat(600), page: 7,
    sourceDigest: 'sha256:source', sourceVersion: 'fs-version', contentVersion: 'content-version', revision: 3,
    pageTextDigest: evidenceSha256(source),
    text: source, offset: 20, nextOffset: 8_220, totalChars: 20_000, status: 'ok' })
  assert.equal(result.snapshot.text.length, 8_000)
  assert.equal(result.snapshot.sha256, evidenceSha256(source.slice(0, 8_000)))
  assert.equal(result.snapshot.truncated, true)
  assert.equal(result.sourcePath.length, 512)
  assert.equal(result.sourcePathDigest, evidenceSha256('/a'.repeat(600)))
  assert.equal(result.pageTextDigest, evidenceSha256(source))
  assert.deepEqual(result.locator, { kind: 'text-window', startUtf16: 20, endUtf16: 8_020 })
  assert.ok(JSON.stringify(result).length < 30_000)
  const short = readPagePresentationMeta({ documentId: 'document-1', path: '/paper.pdf', page: 1,
    sourceDigest: 'sha256:source', sourceVersion: 'fs-version', contentVersion: 'content-version', revision: 0,
    pageTextDigest: evidenceSha256('abc'),
    text: 'abc', offset: 0, nextOffset: null, totalChars: 3, status: 'ok' })
  assert.equal(short.snapshot.truncated, false)
})

test('locate and context metadata retain exact bounded evidence without PDF image bytes or stale geometry', () => {
  const long = evidence('X'.repeat(10_000))
  const located = locatePresentationMeta({ status: 'ambiguous', documentId: 'document-1',
    matches: [{ evidence: long }, { evidence: evidence('second', 'pdfref_other') }],
    coverage: { pagesScanned: [7], noTextPages: [], truncated: false } })
  assert.equal(located.matches[0]?.snapshot.text.length, 512)
  assert.equal(located.matches[0]?.snapshot.truncated, true)
  assert.equal(located.matches[1]?.snapshot.truncated, false)
  assert.equal(located.matches[0]?.snapshot.originalSha256, evidenceSha256('X'.repeat(10_000)))
  assert.equal(located.matches[0]?.pageTextDigest, evidenceSha256('X'.repeat(10_000)))
  assert.ok(!JSON.stringify(located).includes('rectsPdf'))

  const context = contextPresentationMeta({ status: 'ok', documentId: 'document-1',
    chunks: [{ evidence: long }, { evidence: evidence('Y'.repeat(10_000), 'pdfref_two') }], candidates: [] })
  assert.equal(context.chunks[0]?.snapshot.text.length, 8_000)
  assert.equal(context.chunks[1]?.snapshot.text.length, 0)
  assert.ok(JSON.stringify(context).length < 25_000)
  assert.deepEqual(context.candidates, [])
  const ambiguous = contextPresentationMeta({ status: 'ambiguous', documentId: 'document-1',
    chunks: [], candidates: [{ evidence: evidence('phrase') }] })
  assert.equal(ambiguous.candidates[0]?.snapshot.text, 'phrase')
})
