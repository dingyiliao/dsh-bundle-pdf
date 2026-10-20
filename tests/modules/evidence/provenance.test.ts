import assert from 'node:assert/strict'
import test from 'node:test'
import { evidenceSha256, imageEvidenceSource } from '../../../src/modules/evidence/provenance.ts'

test('image provenance distinguishes direct sight, OCR, and another model description', () => {
  const pdfBytes = Buffer.from('pdf'), imageBytes = Buffer.from('rendered page')
  const direct = imageEvidenceSource({ kind: 'direct-image', pdfBytes, imageBytes })
  const ocr = imageEvidenceSource({ kind: 'ocr-text', pdfBytes, imageBytes, text: 'transcribed text' })
  const auxiliary = imageEvidenceSource({ kind: 'auxiliary-vision', pdfBytes, imageBytes, text: 'a chart' })
  assert.equal(direct.sourceDigest, evidenceSha256(pdfBytes))
  assert.equal(direct.renderedImageSha256, ocr.renderedImageSha256)
  assert.equal(direct.storedImageSha256, undefined)
  assert.equal(direct.snapshotSha256, undefined)
  assert.equal(ocr.snapshotSha256, evidenceSha256('transcribed text'))
  assert.notEqual(ocr.snapshotSha256, auxiliary.snapshotSha256)
  assert.ok(direct.limitations[0]!.includes('current vision-capable model'))
  assert.ok(ocr.limitations[0]!.includes('has not received the image'))
  assert.ok(auxiliary.limitations[0]!.includes('auxiliary visual model'))
  assert.equal(auxiliary.precision, 'page-only')
})
