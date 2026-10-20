import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalOcrEngine, normalizeTesseractOutput, recognizeLocally,
  type LocalOcrDependencies } from '../../../src/ocr/local.ts'
import { OcrError, type OcrRequest } from '../../../src/ocr/types.ts'

const assets = { origin: 'https://app.example', bridgePath: '/ocr/bridge.js', workerPath: '/ocr/worker.js',
  corePath: '/ocr/core', langPath: '/ocr/lang' }
const request = (): OcrRequest => ({ image: new Uint8Array([1, 2, 3]), width: 10, height: 20, languages: ['eng'] })
const hasCode = (code: string) => (error: unknown) => error instanceof OcrError && error.code === code

test('LocalOCR validates trusted asset origin, URL paths, core directory and installed languages', async () => {
  assert.equal((await createLocalOcrEngine({ workerPath: '/worker', corePath: '/core', langPath: '/lang' }).availability!({})).status,
    'not-configured')
  for (const bad of [
    { workerPath: 'http://[bad' }, { bridgePath: 'http://[bad' },
    { bridgePath: 'https://other.example/ocr/bridge.js' },
    { corePath: '/ocr/core.js' }, { langPath: 'https://other.example/lang' },
    { workerPath: '/ocr/worker.js?token=secret' },
  ]) {
    const engine = createLocalOcrEngine({ ...assets, ...bad })
    assert.equal((await engine.availability!({})).status, 'not-configured')
    await assert.rejects(engine.recognize(request(), {}), hasCode('not-configured'))
  }
  const engine = createLocalOcrEngine({ ...assets, availableLanguages: ['eng'] })
  assert.equal((await engine.availability!({})).status, 'available')
  await assert.rejects(engine.recognize({ ...request(), languages: ['fra'] }, {}), hasCode('not-configured'))
})

test('Tesseract output clamps valid off-image geometry but rejects malformed or absent text results', () => {
  assert.throws(() => normalizeTesseractOutput({ blocks: [] }, 10, 20), hasCode('recognition-failed'))
  const output = normalizeTesseractOutput({ text: 'word', confidence: 120,
    blocks: [{ text: 'word', bbox: { x0: -5, y0: -8, x1: 20, y1: 30 }, paragraphs: [{ lines: [
      { text: 'word', words: [null, { text: 'word', bbox: { x0: 5, y0: 10, x1: 4, y1: 12 } }] },
    ] }] }],
  }, 10, 20)
  assert.deepEqual(output.blocks[0]?.box, { x0: 0, y0: 0, x1: 10, y1: 20 })
  assert.equal(output.words[0]?.box, null)
  assert.equal(output.confidence, null)
  assert.equal(output.warnings.length, 0)
  const withoutGeometry = normalizeTesseractOutput({ text: 'visible', blocks: [] }, 10, 20)
  assert.match(withoutGeometry.warnings[0] ?? '', /no word geometry/)
})

test('LocalOCR terminates a worker even if termination itself rejects', async () => {
  let terminations = 0
  const deps: LocalOcrDependencies = { async createWorker() {
    return { async recognize() { return { data: { text: 'one', blocks: [] } } },
      async terminate() { terminations++; throw new Error('already gone') } }
  } }
  const result = await recognizeLocally(request(), {
    workerPath: 'https://app.example/ocr/worker.js', corePath: 'https://app.example/ocr/core',
    langPath: 'https://app.example/ocr/lang', gzip: true,
  }, deps)
  assert.equal(result.text, 'one')
  assert.equal(terminations, 1)
})

test('LocalOCR handles pre-aborted requests and wraps arbitrary recognition errors', async () => {
  const config = { workerPath: 'https://app.example/ocr/worker.js', corePath: 'https://app.example/ocr/core',
    langPath: 'https://app.example/ocr/lang', gzip: true }
  const controller = new AbortController()
  controller.abort(new OcrError('cancelled', 'User stopped OCR'))
  await assert.rejects(recognizeLocally({ ...request(), signal: controller.signal }, config,
    { async createWorker() { throw new Error('must not start') } }), hasCode('cancelled'))
  await assert.rejects(recognizeLocally(request(), config, { async createWorker() {
    return { async recognize() { throw new Error('Tesseract crashed') }, async terminate() {} }
  } }), hasCode('recognition-failed'))
})

test('LocalOCR clamps worker progress and surfaces initialization errors before recognition', async () => {
  const config = { workerPath: 'https://app.example/ocr/worker.js', corePath: 'https://app.example/ocr/core',
    langPath: 'https://app.example/ocr/lang', gzip: true }
  const progress: Array<number | null> = []
  const recognized = await recognizeLocally({ ...request(), onProgress(value) { progress.push(value.progress) } }, config, {
    async createWorker(_languages, _mode, options) {
      options.logger({ status: 'loading', progress: -0.5 })
      options.logger({ status: 'recognizing', progress: 1.5 })
      options.logger({ status: 'recognizing', progress: NaN })
      return { async recognize() { return { data: { text: 'one', blocks: [] } } }, async terminate() {} }
    },
  })
  assert.equal(recognized.text, 'one')
  assert.deepEqual(progress, [0, 1, null])

  await assert.rejects(recognizeLocally(request(), config, {
    async createWorker(_languages, _mode, options) {
      options.errorHandler(new Error('missing language assets'))
      return { async recognize() { throw new Error('must not recognize') }, async terminate() {} }
    },
  }), hasCode('dependency-unavailable'))
})
