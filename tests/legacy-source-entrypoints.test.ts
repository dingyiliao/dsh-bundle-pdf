import assert from 'node:assert/strict'
import test from 'node:test'
import * as legacyImageHost from '../src/host/image-understanding-plugin.ts'
import * as imageHost from '../src/entrypoints/image-understanding-host.ts'
import * as legacyOcrHost from '../src/host/ocr-plugin.ts'
import * as ocrHost from '../src/entrypoints/ocr-host.ts'

test('published Host SDK entrypoints retain their runtime exports', () => {
  for (const key of ['name', 'provide', 'inject', 'Config', 'HostImageUnderstandingService', 'apply'] as const) {
    assert.equal(legacyImageHost[key], imageHost[key], `legacy image Host ${key}`)
  }
  for (const key of ['name', 'provide', 'inject', 'Config', 'apply'] as const) {
    assert.equal(legacyOcrHost[key], ocrHost[key], `legacy OCR Host ${key}`)
  }
})
