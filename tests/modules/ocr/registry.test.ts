import assert from 'node:assert/strict'
import test from 'node:test'
import { createOcrRegistry } from '../../../src/ocr/index.ts'
import { mapImageBoxToPdf, mapResultToPdf } from '../../../src/ocr/mapping.ts'
import { OcrRegistry } from '../../../src/ocr/registry.ts'
import { OcrError, type OcrEngine, type OcrOutput, type OcrRequest, type OcrResult } from '../../../src/ocr/types.ts'
import { validateOcrOutput, validateOcrRequest } from '../../../src/ocr/validation.ts'
import { joinPageText } from '../../../src/shared/page-text.ts'

const request = (): OcrRequest => ({ image: new Uint8Array([1, 2]), width: 20, height: 10, languages: ['eng'] })
const output = (): OcrOutput => ({ text: 'one', status: 'complete', warnings: [], confidence: null,
  blocks: [], lines: [], words: [], coverage: [{ x0: 0, y0: 0, x1: 20, y1: 10 }] })
const hasCode = (code: string) => (error: unknown) => error instanceof OcrError && error.code === code
const engine = (recognize: OcrEngine['recognize']): OcrEngine => ({
  descriptor: { id: 'test', name: 'Test OCR', version: '1', execution: 'local', geometry: [], confidence: false },
  recognize,
})

test('default OCR registry advertises both installed engines but selects disabled OCR', async () => {
  const registry = createOcrRegistry()
  assert.deepEqual(registry.list().map(item => item.id), ['none', 'local'])
  assert.equal(registry.getSelection()?.engineId, 'none')
  assert.equal((await registry.availability()).status, 'disabled')
  registry.dispose()
})

test('OCR registry validates selection, detaches descriptors, clears cached results on unregister and disposal', async () => {
  const registry = new OcrRegistry()
  assert.equal((await registry.availability()).status, 'not-configured')
  await assert.rejects(registry.recognize(request()), hasCode('not-configured'))
  assert.throws(() => registry.select({ id: '', engineId: 'test', configurationRevision: '1', config: {} }), hasCode('not-configured'))
  let calls = 0
  const unregister = registry.register(engine(async () => { calls++; return output() }))
  const listed = registry.list()
  listed[0]!.name = 'changed'
  assert.equal(registry.list()[0]?.name, 'Test OCR')
  registry.select({ id: 'instance', engineId: 'test', configurationRevision: '1', config: {} })
  const identity = { documentId: 'doc', contentVersion: 'v1', page: 1, region: null, renderRevision: 'base' }
  assert.equal((await registry.recognize(request(), { cacheIdentity: identity })).cached, false)
  assert.equal((await registry.recognize(request(), { cacheIdentity: identity })).cached, true)
  unregister()
  unregister()
  assert.equal((await registry.availability()).status, 'unavailable')
  await assert.rejects(registry.recognize(request()), hasCode('engine-unavailable'))
  registry.register(engine(async () => { calls++; return output() }))
  assert.equal((await registry.recognize(request(), { cacheIdentity: identity })).cached, false)
  assert.equal(calls, 2)
  registry.dispose()
  assert.equal((await registry.availability()).status, 'unavailable')
  await assert.rejects(registry.recognize(request()), hasCode('engine-unavailable'))
  assert.throws(() => registry.register(engine(async () => output())), hasCode('engine-unavailable'))
})

test('OCR registry forwards progress safely, preserves caller cancellation and wraps unknown backend failures', async () => {
  const registry = new OcrRegistry()
  let progressSeen = 0
  registry.register(engine(async input => {
    input.onProgress?.({ stage: 'recognizing', progress: 0.5 })
    input.onProgress?.({ stage: 'recognizing', progress: 1 })
    return output()
  }))
  registry.select({ id: 'instance', engineId: 'test', configurationRevision: '1', config: {} })
  const result = await registry.recognize({ ...request(), onProgress() { progressSeen++; throw new Error('UI observer') } })
  assert.equal(result.text, 'one')
  assert.equal(progressSeen, 2)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(registry.recognize({ ...request(), signal: cancelled.signal }), hasCode('cancelled'))
  registry.dispose()

  const failing = new OcrRegistry()
  failing.register(engine(async () => { throw new Error('backend exploded') }))
  failing.select({ id: 'instance', engineId: 'test', configurationRevision: '1', config: {} })
  await assert.rejects(failing.recognize(request()), hasCode('recognition-failed'))
  failing.dispose()
})

