import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfPageContent, projectPageContent } from '../../../../src/adapters/host/dsh/page-content.ts'
import { pageContentDigest, parsePageContent, PageRepresentationSchema, createPageRepresentation } from '../../../../src/modules/document/index.ts'
import { HostOcrService, type HostOcrBackend } from '../../../../src/modules/ocr/index.ts'
import { HostImageUnderstandingService, type ImageUnderstandingBackend } from '../../../../src/modules/image-understanding/index.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../../src/shared/native.ts'
import { defaultSettings, type PdfSettings } from '../../../../src/shared/contracts.ts'

const signal = new AbortController().signal
const geometry = { page: 1, userUnit: 1, rotation: 0, mediaBox: [0, 0, 200, 300], cropBox: [0, 0, 200, 300] } as const
function layer(text: string): NativeTextContent {
  return { items: text ? [{ str: text, transform: [10, 0, 0, 10, 10, 200], width: text.length * 5,
    height: 10, dir: 'ltr', fontName: 'fixture', hasEOL: false,
    glyphs: [...text].map((_character, index) => [10 + index * 5, 200, 5]) }] : [],
  styles: { fixture: { fontFamily: 'fixture', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
function fixture(options: { native?: string; scan?: boolean; describe?: boolean; attested?: boolean; cache?: Map<string, unknown>;
  imageEngine?: string; invalidImageOutput?: boolean } = {}) {
  const data = options.cache ?? new Map<string, unknown>()
  const state = { native: options.native ?? '', text: 'needle recognized', description: 'A needle labels the upward chart.',
    model: 'revision-one', bytes: new Uint8Array([1, 2, 3]), version: 'content-one', denied: false,
    reads: 0, renders: 0, recognitions: 0, descriptions: 0, words: true, imageFailure: false, ocrAvailable: true, unmappedCharacters: 0,
    imageModel: undefined as string | undefined, imageInputs: [] as Uint8Array[], ocrInputs: [] as Uint8Array[],
    imageIdentityResolutions: 0, ocrIdentityResolutions: 0, cacheWriteFailure: false,
    imageBindings: [] as { id: string; variant: unknown }[], onImage: undefined as (() => Promise<void>) | undefined,
    onOcr: undefined as (() => Promise<void>) | undefined,
    onNative: undefined as (() => Promise<void>) | undefined, onRender: undefined as (() => Promise<void>) | undefined, onGet: undefined as (() => void) | undefined }
  let settings: PdfSettings = { ...defaultSettings, ocrEngine: 'fixture', imageEngine: options.imageEngine ?? 'fixture-image',
    indexScanPages: options.scan ?? true,
    indexImageDescriptions: options.describe ?? false,
    engineConfigurations: { ocr: { fixture: { variant: 'first' } },
      image: { 'fixture-image': { variant: 'first' }, 'fixture-image-two': { variant: 'second' } } } }
  const snapshot = (session: string, id: string): HostWorkspaceSnapshot => {
    if (state.denied || id !== `doc-${session}`) throw Object.assign(new Error('PDF source access denied'), { code: 'pdf/access-denied' })
    return { id, path: '/indexed.pdf', bytes: state.bytes, sourceVersion: 'disk-one', contentVersion: state.version,
      revision: session === 'b' ? 2 : 0, dirty: false, conflict: false, canUndo: false, canRedo: false,
      document: { pageCount: 1, pages: [{ ...geometry, mediaBox: [...geometry.mediaBox], cropBox: [...geometry.cropBox] }],
        annotations: [], signed: false, encrypted: false, readOnly: false } }
  }
  const pages: Parameters<typeof createPdfPageContent>[1] = {
    async readPageText(session, id, _page, _signal, readOptions) {
      assert.equal(readOptions?.recover, false, 'content extraction must not recurse through legacy OCR fallback')
      const original = snapshot(session, id)
      state.reads++; await state.onNative?.()
      return { snapshot: original, content: { ...layer(state.native), ...(state.unmappedCharacters ? { quality: { unmappedCharacters: state.unmappedCharacters } } : {}) } }
    },
    async renderOcrImage(session, id, page, region, maxEdge, _active, forms) {
      assert.equal(page, 1); assert.equal(region, undefined); assert.equal(maxEdge, 1024)
      assert.equal(forms, false, 'the clean OCR renderer already omits annotations and must also omit form values')
      state.renders++; await state.onRender?.()
      const png = Buffer.alloc(24 + state.bytes.length)
      png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.write('IHDR', 12); png.writeUInt32BE(200, 16); png.writeUInt32BE(300, 20)
      png.set(state.bytes, 24)
      return { snapshot: snapshot(session, id), png, width: 200, height: 300,
        pdfRegion: [0, 0, 200, 300] }
    },
  }
  const ocr = new HostOcrService(() => 'fixture'), image = new HostImageUnderstandingService(() => 'fixture-image')
  const ocrBackend = (): HostOcrBackend => ({
    descriptor: { id: 'fixture', name: 'Fixture OCR', version: '1', execution: 'local', capabilities: ['ocr-text'], geometry: ['word'], confidence: false,
      configurationFields: [{ key: 'variant', label: 'Variant', type: 'string' }] },
    ...(options.attested !== false ? { cacheIdentity: async () => { state.ocrIdentityResolutions++; return state.model } } : {}),
    async availability() { return state.ocrAvailable ? { status: 'available' } : { status: 'unavailable', reason: 'Fixture OCR is offline' } },
    async recognize(request) {
      state.recognitions++
      state.ocrInputs.push(new Uint8Array(request.image as Uint8Array))
      assert.deepEqual(request.languages, ['auto'])
      await state.onOcr?.()
      return { text: state.text, blocks: [], lines: [], words: state.words && state.text ? [{ id: 'word', text: 'needle',
        box: { x0: 20, y0: 30, x1: 60, y1: 50 }, confidence: null }] : [],
      confidence: null, status: 'complete', coverage: [], warnings: [] }
    },
  })
  const imageBackend = (id = 'fixture-image'): ImageUnderstandingBackend => ({
    descriptor: { id, name: 'Fixture image', version: '1', execution: 'local',
      configurationFields: [{ key: 'variant', label: 'Variant', type: 'string' }] },
    ...(options.attested !== false ? { cacheIdentity: async () => { state.imageIdentityResolutions++; return state.imageModel ?? state.model } } : {}),
    async availability() { return { available: true } },
    async understand(request, config) {
      state.descriptions++
      state.imageInputs.push(request.image.data.slice())
      state.imageBindings.push({ id, variant: config?.variant })
      await state.onImage?.()
      if (state.imageFailure) throw new Error('Temporary image interpretation failure')
      assert.match(request.prompt, /document retrieval/)
      return { text: options.invalidImageOutput ? '' : state.description, model: state.imageModel ?? state.model,
        limitations: 'Generated interpretation; verify the chart.' }
    },
  })
  let unregister = ocr.register(ocrBackend())
  let unregisterImage = image.register(imageBackend())
  image.register(imageBackend('fixture-image-two'))
  const workspaces = { readSnapshot: snapshot }
  const create = () => createPdfPageContent(workspaces, pages, { settings: () => settings, ocr: () => ocr, image: () => image,
    cache: { async get(key) { const value = structuredClone(data.get(key)); state.onGet?.(); return value }, async set(key, value) {
      if (state.cacheWriteFailure) throw new Error('Cache storage is unavailable')
      data.set(key, structuredClone(value))
    } } })
  const content = create()
  return { content, create, state, data, ocr, image, snapshot,
    updateSettings(change: Partial<PdfSettings>) { settings = { ...settings, ...change } },
    reregister() { unregister(); unregister = ocr.register(ocrBackend()) },
    reregisterImage() { unregisterImage(); unregisterImage = image.register(imageBackend()) },
    unregisterImage() { unregisterImage() },
    unregister() { unregister() },
    dispose() { content.dispose(); ocr.dispose(); image.dispose() } }
}

const representations = (content: Awaited<ReturnType<ReturnType<typeof fixture>['content']['read']>>) =>
  content.blocks.flatMap(block => block.representations)

// Assert retained content rather than a storage record count: independent
// native/producer layers and aggregate snapshots intentionally overlap.
function cachedDerivations(f: ReturnType<typeof fixture>) {
  const retained = new Map<string, { id: string; kind: string; text: string }>()
  for (const value of f.data.values()) {
    const page = parsePageContent(value), single = PageRepresentationSchema.safeParse(value)
    for (const rep of page ? representations(page) : single.success ? [single.data] : []) {
      if (rep.kind !== 'native-text') retained.set(rep.id, rep)
    }
  }
  return [...retained.values()]
}
function aggregateKey(f: ReturnType<typeof fixture>) {
  return [...f.data.entries()].find(([, value]) => parsePageContent(value)?.extractionIdentity === f.content.identity('a'))![0]
}

test('native pages preserve exact text and geometry without OCR or image interpretation work', async () => {
  const f = fixture({ native: 'native needle evidence' })
  try {
    const result = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(result.nativeText.text, f.state.native)
    const native = representations(result).find(rep => rep.kind === 'native-text')!
    assert.equal(native.text, f.state.native)
    assert.ok(native.spans?.length)
    assert.equal(f.state.recognitions, 0); assert.equal(f.state.descriptions, 0); assert.equal(f.state.renders, 0)
    const projected = projectPageContent(result)
    assert.equal(projected.units?.length, 1)
    assert.deepEqual(projected.units?.[0]?.nativeRange, { startUtf16: 0, endUtf16: f.state.native.length })
  } finally { f.dispose() }
})

test('scan text is generated from a clean image, positioned in PDF coordinates and separated from native text', async () => {
  const f = fixture()
  try {
    const result = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(result.nativeText.text, '')
    const recognized = representations(result).find(rep => rep.kind === 'ocr-text')!
    assert.equal(recognized.text, f.state.text)
    assert.deepEqual(recognized.spans, [{ startUtf16: 0, endUtf16: 6, rectPdf: [20, 250, 60, 270] }])
    assert.equal(recognized.producer.id, 'fixture'); assert.equal(recognized.producer.version, '1')
    assert.match(recognized.inputDigest!, /^sha256:[a-f0-9]{64}$/)
    assert.equal(recognized.digest, pageContentDigest(f.state.text))
    assert.equal(f.state.renders, 1); assert.equal(f.state.recognitions, 1); assert.equal(f.state.descriptions, 0)
    assert.equal(projectPageContent(result).units?.[0]?.nativeRange, undefined)
    assert.equal(JSON.stringify(result).includes('137,80,78,71'), false, 'durable content contains no encoded image payload')
  } finally { f.dispose() }
})

test('text-only OCR stays valid without positioned words and blank successful OCR produces no searchable unit', async () => {
  const f = fixture()
  try {
    f.state.words = false
    const result = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(representations(result).find(rep => rep.kind === 'ocr-text')!.spans, undefined)
    f.content.refresh('a', 'doc-a'); f.state.text = ''
    const blank = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(representations(blank).find(rep => rep.kind === 'ocr-text')!.status, 'complete')
    assert.equal(representations(blank).find(rep => rep.kind === 'ocr-text')!.text, '')
    assert.deepEqual(projectPageContent(blank).units, [])
  } finally { f.dispose() }
})

test('OCR and a visual description share one logical visual block and one clean render', async () => {
  const f = fixture({ describe: true })
  try {
    const result = await f.content.read('a', 'doc-a', 1, signal)
    const visual = result.blocks.find(block => block.kind === 'visual-region')!
    assert.deepEqual(visual.representations.map(rep => rep.kind), ['ocr-text', 'image-description'])
    assert.equal(visual.representations[0]!.inputDigest, visual.representations[1]!.inputDigest)
    assert.equal(f.state.renders, 1); assert.equal(f.state.recognitions, 1); assert.equal(f.state.descriptions, 1)
    const projected = projectPageContent(result)
    assert.equal(new Set(projected.units!.map(unit => unit.blockId)).size, 1)
    assert.match(projected.warnings!.join(' '), /verify the chart/)
  } finally { f.dispose() }
})

test('index OCR and visual descriptions independently obey every toggle using the shared OCR and vision engines', async () => {
  for (const scan of [false, true]) for (const describe of [false, true]) {
    const f = fixture({ scan, describe })
    try {
      const result = await f.content.read('a', 'doc-a', 1, signal)
      const derived = representations(result).filter(rep => rep.kind !== 'native-text')
      assert.deepEqual(derived.map(rep => rep.kind), [
        ...(scan ? ['ocr-text'] : []), ...(describe ? ['image-description'] : []),
      ], `scan=${scan}, describe=${describe}`)
      assert.equal(f.state.recognitions, Number(scan), 'visual indexing never invokes the OCR engine')
      assert.equal(f.state.descriptions, Number(describe))
      assert.equal(f.state.renders, Number(scan || describe), 'independent consumers reuse the same clean page image')
      if (scan && describe) {
        assert.deepEqual([...f.state.ocrInputs[0]!], [...f.state.imageInputs[0]!])
        assert.equal(derived[0]!.inputDigest, derived[1]!.inputDigest)
      }
      if (describe) {
        const visual = derived.find(rep => rep.kind === 'image-description')!
        assert.equal(visual.producer.id, 'fixture-image')
        assert.equal(visual.producer.model, f.state.model)
        assert.deepEqual(f.state.imageBindings, [{ id: 'fixture-image', variant: 'first' }])
      }
    } finally { f.dispose() }
  }
})

test('visual-only indexing neither resolves nor calls OCR even when no OCR backend is installed', async () => {
  const f = fixture({ scan: false, describe: true })
  try {
    f.unregister()
    const result = await f.content.read('a', 'doc-a', 1, signal)
    assert.deepEqual(representations(result).map(rep => rep.kind), ['native-text', 'image-description'])
    assert.equal(result.failure, undefined)
    assert.equal(f.state.ocrIdentityResolutions, 0); assert.equal(f.state.recognitions, 0)
    assert.equal(f.state.descriptions, 1); assert.equal(f.state.renders, 1)
  } finally { f.dispose() }
})

test('an uninstalled selected vision engine fails explicitly without rendering or falling back to OCR', async () => {
  for (const native of ['', 'native needle']) {
    const f = fixture({ native, scan: false, describe: true, imageEngine: 'missing-image' })
    try {
      if (native) {
        const partial = await f.content.read('a', 'doc-a', 1, signal)
        assert.equal(partial.nativeText.text, native)
        assert.deepEqual(partial.failure, { code: 'pdf/index-image-unavailable' })
        assert.deepEqual(representations(partial).map(rep => rep.kind), ['native-text'])
        assert.match(partial.warnings.join(' '), /image description/i)
        assert.equal(projectPageContent(partial).failure?.code, 'pdf/index-image-unavailable')
      } else {
        await assert.rejects(f.content.read('a', 'doc-a', 1, signal), { code: 'pdf/index-image-unavailable' })
      }
      assert.equal(f.state.ocrIdentityResolutions, 0); assert.equal(f.state.imageIdentityResolutions, 0)
      assert.equal(f.state.renders, 0); assert.equal(f.state.recognitions, 0); assert.equal(f.state.descriptions, 0)
      assert.equal(cachedDerivations(f).length, 0)
    } finally { f.dispose() }
  }
})

test('invalid vision output cannot be persisted as an indexed description', async () => {
  const f = fixture({ native: 'native needle', scan: false, describe: true, invalidImageOutput: true })
  try {
    const partial = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(partial.nativeText.text, 'native needle')
    assert.deepEqual(partial.failure, { code: 'pdf/image-invalid-result' })
    assert.deepEqual(representations(partial).map(rep => rep.kind), ['native-text'])
    assert.equal(f.state.recognitions, 0); assert.equal(f.state.descriptions, 1); assert.equal(f.state.renders, 1)
    assert.equal(cachedDerivations(f).length, 0)
  } finally { f.dispose() }
})

test('shared vision selection owns content cache identity while disabled OCR settings remain independent', async () => {
  const f = fixture({ native: 'native needle', scan: false, describe: true,
    imageEngine: 'fixture-image' })
  try {
    const first = await f.content.read('a', 'doc-a', 1, signal), original = f.content.identity('a')
    f.updateSettings({ ocrEngine: 'missing-ocr-engine' })
    f.unregister()
    assert.equal(f.content.identity('a'), original, 'disabled OCR selections and registration changes do not invalidate visual-only content')
    assert.deepEqual(await f.content.read('a', 'doc-a', 1, signal), first)
    assert.equal(f.state.descriptions, 1)

    f.reregisterImage()
    assert.notEqual(f.content.identity('a'), original, 'the vision producer registration invalidates the active selection')
    await assert.rejects(f.content.read('a', 'doc-a', 1, signal), { code: 'pdf/stale-reader' })
    await f.content.prepare('a', signal)
    assert.equal(f.content.identity('a'), original, 'identically attested producer output remains reusable after preparation')
    assert.deepEqual(await f.content.read('a', 'doc-a', 1, signal), first)
    assert.equal(f.state.descriptions, 1)

    f.updateSettings({ imageEngine: 'fixture-image-two' })
    assert.notEqual(f.content.identity('a'), original)
    await assert.rejects(f.content.read('a', 'doc-a', 1, signal), { code: 'pdf/stale-reader' })
    await f.content.prepare('a', signal)
    const second = await f.content.read('a', 'doc-a', 1, signal)
    assert.notEqual(second.extractionIdentity, first.extractionIdentity)
    assert.equal(representations(second).find(rep => rep.kind === 'image-description')!.producer.id, 'fixture-image-two')
    assert.deepEqual(f.state.imageBindings, [{ id: 'fixture-image', variant: 'first' }, { id: 'fixture-image-two', variant: 'second' }])
    assert.equal(f.state.descriptions, 2); assert.equal(cachedDerivations(f).length, 2)

    f.state.imageModel = 'independent-visual-revision-two'
    await assert.rejects(f.content.verify('a', signal), { code: 'pdf/stale-reader' })
    await f.content.prepare('a', signal)
    const revised = await f.content.read('a', 'doc-a', 1, signal)
    assert.notEqual(revised.extractionIdentity, second.extractionIdentity)
    assert.equal(representations(revised).find(rep => rep.kind === 'image-description')!.producer.model, f.state.imageModel)
    assert.equal(f.state.descriptions, 3); assert.equal(cachedDerivations(f).length, 3)
  } finally { f.dispose() }
})

test('changing the shared image engine during visual preparation rejects obsolete index work', async () => {
  const f = fixture({ scan: false, describe: true })
  const entered = deferred(), gate = deferred()
  f.state.onImage = async () => { entered.resolve(); await gate.promise }
  const pending = f.content.read('a', 'doc-a', 1, signal)
  const rejected = assert.rejects(pending, { code: 'pdf/stale-reader' })
  try {
    await entered.promise
    f.updateSettings({ imageEngine: 'fixture-image-two' })
    gate.resolve(); await rejected
    assert.equal(cachedDerivations(f).length, 0)
    f.state.onImage = undefined
    await f.content.prepare('a', signal)
    const result = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(representations(result).find(rep => rep.kind === 'image-description')!.producer.id, 'fixture-image-two')
    assert.equal(f.state.recognitions, 0); assert.equal(f.state.descriptions, 2); assert.equal(cachedDerivations(f).length, 1)
  } finally { gate.resolve(); f.dispose() }
})

test('cancellation and shared visual backend removal cannot persist late indexed descriptions', async () => {
  for (const reason of ['cancel', 'remove', 'dispose'] as const) {
    const f = fixture({ scan: false, describe: true })
    const entered = deferred(), gate = deferred(), controller = new AbortController()
    f.state.onImage = async () => { entered.resolve(); await gate.promise }
    const pending = f.content.read('a', 'doc-a', 1, controller.signal), rejected = assert.rejects(pending)
    try {
      await entered.promise
      if (reason === 'cancel') controller.abort(new Error('Closed indexing session'))
      else if (reason === 'remove') f.unregisterImage()
      else f.content.dispose()
      await rejected
      assert.equal(cachedDerivations(f).length, 0)
      gate.resolve()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(cachedDerivations(f).length, 0)
      assert.equal(f.state.recognitions, 0)
    } finally { gate.resolve(); f.dispose() }
  }
})

test('attested engine identity reuses authorized content across sessions and service restarts', async () => {
  const f = fixture({ describe: true })
  try {
    const first = await f.content.read('a', 'doc-a', 1, signal)
    const second = await f.content.read('b', 'doc-b', 1, signal)
    assert.deepEqual(second, first)
    assert.equal(f.state.reads, 1); assert.equal(f.state.recognitions, 1); assert.equal(f.state.descriptions, 1)
    const restarted = fixture({ describe: true, cache: f.data })
    try {
      assert.deepEqual(await restarted.content.read('a', 'doc-a', 1, signal), first)
      assert.equal(restarted.state.reads, 0); assert.equal(restarted.state.recognitions, 0); assert.equal(restarted.state.descriptions, 0)
      restarted.state.denied = true
      await assert.rejects(restarted.content.read('b', 'doc-b', 1, signal), { code: 'pdf/access-denied' })
    } finally { restarted.dispose() }
  } finally { f.dispose() }
})

test('backends without a persistent identity stay isolated by session and registration lifetime', async () => {
  const f = fixture({ attested: false })
  try {
    await f.content.read('a', 'doc-a', 1, signal)
    const first = f.content.identity('a')
    await f.content.read('b', 'doc-b', 1, signal)
    assert.notEqual(first, f.content.identity('b')); assert.equal(f.state.recognitions, 2)
    f.reregister()
    await assert.rejects(f.content.read('a', 'doc-a', 1, signal), { code: 'pdf/stale-reader' })
    await f.content.prepare('a', signal); await f.content.read('a', 'doc-a', 1, signal)
    assert.notEqual(first, f.content.identity('a')); assert.equal(f.state.recognitions, 3)
    const restarted = fixture({ attested: false, cache: f.data })
    try { await restarted.content.read('a', 'doc-a', 1, signal); assert.equal(restarted.state.recognitions, 1) }
    finally { restarted.dispose() }
  } finally { f.dispose() }
})

test('policy, configuration, model and original source changes cannot consume obsolete content', async () => {
  const f = fixture()
  try {
    await f.content.read('a', 'doc-a', 1, signal)
    const original = f.content.identity('a')
    f.updateSettings({ indexImageDescriptions: true })
    await assert.rejects(f.content.read('a', 'doc-a', 1, signal), { code: 'pdf/stale-reader' })
    await f.content.prepare('a', signal); await f.content.read('a', 'doc-a', 1, signal)
    assert.notEqual(original, f.content.identity('a')); assert.equal(f.state.descriptions, 1)
    f.updateSettings({ engineConfigurations: { ocr: { fixture: { variant: 'second' } }, image: { 'fixture-image': { variant: 'first' } } } })
    await f.content.prepare('a', signal); await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(f.state.recognitions, 2, 'enabling image descriptions reused the original OCR')
    f.state.model = 'revision-two'
    await f.content.prepare('a', signal); await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(f.state.recognitions, 3)
    f.state.bytes = new Uint8Array([9, 8, 7]); f.state.version = 'content-two'
    await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(f.state.recognitions, 4)
    assert.equal(f.state.reads, 2, 'only a real source change requires native extraction again')
  } finally { f.dispose() }
})

test('attested re-registration invalidates the active selection but can reuse identical persisted output after preparation', async () => {
  const f = fixture()
  try {
    await f.content.read('a', 'doc-a', 1, signal)
    const first = f.content.identity('a')
    f.reregister()
    assert.notEqual(f.content.identity('a'), first)
    await assert.rejects(f.content.read('a', 'doc-a', 1, signal), { code: 'pdf/stale-reader' })
    await f.content.prepare('a', signal)
    assert.equal(f.content.identity('a'), first)
    await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(f.state.recognitions, 1)
  } finally { f.dispose() }
})

test('corrupted content is rebuilt and explicit refresh bypasses valid derived records exactly once', async () => {
  const f = fixture()
  try {
    await f.content.read('a', 'doc-a', 1, signal)
    const key = aggregateKey(f), cached = structuredClone(f.data.get(key)) as { blocks: { representations: { digest: string }[] }[] }
    cached.blocks[1]!.representations[0]!.digest = pageContentDigest('corrupt')
    f.data.set(key, cached)
    await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(f.state.recognitions, 1, 'a corrupt aggregate is reconstructed from verified producer layers')
    f.content.refresh('a', 'doc-a')
    f.state.text = 'needle refreshed'
    const refreshed = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(representations(refreshed).find(rep => rep.kind === 'ocr-text')!.text, 'needle refreshed')
    await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(f.state.recognitions, 2)
  } finally { f.dispose() }
})

test('cancellation, backend removal and plugin disposal cannot persist late OCR output', async () => {
  for (const reason of ['cancel', 'remove', 'dispose'] as const) {
    const f = fixture(), entered = deferred(), gate = deferred(), controller = new AbortController()
    f.state.onOcr = async () => { entered.resolve(); await gate.promise }
    const pending = f.content.read('a', 'doc-a', 1, controller.signal)
    const rejected = assert.rejects(pending)
    try {
      await entered.promise
      if (reason === 'cancel') controller.abort(new Error('Closed page'))
      else if (reason === 'remove') f.unregister()
      else f.content.dispose()
      await rejected
      assert.equal(cachedDerivations(f).length, 0)
      gate.resolve()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(cachedDerivations(f).length, 0)
    } finally { gate.resolve(); f.dispose() }
  }
})

test('source replacement during asynchronous native extraction rejects the old snapshot without caching it', async () => {
  const f = fixture({ native: 'needle native' }), entered = deferred(), gate = deferred()
  f.state.onNative = async () => { entered.resolve(); await gate.promise }
  const pending = f.content.read('a', 'doc-a', 1, signal), rejected = assert.rejects(pending, { code: 'pdf/stale-reader' })
  try {
    await entered.promise
    f.state.bytes = new Uint8Array([4, 5, 6]); f.state.version = 'content-two'
    gate.resolve(); await rejected
    assert.equal(cachedDerivations(f).length, 0); assert.equal(f.state.recognitions, 0)
  } finally { gate.resolve(); f.dispose() }
})

test('missing OCR fails on scans while optional image failure preserves native content without caching false coverage', async () => {
  const ocr = fixture()
  try {
    ocr.unregister()
    await assert.rejects(ocr.content.read('a', 'doc-a', 1, signal), { code: 'pdf/index-ocr-unavailable' })
    assert.equal(cachedDerivations(ocr).length, 0); assert.equal(ocr.state.recognitions, 0)
  } finally { ocr.dispose() }
  const image = fixture({ native: 'Native page', describe: true })
  try {
    image.image.dispose()
    const partial = await image.content.read('a', 'doc-a', 1, signal)
    assert.equal(partial.nativeText.text, 'Native page')
    assert.deepEqual(partial.failure, { code: 'pdf/index-image-unavailable' })
    assert.equal(projectPageContent(partial).failure?.code, 'pdf/index-image-unavailable')
    assert.ok(projectPageContent(partial).units?.some(unit => unit.kind === 'native-text'))
    assert.equal(cachedDerivations(image).length, 0); assert.equal(image.state.descriptions, 0)
  } finally { image.dispose() }
})

test('a dynamically changed model during cache restoration cannot bless a previous derived representation', async () => {
  const f = fixture()
  try {
    await f.content.read('a', 'doc-a', 1, signal)
    f.state.onGet = () => { f.state.model = 'new-model-revision'; f.state.onGet = undefined }
    await assert.rejects(f.content.read('a', 'doc-a', 1, signal), { code: 'pdf/stale-reader' })
    assert.equal(f.state.recognitions, 1)
    await f.content.prepare('a', signal)
    await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(f.state.recognitions, 2)
  } finally { f.dispose() }
})

test('failure while refreshing an older successful image interpretation tombstones its obsolete complete content record', async () => {
  const f = fixture({ native: 'native needle', describe: true })
  try {
    await f.content.read('a', 'doc-a', 1, signal)
    const key = aggregateKey(f)
    f.content.refresh('a', 'doc-a')
    f.state.imageFailure = true
    const partial = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(partial.nativeText.text, 'native needle')
    assert.ok(partial.failure)
    assert.equal(f.data.get(key), null)
    assert.equal(cachedDerivations(f).length, 0)
    assert.ok([...f.data.values()].some(value => parsePageContent(value)?.nativeText.text === 'native needle'),
      'a failed description does not throw away the successful native layer')
  } finally { f.dispose() }
})

test('an unavailable image backend does not prevent scan OCR from yielding explicit partial content', async () => {
  const f = fixture({ describe: true })
  try {
    f.image.dispose()
    const result = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(representations(result).find(rep => rep.kind === 'ocr-text')!.text, f.state.text)
    assert.equal(representations(result).some(rep => rep.kind === 'image-description'), false)
    assert.ok(result.failure)
    assert.equal(f.state.recognitions, 1); assert.equal(f.state.renders, 1)
    assert.deepEqual(cachedDerivations(f).map(rep => rep.kind), ['ocr-text'])
  } finally { f.dispose() }
})

test('failed OCR does not prevent an independent image description from yielding explicit partial content', async () => {
  const f = fixture({ describe: true })
  f.state.onOcr = async () => { throw new Error('Scan recognition is unavailable') }
  try {
    const result = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(representations(result).find(rep => rep.kind === 'image-description')!.text, f.state.description)
    assert.equal(representations(result).some(rep => rep.kind === 'ocr-text'), false)
    assert.ok(result.failure)
    assert.equal(f.state.recognitions, 1); assert.equal(f.state.descriptions, 1); assert.equal(f.state.renders, 1)
    assert.deepEqual(cachedDerivations(f).map(rep => rep.kind), ['image-description'])
  } finally { f.dispose() }
})

test('one session refresh cannot bypass another extraction fingerprint cache for the same source', async () => {
  const f = fixture()
  const first = { ocr: { fixture: { variant: 'first' } }, image: { 'fixture-image': { variant: 'first' } } }
  const second = { ocr: { fixture: { variant: 'second' } }, image: { 'fixture-image': { variant: 'first' } } }
  try {
    const profileOne = await f.content.read('a', 'doc-a', 1, signal)
    f.updateSettings({ engineConfigurations: second })
    await f.content.prepare('b', signal)
    await f.content.read('b', 'doc-b', 1, signal)
    assert.equal(f.state.recognitions, 2)
    f.content.refresh('b', 'doc-b')
    f.updateSettings({ engineConfigurations: first })
    await f.content.prepare('a', signal)
    assert.deepEqual(await f.content.read('a', 'doc-a', 1, signal), profileOne)
    assert.equal(f.state.recognitions, 2, 'another profile refresh must not force profile-one extraction')
    f.updateSettings({ engineConfigurations: second }); f.state.text = 'needle profile-two refreshed'
    await f.content.prepare('b', signal)
    const refreshed = await f.content.read('b', 'doc-b', 1, signal)
    assert.equal(representations(refreshed).find(rep => rep.kind === 'ocr-text')!.text, f.state.text)
    assert.equal(f.state.recognitions, 3)
  } finally { f.dispose() }
})

test('two unavailable derivation engines do not render pixels when no backend can consume them', async () => {
  const f = fixture({ describe: true })
  try {
    f.unregister(); f.image.dispose()
    await assert.rejects(f.content.read('a', 'doc-a', 1, signal))
    assert.equal(f.state.renders, 0); assert.equal(f.state.recognitions, 0); assert.equal(f.state.descriptions, 0)
    assert.equal(cachedDerivations(f).length, 0)
  } finally { f.dispose() }
})

test('an optional clean-render failure preserves native text as explicit partial content', async () => {
  const f = fixture({ native: 'native needle', describe: true })
  f.state.onRender = async () => { throw new Error('Renderer cannot produce the clean image') }
  try {
    const result = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(result.nativeText.text, 'native needle')
    assert.ok(result.failure)
    assert.equal(f.state.renders, 1); assert.equal(f.state.descriptions, 0)
    assert.equal(cachedDerivations(f).length, 0)
  } finally { f.dispose() }
})

test('source authority failures wrapped by an OCR backend remain fatal and cannot be downgraded into partial visual content', async () => {
  for (const code of ['pdf/access-denied', 'pdf/source-unavailable']) {
    const f = fixture({ describe: true })
    f.state.onOcr = async () => { throw Object.assign(new Error('The producer source is no longer authorized'), { code }) }
    try {
      await assert.rejects(f.content.read('a', 'doc-a', 1, signal), { code })
      assert.equal(f.state.descriptions, 0)
      assert.equal(cachedDerivations(f).length, 0)
    } finally { f.dispose() }
  }
})

test('an offline OCR availability probe prevents rendering pixels or starting recognition', async () => {
  const f = fixture()
  f.state.ocrAvailable = false
  try {
    await assert.rejects(f.content.read('a', 'doc-a', 1, signal), { code: 'pdf/index-ocr-unavailable' })
    assert.equal(f.state.renders, 0); assert.equal(f.state.recognitions, 0); assert.equal(cachedDerivations(f).length, 0)
  } finally { f.dispose() }
})

test('OCR repair for damaged nonempty native text is an alternative of the same logical text block', async () => {
  const f = fixture({ native: 'Broken native needle' })
  f.state.unmappedCharacters = 2
  try {
    const result = await f.content.read('a', 'doc-a', 1, signal)
    const text = result.blocks.find(block => block.kind === 'text')!
    assert.deepEqual(text.representations.map(rep => rep.kind), ['native-text', 'ocr-text'])
    assert.equal(text.representations.find(rep => rep.kind === 'ocr-text')!.text, f.state.text)
    assert.equal(result.blocks.find(block => block.kind === 'visual-region')!.representations.length, 0)
    const units = projectPageContent(result).units!
    assert.equal(new Set(units.map(unit => unit.blockId)).size, 1)
    assert.equal(units.find(unit => unit.kind === 'ocr-text')!.nativeRange, undefined)
  } finally { f.dispose() }
})

test('a thrown scan refresh invalidates the previous complete IR before recognition begins', async () => {
  const f = fixture()
  try {
    await f.content.read('a', 'doc-a', 1, signal)
    const key = aggregateKey(f)
    f.content.refresh('a', 'doc-a')
    f.state.onOcr = async () => { throw new Error('Recognition stopped working') }
    await assert.rejects(f.content.read('a', 'doc-a', 1, signal))
    assert.equal(f.data.get(key), null)
    const restart = f.create()
    try {
      await assert.rejects(restart.read('a', 'doc-a', 1, signal))
      assert.equal(f.state.recognitions, 3, 'a restarted pipeline must retry instead of restoring the obsolete successful scan')
    } finally { restart.dispose() }
  } finally { f.dispose() }
})

test('enabling and disabling an independent representation reuses native, OCR and image work without mixing the selected sources', async () => {
  const f = fixture()
  const select = async (change: Partial<PdfSettings>) => {
    f.updateSettings(change); await f.content.prepare('a', signal)
    return f.content.read('a', 'doc-a', 1, signal)
  }
  try {
    const original = await f.content.read('a', 'doc-a', 1, signal)
    const originalOcr = representations(original).find(rep => rep.kind === 'ocr-text')!
    const both = await select({ indexImageDescriptions: true })
    assert.deepEqual(representations(both).find(rep => rep.kind === 'ocr-text'), originalOcr)
    assert.deepEqual([f.state.reads, f.state.recognitions, f.state.descriptions, f.state.renders], [1, 1, 1, 2])
    const imageOnly = await select({ indexScanPages: false })
    assert.deepEqual(representations(imageOnly).map(rep => rep.kind), ['native-text', 'image-description'])
    const neither = await select({ indexImageDescriptions: false })
    assert.deepEqual(representations(neither).map(rep => rep.kind), ['native-text'])
    assert.deepEqual(representations(await select({ indexScanPages: true, indexImageDescriptions: true })), representations(both))
    assert.deepEqual([f.state.reads, f.state.recognitions, f.state.descriptions, f.state.renders], [1, 1, 1, 2],
      'source filters and restored optional representations do not render or run either producer again')
  } finally { f.dispose() }
})

test('changing one producer leaves the other cached representation and native text intact', async () => {
  const f = fixture({ describe: true })
  try {
    const first = await f.content.read('a', 'doc-a', 1, signal)
    f.updateSettings({ engineConfigurations: { ocr: { fixture: { variant: 'changed OCR' } },
      image: { 'fixture-image': { variant: 'first' }, 'fixture-image-two': { variant: 'second' } } } })
    await f.content.prepare('a', signal)
    const changedOcr = await f.content.read('a', 'doc-a', 1, signal)
    assert.deepEqual(representations(changedOcr).find(rep => rep.kind === 'image-description'),
      representations(first).find(rep => rep.kind === 'image-description'))
    assert.deepEqual([f.state.reads, f.state.recognitions, f.state.descriptions], [1, 2, 1])
    f.updateSettings({ imageEngine: 'fixture-image-two' }); await f.content.prepare('a', signal)
    const changedImage = await f.content.read('a', 'doc-a', 1, signal)
    assert.deepEqual(representations(changedImage).find(rep => rep.kind === 'ocr-text'),
      representations(changedOcr).find(rep => rep.kind === 'ocr-text'))
    assert.deepEqual([f.state.reads, f.state.recognitions, f.state.descriptions], [1, 2, 2])
    assert.equal(representations(changedImage).find(rep => rep.kind === 'image-description')!.producer.id, 'fixture-image-two')
  } finally { f.dispose() }
})

test('retrying one failed optional producer restores the other successful representation', async () => {
  const f = fixture({ describe: true })
  try {
    f.state.imageFailure = true
    const partial = await f.content.read('a', 'doc-a', 1, signal)
    assert.ok(partial.failure)
    const repaired = representations(partial).find(rep => rep.kind === 'ocr-text')!
    f.state.imageFailure = false
    const complete = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(complete.failure, undefined)
    assert.deepEqual(representations(complete).find(rep => rep.kind === 'ocr-text'), repaired)
    assert.deepEqual([f.state.reads, f.state.recognitions, f.state.descriptions], [1, 1, 2])
  } finally { f.dispose() }
})

test('cached native quality still requests OCR when recognition is enabled later', async () => {
  const f = fixture({ native: 'damaged native content', scan: false })
  try {
    f.state.unmappedCharacters = 2
    await f.content.read('a', 'doc-a', 1, signal)
    f.updateSettings({ indexScanPages: true }); await f.content.prepare('a', signal)
    const recognized = await f.content.read('a', 'doc-a', 1, signal)
    assert.deepEqual(representations(recognized).map(rep => rep.kind), ['native-text', 'ocr-text'])
    assert.equal(f.state.reads, 1); assert.equal(f.state.recognitions, 1)
  } finally { f.dispose() }
})

test('a damaged optional layer is recomputed without rerunning the healthy producer', async () => {
  const f = fixture({ describe: true })
  try {
    await f.content.read('a', 'doc-a', 1, signal)
    const ocr = [...f.data.entries()].find(([, value]) => {
      const parsed = PageRepresentationSchema.safeParse(value)
      return parsed.success && parsed.data.kind === 'ocr-text'
    })!
    f.data.set(ocr[0], { ...(ocr[1] as Record<string, unknown>), inputDigest: 'corrupted' })
    f.data.set(aggregateKey(f), null)
    const restored = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(restored.failure, undefined)
    assert.deepEqual([f.state.reads, f.state.recognitions, f.state.descriptions], [1, 2, 1])
  } finally { f.dispose() }
})

test('a legacy aggregate seeds separate native and producer caches before a policy change', async () => {
  const f = fixture({ describe: true })
  try {
    const original = await f.content.read('a', 'doc-a', 1, signal)
    const key = aggregateKey(f)
    f.data.clear()
    f.data.set(key, { ...original, blocks: original.blocks.map(block => ({ ...block,
      representations: block.representations.map(rep => rep.kind !== 'native-text' ? rep :
        createPageRepresentation({ ...rep, producer: { ...rep.producer, version: 'legacy-aggregate-extraction' } })),
    })) })
    await f.content.read('a', 'doc-a', 1, signal)
    f.updateSettings({ indexScanPages: false }); await f.content.prepare('a', signal)
    const combined = await f.content.read('a', 'doc-a', 1, signal)
    assert.deepEqual(representations(combined).map(rep => rep.kind), ['native-text', 'image-description'])
    assert.deepEqual([f.state.reads, f.state.recognitions, f.state.descriptions], [1, 1, 1])
  } finally { f.dispose() }
})

test('misfiled or differently attested producer records are cache misses rather than trusted results', async () => {
  for (const corruption of ['wrong-kind', 'wrong-producer']) {
    const f = fixture({ describe: true })
    try {
      await f.content.read('a', 'doc-a', 1, signal)
      const layer = [...f.data.entries()].find(([, value]) => {
        const result = PageRepresentationSchema.safeParse(value)
        return result.success && result.data.kind === 'ocr-text'
      })!
      const previous = PageRepresentationSchema.parse(layer[1])
      const wrong = corruption === 'wrong-kind'
        ? PageRepresentationSchema.parse([...f.data.values()].find(value => PageRepresentationSchema.safeParse(value).data?.kind === 'image-description'))
        : createPageRepresentation({ ...previous, producer: { ...previous.producer, configurationIdentity: 'another-producer' } })
      f.data.set(layer[0], wrong); f.data.set(aggregateKey(f), null)
      const restored = await f.content.read('a', 'doc-a', 1, signal)
      assert.equal(restored.failure, undefined)
      assert.deepEqual([f.state.reads, f.state.recognitions, f.state.descriptions], [1, 2, 1])
    } finally { f.dispose() }
  }
})

test('failed cache reads and writes cannot prevent successful content extraction', async () => {
  const f = fixture({ describe: true })
  try {
    f.state.onGet = () => { throw new Error('Unreadable cache') }
    f.state.cacheWriteFailure = true
    const content = await f.content.read('a', 'doc-a', 1, signal)
    assert.equal(content.failure, undefined)
    assert.deepEqual(representations(content).map(rep => rep.kind), ['native-text', 'ocr-text', 'image-description'])
    assert.equal(f.data.size, 0)
  } finally { f.dispose() }
})
