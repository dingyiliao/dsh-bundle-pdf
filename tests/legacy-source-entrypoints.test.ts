import assert from 'node:assert/strict'
import test from 'node:test'
import * as legacyImageHost from '../src/plugins/public/image-understanding-host.ts'
import * as imageHost from '../src/plugins/image-understanding.ts'
import * as legacyOcrHost from '../src/plugins/public/ocr-host.ts'
import * as ocrHost from '../src/plugins/ocr.ts'

test('published Host SDK entrypoints retain their runtime exports', () => {
  for (const key of ['name', 'provide', 'inject', 'Config', 'HostImageUnderstandingService', 'apply'] as const) {
    assert.equal(legacyImageHost[key], imageHost[key], `legacy image Host ${key}`)
  }
  for (const key of ['name', 'provide', 'inject', 'Config', 'apply'] as const) {
    assert.equal(legacyOcrHost[key], ocrHost[key], `legacy OCR Host ${key}`)
  }
})