test('OCR registry enforces the selected engine pixel limit without running that engine', async () => {
  const registry = new OcrRegistry()
  let calls = 0
  registry.register({ ...engine(async () => { calls++; return output() }), descriptor: {
    id: 'test', name: 'Test OCR', version: '1', execution: 'local', geometry: [], confidence: false,
    maxPixels: 8,
  } })
  registry.select({ id: 'instance', engineId: 'test', configurationRevision: '1', config: {} })
  try {
    await assert.rejects(registry.recognize(request()), hasCode('limit-exceeded'))
    assert.equal(calls, 0)
  } finally { registry.dispose() }
})

test('OCR request/output validation rejects invalid dimensions, bytes, languages, deadlines and geometry', () => {
  for (const invalid of [
    { width: 0 }, { height: 1.5 }, { image: new Uint8Array() }, { languages: [] },
    { languages: ['eng!'] }, { timeoutMs: 0 }, { timeoutMs: 600_001 },
  ]) assert.throws(() => validateOcrRequest({ ...request(), ...invalid }), hasCode('invalid-request'))
  assert.throws(() => validateOcrRequest({ ...request(), image: 'not bytes' } as unknown as OcrRequest), hasCode('invalid-request'))
  validateOcrRequest(request())
  for (const invalid of [
    { text: undefined }, { status: 'failed' }, { coverage: [{ x0: 0, y0: 0, x1: 21, y1: 10 }] },
    { words: [{ id: 'w', text: 5, box: null, confidence: null }] },
    { lines: [{ id: 'l', text: 'x', box: { x0: 5, y0: 2, x1: 4, y1: 3 }, confidence: null }] },
  ]) assert.throws(() => validateOcrOutput({ ...output(), ...invalid } as OcrOutput, request()), hasCode('recognition-failed'))
  assert.equal(validateOcrOutput(output(), request()).text, 'one')
})

test('OCR PDF mapping preserves null geometry, maps all positioned parts, and rejects invalid transforms', () => {
  assert.throws(() => mapImageBoxToPdf({ x0: 0, y0: 0, x1: 1, y1: 1 }, () => [NaN, 0]), hasCode('invalid-request'))
  const part = { id: 'p', text: 'one', box: { x0: 1, y0: 2, x1: 3, y1: 4 }, confidence: null }
  const result: OcrResult = { ...output(), words: [part], lines: [{ ...part, box: null }], blocks: [part],
    source: { engineId: 'test', engineVersion: '1', instanceId: 'a', configurationRevision: '1', languages: ['eng'] },
    image: { width: 20, height: 10 }, cached: false }
  const mapped = mapResultToPdf(result, (x, y) => [x + 10, y + 20])
  assert.deepEqual(mapped.words[0]?.pdf?.rect, [11, 22, 13, 24])
  assert.deepEqual(mapped.blocks[0]?.pdf?.quad, [11, 22, 13, 22, 11, 24, 13, 24])
  assert.equal(mapped.lines[0]?.pdf, null)
})

test('PDF page text joins wrapped lines and spatially separate runs without splitting one word', () => {
  const item = (str: string, x: number, y: number, width: number, hasEOL = false) => ({
    str, transform: [1, 0, 0, 1, x, y] as [number, number, number, number, number, number],
    width, height: 10, hasEOL,
  })
  assert.equal(joinPageText([]), '')
  assert.equal(joinPageText([item('inter', 0, 0, 20), item('national', 20, 0, 40)]), 'international')
  assert.equal(joinPageText([item('first', 0, 0, 20), item('second', 28, 0, 30)]), 'first second')
  assert.equal(joinPageText([item('first', 0, 0, 20), item('second', 20, 10, 30)]), 'first second')
  assert.equal(joinPageText([item('first', 0, 0, 20, true), item('second', 20, 0, 30)]), 'first\nsecond')
  assert.equal(joinPageText([item('first ', 0, 0, 20), item('second', 28, 0, 30)]), 'first second')
})
