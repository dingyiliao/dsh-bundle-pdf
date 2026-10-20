import assert from 'node:assert/strict'
import test from 'node:test'
import { ByteCache as legacyByteCache } from '../src/engine/byte-cache.ts'
import { ByteCache } from '../src/shared/cache/index.ts'
import * as legacyImageHost from '../src/host/image-understanding-plugin.ts'
import * as imageHost from '../src/entrypoints/image-understanding-host.ts'
import * as legacyOcrHost from '../src/host/ocr-plugin.ts'
import * as ocrHost from '../src/entrypoints/ocr-host.ts'
import { bookmarkPositionSchema as legacyPosition } from '../src/navigation/position-schema.ts'
import { bookmarkPositionSchema } from '../src/modules/navigation/index.ts'

test('pre-V2 source entrypoints retain the exact Host and shared runtime exports', () => {
  assert.equal(legacyByteCache, ByteCache)
  assert.equal(legacyPosition, bookmarkPositionSchema)
  for (const key of ['name', 'provide', 'inject', 'Config', 'HostImageUnderstandingService', 'apply'] as const) {
    assert.equal(legacyImageHost[key], imageHost[key], `legacy image Host ${key}`)
  }
  for (const key of ['name', 'provide', 'inject', 'Config', 'apply'] as const) {
    assert.equal(legacyOcrHost[key], ocrHost[key], `legacy OCR Host ${key}`)
  }
})
