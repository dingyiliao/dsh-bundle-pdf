import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { recognizeLocally } from '../../../src/ocr/local.ts'
import { OcrError } from '../../../src/ocr/types.ts'

test('LocalOCR reports a missing optional Tesseract package without starting recognition', async () => {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'tesseract.js') throw new Error('Optional Tesseract package is not installed')
      return nextResolve(specifier, context)
    },
  })
  await assert.rejects(recognizeLocally({
    image: new Uint8Array([1, 2, 3]), width: 10, height: 20, languages: ['eng'],
  }, {
    workerPath: 'https://app.example/ocr/worker.js', corePath: 'https://app.example/ocr/core',
    langPath: 'https://app.example/ocr/lang', gzip: true,
  }), (error: unknown) => error instanceof OcrError && error.code === 'dependency-unavailable'
    && error.cause instanceof Error && /not installed/.test(error.cause.message))
})
