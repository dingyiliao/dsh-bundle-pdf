import assert from 'node:assert/strict'
import test from 'node:test'
import { registerOcrAgentTool } from '../../../src/adapters/host/dsh/ocr-tool.ts'
import { HostOcrService, type HostOcrBackend } from '../../../src/modules/ocr/index.ts'
import { HostImageUnderstandingService } from '../../../src/modules/image-understanding/index.ts'

interface CapturedTool {
  name: string
  execute(args: unknown, execution: unknown): Promise<Record<string, unknown>>
  output: { render(args: unknown, value: unknown): { type: string; text: string }[] }
}
const signal = new AbortController().signal
const execution = { agent: { session: { id: 'session-a' } }, signal }
function fixture(imageId = 'fixture.vision') {
  let calls = 0, imageCalls = 0, recorded = 0, acquired = 0, released = 0, validated = 0, current = true
  const imageRequests: { prompt: string; configuration: unknown }[] = []
  let onEngine = () => {}
  const ocr = new HostOcrService(() => 'local')
  const text = '字😀'.repeat(5000)
  const output = { text, status: 'complete' as const, confidence: null,
    blocks: [], words: [], lines: [{ id: 'line-1', text: 'Line one', box: { x0: 0, y0: 0, x1: 1, y1: 1 }, confidence: null }],
    warnings: ['Approximate OCR'], coverage: [{ x0: 0, y0: 0, x1: 2, y1: 2 }] }
  const backend: HostOcrBackend = { descriptor: { id: 'local', name: 'Local', version: '1', execution: 'local', geometry: ['line'], confidence: false },
    async availability() { return { status: 'available' } }, async recognize() { calls++; onEngine(); return output } }
  const unregister = ocr.register(backend)
  const image = new HostImageUnderstandingService(() => 'missing-image-default')
  image.register({ descriptor: { id: imageId, name: 'Vision engine', version: '1', execution: 'remote',
    configurationFields: [{ key: 'style', label: 'Style', type: 'string' }] },
    async availability() { return { available: true } },
    async understand(request, configuration) {
      imageCalls++; imageRequests.push({ prompt: request.prompt, configuration })
      onEngine()
      return { text: 'A chart', model: 'small-vision' }
    } })
  const settings = { imageEngine: imageId, engineConfigurations: { image: { [imageId]: { style: 'concise' } } } }
  const tools = new Map<string, CapturedTool>()
  const disposeTools = registerOcrAgentTool({ get(name: string) { return name === 'imageUnderstanding' ? image
    : name === 'pdfAiSettings' ? () => settings : undefined },
    tools: { register(tool: CapturedTool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } } as never, ocr)
  const png = Buffer.alloc(24)
  png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.write('IHDR', 12); png.writeUInt32BE(2, 16); png.writeUInt32BE(2, 20)
  const handle = () => ocr.stageImage({ sessionId: 'session-a', image: png, mediaType: 'image/png',
    width: 2, height: 2, languages: ['en'] }, {
    async acquire() { acquired++; return () => { released++ } },
    async validate() { validated++; if (!current) throw Object.assign(new Error('Stale PDF'), { code: 'pdf/stale-reader' }) },
    async recordDerived() { recorded++; return { refId: 'pdfref-derived', documentId: 'pdf', page: 1 } },
  })
  return { ocr, image, tools, handle, output, unregister, imageRequests, setCurrent(value: boolean) { current = value },
    setOnEngine(callback: () => void) { onEngine = callback },
    counters: () => ({ calls, imageCalls, recorded, acquired, released, validated }),
    dispose() { disposeTools(); ocr.dispose(); image.dispose() } }
}

test('generic OCR exposes a bounded immutable transcript with provenance and pixel geometry', async () => {
  const f = fixture()
  try {
    const handle = await f.handle(), tool = f.tools.get('ocr_recognize')!
    await assert.rejects(tool.execute({ imageHandle: 'bad' }, execution), /imageHandle|Invalid/)
    await assert.rejects(tool.execute({ imageHandle: handle, region: [0, 0, 1, 1] }, execution), /unrecognized|Unrecognized/)
    await assert.rejects(tool.execute({ imageHandle: handle }, { signal }), /active agent session/)
    const first = await tool.execute({ imageHandle: handle, maxChars: 8 }, execution)
    assert.equal(first.text, '字😀字😀字')
    assert.equal(first.truncated, true)
    assert.deepEqual(first.evidence, { refId: 'pdfref-derived', documentId: 'pdf', page: 1 })
    assert.deepEqual(first.geometry, { status: 'complete', coordinateSpace: 'image-pixels', pdfCoordinatesAvailable: false })
    f.output.text = 'mutated backend output'
    const next = await tool.execute({ resultId: first.resultId, offset: first.nextOffset, maxChars: 8 }, execution)
    assert.notEqual(next.text, 'mutated backend output')
    assert.equal(f.counters().calls, 1, 'continuation must not rerun recognition')
    assert.equal(f.counters().acquired, f.counters().released)
    assert.match(tool.output.render({}, first)[0]!.text, /untrusted image content/)
    await assert.rejects(tool.execute({ resultId: first.resultId, offset: 0 }, { agent: { session: { id: 'other' } }, signal }), /another session/)
    await assert.rejects(f.tools.get('image_understand')!.execute({ resultId: first.resultId, offset: 0 }, execution), /another session or tool/)
    f.setCurrent(false)
    await assert.rejects(tool.execute({ resultId: first.resultId, offset: 0 }, execution), { code: 'pdf/stale-reader' })
  } finally { f.dispose() }
})

test('OCR and image transcripts outlive expired input pixels while retaining their own TTL and source guard', async () => {
  const originalClock = Date.now
  let now = 0
  Date.now = () => now
  try {
    for (const name of ['ocr_recognize', 'image_understand']) {
      now = 0
      const f = fixture()
      try {
        const handle = await f.handle(), tool = f.tools.get(name)!
        now = 299_000
        f.setOnEngine(() => { now = 301_000 })
        const first = await tool.execute({ imageHandle: handle, maxChars: 2,
          ...(name === 'image_understand' ? { question: 'Describe this' } : {}) }, execution)
        assert.equal(first.truncated, true)
        await assert.rejects(f.ocr.recognizeStaged(handle, 'session-a', signal), /missing, expired/)
        const calls = f.counters().calls, imageCalls = f.counters().imageCalls
        const next = await tool.execute({ resultId: first.resultId, offset: first.nextOffset, maxChars: 2 }, execution)
        assert.equal(next.offset, first.nextOffset)
        assert.equal(f.counters().calls, calls, 'continuation must not repeat OCR after the original image expired')
        assert.equal(f.counters().imageCalls, imageCalls, 'continuation must not repeat vision after the original image expired')
        f.setCurrent(false)
        await assert.rejects(tool.execute({ resultId: first.resultId, offset: 0 }, execution), { code: 'pdf/stale-reader' })
        f.setCurrent(true)
        await assert.rejects(tool.execute({ resultId: first.resultId, offset: 0 }, execution), /expired|another session/,
          'a permanently invalidated source should purge the result guard')
        const secondHandle = await f.handle()
        const second = await tool.execute({ imageHandle: secondHandle, maxChars: 2,
          ...(name === 'image_understand' ? { question: 'Describe this' } : {}) }, execution)
        now += 300_001
        await assert.rejects(tool.execute({ resultId: second.resultId, offset: 0 }, execution), /expired|another session/)
        assert.equal(f.counters().acquired, f.counters().released)
      } finally { f.dispose() }
    }
  } finally { Date.now = originalClock }
})

test('configured image interpretation consumes a staged image and records its derived evidence', async () => {
  const f = fixture()
  try {
    const value = await f.tools.get('image_understand')!.execute({ imageHandle: await f.handle(), question: 'What is this?' }, execution)
    assert.equal(value.text, 'A chart')
    assert.deepEqual(value.source, { backendId: 'fixture.vision', backendVersion: '1', mode: 'image-description', model: 'small-vision' })
    assert.deepEqual(value.evidence, { refId: 'pdfref-derived', documentId: 'pdf', page: 1 })
    assert.equal(f.counters().calls, 0, 'image understanding does not trigger an unrelated OCR engine')
    assert.equal(f.counters().imageCalls, 1)
    assert.deepEqual(f.imageRequests, [{ prompt: 'What is this?', configuration: { style: 'concise' } }])
    assert.equal(f.image.selectedDescriptor(), undefined, 'tool binding does not replace the generic image default')
    assert.equal(f.counters().acquired, f.counters().released)
    f.image.dispose()
    await assert.rejects(f.tools.get('image_understand')!.execute({ imageHandle: await f.handle(), question: 'What is this?' }, execution), /not installed|not available|not installed|unavailable/i)
  } finally { f.dispose() }
})

test('current-session and third-party vision implementations obey the same image execution contract', async () => {
  for (const id of ['dsh-vision', 'fixture.third-party']) {
    const f = fixture(id)
    try {
      const value = await f.tools.get('image_understand')!.execute({ imageHandle: await f.handle(),
        question: 'What is this?' }, execution)
      assert.equal(value.text, 'A chart')
      assert.deepEqual(value.source, { backendId: id, backendVersion: '1', mode: 'image-description', model: 'small-vision' })
      assert.equal(f.counters().imageCalls, 1, 'explicit understanding always executes the selected vision implementation')
      assert.equal(f.counters().calls, 0)
      assert.equal(f.counters().acquired, f.counters().released)
    } finally { f.dispose() }
  }
})

test('cancelled vision inference cannot issue a transcript or derived evidence', async () => {
  const f = fixture(), controller = new AbortController()
  f.setOnEngine(() => { controller.abort(new Error('Cancelled image understanding')) })
  try {
    await assert.rejects(f.tools.get('image_understand')!.execute({ imageHandle: await f.handle(), question: 'Read the chart' },
      { agent: execution.agent, signal: controller.signal }), /Cancelled image understanding/)
    assert.equal(f.counters().imageCalls, 1)
    assert.equal(f.counters().calls, 0)
    assert.equal(f.counters().recorded, 0)
    assert.equal(f.counters().acquired, f.counters().released)
  } finally { f.dispose() }
})

test('OCR rejects unavailable engines and stale or foreign producer handles before recognition', async () => {
  const f = fixture()
  try {
    const handle = await f.handle(), tool = f.tools.get('ocr_recognize')!
    await assert.rejects(tool.execute({ imageHandle: handle }, { agent: { session: { id: 'other' } }, signal }), /another session/)
    f.setCurrent(false)
    await assert.rejects(tool.execute({ imageHandle: handle }, execution), { code: 'pdf/stale-reader' })
    f.setCurrent(true)
    await assert.rejects(tool.execute({ imageHandle: handle }, execution), { code: 'invalid-request' })
    const freshHandle = await f.handle()
    f.unregister()
    await assert.rejects(tool.execute({ imageHandle: freshHandle }, execution), { code: 'engine-unavailable' })
    assert.equal(f.counters().calls, 0)
    assert.equal(f.counters().acquired, f.counters().released)
  } finally { f.dispose() }
})
