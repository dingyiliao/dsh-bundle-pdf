import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { HostOcrService, type HostOcrBackend } from '../../src/modules/ocr/index.js'
import { HostImageUnderstandingService, type ImageUnderstandingBackend } from '../../src/modules/image-understanding/index.js'
import { EngineCatalog } from '../../src/modules/engines/index.js'

const root = new URL('../../', import.meta.url)
// Compile and execute the actual example, while keeping its public SDK imports
// out of the repository's source-only typecheck. External compilation is tested below.
async function load<T>(entry: string): Promise<T> {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`examples/http-engines/${entry}`, root))],
    bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.contents).toString('base64')}`) as Promise<T>
}
const backends = load<{
  createHttpOcrBackend(fetcher?: typeof fetch): HostOcrBackend
  createHttpVisionBackend(fetcher?: typeof fetch): ImageUnderstandingBackend
}>('src/backends.ts')
const plugin = load<{ apply(ctx: { ocr: HostOcrService; imageUnderstanding: HostImageUnderstandingService;
  effect(start: () => () => void): void }): void }>('src/index.ts')

const png = () => {
  const data = new Uint8Array(24)
  data.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  data.set([73, 72, 68, 82], 12)
  new DataView(data.buffer).setUint32(16, 1)
  new DataView(data.buffer).setUint32(20, 1)
  return { mediaType: 'image/png' as const, data, width: 1, height: 1 }
}
const signal = new AbortController().signal

test('extension example executes OCR and vision through the real typed Host services', async () => {
  const { createHttpOcrBackend, createHttpVisionBackend } = await backends
  const calls: { endpoint: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined }[] = []
  const mockFetch: typeof fetch = async (endpoint, init) => {
    calls.push({ endpoint: String(endpoint), body: JSON.parse(String(init?.body)), signal: init?.signal })
    return Response.json({ text: calls.length === 1 ? 'Visible words' : 'A chart with two series', model: 'example-model' })
  }
  const ocr = new HostOcrService(() => ({ engineId: 'example.http-ocr', config: { endpoint: 'http://localhost:9000/ocr' } }))
  const vision = new HostImageUnderstandingService(() => ({ engineId: 'example.http-vision', config: { endpoint: 'http://localhost:9000/vision' } }))
  ocr.register(createHttpOcrBackend(mockFetch))
  vision.register(createHttpVisionBackend(mockFetch))
  try {
    const image = png()
    const transcript = await ocr.recognize({ sessionId: 'session', image: image.data, mediaType: image.mediaType,
      width: image.width, height: image.height, languages: ['auto'], signal })
    assert.equal(transcript.text, 'Visible words')
    assert.deepEqual(transcript.words, [])
    assert.equal(transcript.confidence, null)
    assert.deepEqual(transcript.coverage, [{ x0: 0, y0: 0, x1: 1, y1: 1 }])
    assert.equal(transcript.source.backendId, 'example.http-ocr')
    const description = await vision.understand({ sessionId: 'session', image, prompt: 'Compare the two series.', signal })
    assert.equal(description.text, 'A chart with two series')
    assert.equal(description.source.backendId, 'example.http-vision')
    assert.equal(description.source.model, 'example-model')
    assert.deepEqual(calls.map(call => call.endpoint), ['http://localhost:9000/ocr', 'http://localhost:9000/vision'])
    assert.deepEqual(calls[0]!.body.languages, ['auto'])
    assert.equal(calls[1]!.body.prompt, 'Compare the two series.')
    assert.deepEqual(calls[1]!.body.image, { mediaType: 'image/png', width: 1, height: 1,
      base64: Buffer.from(image.data).toString('base64') })
    assert.ok(calls.every(call => call.signal instanceof AbortSignal))
  } finally { ocr.dispose(); vision.dispose() }
})

test('extension plugin registrations update the live catalog and its Fiber disposers remove both', async () => {
  const { apply } = await plugin
  const ocr = new HostOcrService(() => 'example.http-ocr')
  const imageUnderstanding = new HostImageUnderstandingService(() => 'example.http-vision')
  const catalog = new EngineCatalog(), disposers: (() => void)[] = []
  let changes = 0
  catalog.attach('ocr', ocr); catalog.attach('image', imageUnderstanding)
  catalog.subscribe(() => { changes++ })
  try {
    apply({ ocr, imageUnderstanding, effect(start: () => () => void) { disposers.push(start()) } })
    assert.deepEqual(catalog.read().engines.ocr.map(engine => engine.id), ['example.http-ocr'])
    assert.deepEqual(catalog.read().engines.image.map(engine => engine.id), ['example.http-vision'])
    assert.equal(catalog.read().engines.image[0]!.configurationFields?.[0]?.key, 'endpoint')
    assert.equal(changes, 2)
    for (const dispose of disposers) dispose()
    assert.deepEqual(catalog.read().engines.ocr, [])
    assert.deepEqual(catalog.read().engines.image, [])
    assert.equal(changes, 4)
  } finally { catalog.dispose(); ocr.dispose(); imageUnderstanding.dispose() }
})

test('example providers reject missing configuration and malformed HTTP output; empty OCR remains valid', async () => {
  const { createHttpOcrBackend, createHttpVisionBackend } = await backends
  let calls = 0
  const mockFetch: typeof fetch = async () => { calls++; return Response.json({ text: '' }) }
  const service = new HostOcrService(() => 'example.http-ocr')
  service.register(createHttpOcrBackend(mockFetch))
  const image = png()
  const request = { sessionId: 'session', image: image.data, mediaType: image.mediaType, width: 1, height: 1, languages: ['auto'], signal }
  try {
    await assert.rejects(service.recognize(request), { code: 'not-configured' })
    assert.equal(calls, 0)
    const result = await service.recognize({ ...request,
      binding: { engineId: 'example.http-ocr', config: { endpoint: 'http://localhost:9000/ocr' } } })
    assert.equal(result.text, '')
    assert.equal(result.status, 'complete')
  } finally { service.dispose() }
  const malformed = createHttpVisionBackend(async () => Response.json({ text: 42 }))
  await assert.rejects(malformed.understand({ sessionId: 'session', image, prompt: 'Describe.', signal },
    { endpoint: 'http://localhost:9000/vision' }), /must return/)
  const failed = createHttpVisionBackend(async () => new Response('private server details', { status: 503 }))
  await assert.rejects(failed.understand({ sessionId: 'session', image, prompt: 'Describe.', signal },
    { endpoint: 'http://localhost:9000/vision' }), /^Error: Engine endpoint returned HTTP 503\.$/)
})

for (const kind of ['ocr', 'vision'] as const) {
  test(`example ${kind} forwards cancellation and provider unload aborts pending HTTP work`, async () => {
    const { createHttpOcrBackend, createHttpVisionBackend } = await backends
    let entered!: () => void, networkSignal: AbortSignal | undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const mockFetch: typeof fetch = async (_endpoint, init) => new Promise((_resolve, reject) => {
      networkSignal = init!.signal!
      networkSignal.addEventListener('abort', () => reject(networkSignal!.reason), { once: true })
      entered()
    })
    const ocr = new HostOcrService(() => ({ engineId: 'example.http-ocr', config: { endpoint: 'http://localhost:9000/ocr' } }))
    const vision = new HostImageUnderstandingService(() => ({ engineId: 'example.http-vision', config: { endpoint: 'http://localhost:9000/vision' } }))
    const stop = kind === 'ocr' ? ocr.register(createHttpOcrBackend(mockFetch)) : vision.register(createHttpVisionBackend(mockFetch))
    try {
      const image = png()
      const pending = kind === 'ocr'
        ? ocr.recognize({ sessionId: 'session', image: image.data, mediaType: image.mediaType, width: 1, height: 1, languages: ['auto'], signal })
        : vision.understand({ sessionId: 'session', image, prompt: 'Describe.', signal })
      await started
      stop()
      await assert.rejects(pending, { code: kind === 'ocr' ? 'engine-unavailable' : 'pdf/image-unavailable' })
      assert.equal(networkSignal!.aborted, true)
    } finally { ocr.dispose(); vision.dispose() }
  })
}

test('example package typechecks and builds against only the published SDK declaration graph', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-example-engine-'))
  const execute = promisify(execFile)
  try {
    const packageRoot = join(fixture, 'node_modules/@dylanl1/dsh-plugin-pdf')
    await mkdir(packageRoot, { recursive: true })
    await cp(new URL('package.json', root), join(packageRoot, 'package.json'))
    await cp(new URL('dist/types', root), join(packageRoot, 'dist/types'), { recursive: true })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(fileURLToPath(new URL('node_modules', root)), join(packageRoot, 'node_modules'), linkType)
    for (const directory of ['@deepseek-ai', '@types']) {
      await symlink(fileURLToPath(new URL(`node_modules/${directory}`, root)), join(fixture, 'node_modules', directory), linkType)
    }
    const consumer = join(fixture, 'plugin')
    await cp(new URL('examples/http-engines', root), consumer, { recursive: true,
      filter: path => !path.includes('node_modules') && !path.includes('/dist') })
    await execute(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)),
      '--project', join(consumer, 'tsconfig.json')], { cwd: consumer, windowsHide: true, timeout: 60_000,
      maxBuffer: 1024 * 1024 }).catch((error: Error & { stdout?: string; stderr?: string }) => {
      assert.fail(`Example failed external compilation:\n${error.stdout ?? ''}${error.stderr ?? ''}\n${error.message}`)
    })
  } finally { await rm(fixture, { recursive: true, force: true }) }
})
