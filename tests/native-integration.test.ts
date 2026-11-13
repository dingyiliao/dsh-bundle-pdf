import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { NativeWorker } from '../src/engine/host/native-worker.ts'
import { NativeViewport } from '../src/client/viewer/index.ts'
import { materializeFixturePdf, inspectFixturePdf } from './fixtures/native-document.ts'
import { onePagePdf, pdfArray, pdfDict, pdfHex, pdfName, ref } from './fixtures/pdf-fixture-kit.ts'
import { blankPdf } from './fixtures/plain-pdf.ts'
import { hyphenatedTextPdf, nativeFixture } from './native-fixture.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native tests require a built helper')
const skip = !existsSync(executable)

test('native text extraction reports layout quality without losing ordinary text', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'text', }, await nativeFixture())
    const value = (await worker.request({ command: 'text', documentId: 'text', pageIndex: 0 })).value as { items: { str: string }[]; quality?: unknown }
    assert.equal(value.items.map(item => item.str).join(''), 'Native PDF test page 1')
    assert.equal(value.quality, undefined)
    await worker.request({ command: 'open', documentId: 'hyphen', }, await hyphenatedTextPdf())
    const hyphen = (await worker.request({ command: 'text', documentId: 'hyphen', pageIndex: 0 })).value as { items: { str: string }[] }
    assert.deepEqual(hyphen.items.map(item => item.str), ['understand', 'ing the model'])
  } finally { await worker.dispose() }
})

test('native rendering and viewport transforms agree for rotated pages', { skip }, async () => {
  const bytes = await nativeFixture(), metadata = await inspectFixturePdf(bytes), worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'geometry' }, bytes)
    const geometry = metadata.pages[1]!
    const viewport = new NativeViewport(geometry, 1, (geometry.rotation + 90) % 360)
    const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height)
    const render = await worker.request({ command: 'render', documentId: 'geometry', pageIndex: 1, rotation: 90,
      rasterWidth: width, rasterHeight: height, x: 0, y: 0, width, height, annotations: true })
    assert.equal(render.bytes.length, width * height * 4)
    const point = viewport.convertToViewportPoint(80, 90)
    assert.deepEqual(viewport.convertToPdfPoint(...point), [80, 90])
  } finally { await worker.dispose() }
})

test('native links, destinations and bounded object inspection remain available after one request fails', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'content' }, await nativeFixture())
    const links = (await worker.request({ command: 'links', documentId: 'content', pageIndex: 0 })).value as { url?: string }[]
    assert.equal(links[0]?.url, 'https://example.com/native')
    assert.deepEqual((await worker.request({ command: 'destination', documentId: 'content', name: 'chapter' })).value,
      [2, { name: 'XYZ' }, 50, 300, null])
    const inspected = (await worker.request({ command: 'inspect', documentId: 'content', pageIndex: 0, offset: 0, limit: 1 })).value as { objects: unknown[]; nextOffset: number | null }
    assert.equal(inspected.objects.length, 1)
    assert.equal(inspected.nextOffset, 1)
    // @ts-expect-error Intentionally exercise native validation.
    await assert.rejects(worker.request({ command: 'unknown' }), /Unknown native command/)
    assert.partialDeepStrictEqual((await worker.request({ command: 'hello' })).value, { protocolVersion: 2, engine: 'pdfium' })
  } finally { await worker.dispose() }
})

test('native page cache handles more pages than its bounded resident set', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'cache' }, blankPdf(18, [100, 100]))
    for (let pageIndex = 0; pageIndex < 18; pageIndex++) {
      const reply = await worker.request({ command: 'inspect', documentId: 'cache', pageIndex, offset: 0, limit: 1 })
      assert.deepEqual(reply.value, { objects: [], nextOffset: null })
    }
    assert.deepEqual((await worker.request({ command: 'inspect', documentId: 'cache', pageIndex: 0, offset: 0, limit: 1 })).value,
      { objects: [], nextOffset: null })
  } finally { await worker.dispose() }
})

test('native materialization writes annotations while preserving the original source fixture', async () => {
  const source = await onePagePdf({ pageEntries: { Annots: pdfArray([ref(7)]) }, extraObjects: [
    pdfDict({ Type: '/Annot', Subtype: '/Text', Rect: '[20 20 40 40]', Contents: pdfHex('Existing') }),
  ] })
  const result = await materializeFixturePdf(source, [{ type: 'add', annotation: {
    id: 'new-note', page: 1, subtype: 'Text', rect: [50, 50, 80, 80], contents: 'Added',
  } }])
  assert.notDeepEqual(result.bytes, source)
  const inspected = await inspectFixturePdf(result.bytes)
  assert.equal(inspected.annotations.length, 2)
})

test('native form and outline extensions are surfaced through the public document inspection', { skip }, async () => {
  const bytes = onePagePdf({ catalogEntries: { Outlines: ref(7) }, extraObjects: [
    pdfDict({ Type: '/Outlines', Count: '1', First: ref(8), Last: ref(8) }),
    pdfDict({ Title: pdfHex('Chapter'), Parent: ref(7), Dest: `[${ref(5)} ${pdfName('Fit')}]` }),
  ] })
  const inspection = await inspectFixturePdf(bytes)
  assert.equal(inspection.outline?.[0]?.title, 'Chapter')
})
