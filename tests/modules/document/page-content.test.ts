import assert from 'node:assert/strict'
import test from 'node:test'
import { appendPageRepresentation, buildNativePageContent, createPageRepresentation,
  MAX_PAGE_CONTENT_SPANS, MAX_PAGE_CONTENT_TEXT, nativePageContentText, PageContentSchema,
  pageContentBlockId, pageContentDigest, pageRepresentationId, parsePageContent } from '../../../src/modules/document/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import { joinPageText } from '../../../src/shared/page-text.ts'

type Item = NativeTextContent['items'][number]
const identity = { sourceDigest: pageContentDigest('source PDF bytes'), page: 1, extractionIdentity: 'fixture-v1' }
function item(str: string, x = 10, y = 100, size = 10, hasEOL = false): Item {
  return { str, transform: [size, 0, 0, size, x, y], width: [...str].length * 5, height: size,
    dir: 'ltr', fontName: 'fixture', hasEOL,
    glyphs: [...str].map((_character, index) => [x + index * 5, y, 5]) }
}
function content(items: Item[]): NativeTextContent {
  return { items, styles: { fixture: { fontFamily: 'sans', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null }
}
function page(layer: NativeTextContent | null = content([item('Hello 😀'), item('world', 60)])) {
  return buildNativePageContent({ ...identity, pageRect: [0, 0, 200, 300], content: layer })
}
const derived = (kind: 'ocr-text' | 'image-description', text: string, configurationIdentity = 'profile-a') =>
  createPageRepresentation({ kind, text, producer: { id: 'fixture-engine', version: '1', model: 'fixture', configurationIdentity },
    inputDigest: pageContentDigest('clean page pixels'), status: 'complete', warnings: [] })

test('native page content preserves exact joined offsets, paragraphs and known glyph geometry', () => {
  const items = [item('Title', 10, 260, 20, true), item('Wrapped 😀', 10, 210, 10, true),
    item('body line.', 10, 195, 10, true), item('New paragraph.', 10, 145)]
  const result = page(content(items))
  assert.equal(result.nativeText.text, joinPageText(items))
  assert.deepEqual(result.nativeText.paragraphBreaks, [6, 28])
  assert.equal(result.nativeText.digest, pageContentDigest(joinPageText(items)))
  const block = result.blocks[0]!, representation = block.representations[0]!
  assert.deepEqual(block.nativeRange, { startUtf16: 0, endUtf16: result.nativeText.text.length })
  assert.equal(representation.text, result.nativeText.text)
  assert.deepEqual(representation.spans?.map(span => [span.startUtf16, span.endUtf16]), [[0, 5], [6, 16], [17, 27], [28, 42]])
  assert.deepEqual(representation.spans?.[1]?.rectPdf, [10, 208, 55, 218])
  assert.equal(result.blocks[1]?.kind, 'visual-region')
  assert.deepEqual(result.blocks[1]?.rectPdf, result.pageRect)
  assert.deepEqual(result.blocks[1]?.representations, [])
  assert.equal(parsePageContent(JSON.parse(JSON.stringify(result)))?.nativeText.text, result.nativeText.text)
})

test('empty, unavailable and recovered layers never invent native text or figure segmentation', () => {
  const empty = page(content([]))
  assert.equal(empty.nativeText.text, '')
  assert.deepEqual(empty.nativeText.paragraphBreaks, [])
  assert.equal(empty.blocks.length, 2)
  assert.ok(PageContentSchema.safeParse(empty).success)
  const missing = page(null)
  assert.equal(missing.nativeText.text, '')
  assert.match(missing.warnings[0]!, /unavailable/)
  assert.equal(missing.blocks[0]?.representations[0]?.status, 'partial')
  const brokenMapping = page({ ...content([item('unmapped')]), quality: { unmappedCharacters: 1 } })
  assert.equal(brokenMapping.blocks[0]?.representations[0]?.status, 'partial')
  assert.match(brokenMapping.warnings[0]!, /invalid PDF mapping/)
  const recovered = page({ ...content([item('Recognized text')]), extraction: 'local-ocr' })
  assert.equal(recovered.nativeText.text, '')
  assert.equal(recovered.blocks[0]?.nativeRange, undefined)
  assert.equal(recovered.blocks[0]?.representations[0]?.kind, 'ocr-text')
  assert.equal(recovered.blocks[0]?.representations[0]?.text, 'Recognized text')
  assert.equal(recovered.blocks[0]?.representations[0]?.spans, undefined)
})

test('missing, invalid and multiline geometry stays absent without changing text', () => {
  const layer = content([{ ...item('Many'), glyphs: undefined },
    { ...item('NaN'), transform: [NaN, 0, 0, 10, 10, 100] },
    { ...item('Broken glyph'), glyphs: [[10, 100, -1]] }, item('multiple\nlines')])
  const result = page(layer)
  assert.equal(result.nativeText.text, joinPageText(layer.items))
  assert.equal(result.blocks[0]?.representations[0]?.spans, undefined)
  const single = page(content([{ ...item('😀'), glyphs: undefined }]))
  assert.deepEqual(single.blocks[0]?.representations[0]?.spans, [{ startUtf16: 0, endUtf16: 2, rectPdf: [10, 98, 15, 108] }])
  const unknownFont = page({ ...content([item('text')]), styles: {} })
  assert.equal(unknownFont.blocks[0]?.representations[0]?.spans, undefined)
})

test('parallel rotated native spans use the native axes and scalar lengths', () => {
  const rotated = { ...item('A😀'), transform: [0, 10, -10, 0, 100, 20], glyphs: [[100, 20, 5], [100, 25, 5]] as Item['glyphs'] }
  assert.deepEqual(page(content([rotated])).blocks[0]?.representations[0]?.spans,
    [{ startUtf16: 0, endUtf16: 3, rectPdf: [92, 20, 102, 30] }])
})

test('OCR text without boxes and image descriptions coexist and immutable upserts preserve native offsets', () => {
  const initial = page(), block = initial.blocks[1]!
  const ocr = derived('ocr-text', 'Recognized diagram labels')
  const description = derived('image-description', 'A diagram connects three nodes.')
  const withOcr = appendPageRepresentation(initial, block.id, ocr)
  const result = appendPageRepresentation(withOcr, block.id, description)
  assert.deepEqual(result.blocks[1]?.representations.map(rep => rep.kind), ['ocr-text', 'image-description'])
  assert.equal(result.blocks[1]?.representations[0]?.spans, undefined)
  assert.deepEqual(result.nativeText, initial.nativeText)
  assert.deepEqual(initial.blocks[1]?.representations, [])
  assert.equal(withOcr.blocks[1]?.representations.length, 1)
  assert.equal(appendPageRepresentation(result, block.id, ocr).blocks[1]?.representations.length, 2)
  assert.throws(() => appendPageRepresentation(initial, 'missing', ocr), /does not exist/)
})

test('representation spans allow adjacent offsets and overlapping rectangles but reject overlapping or unordered text', () => {
  const rectPdf: [number, number, number, number] = [0, 0, 20, 10]
  const span = (startUtf16: number, endUtf16: number) => ({ startUtf16, endUtf16, rectPdf })
  const original = derived('ocr-text', 'abcdef')
  const valid = createPageRepresentation({ ...original, spans: [span(0, 2), span(2, 4), span(5, 6)] })
  assert.deepEqual(valid.spans?.map(item => item.rectPdf), [rectPdf, rectPdf, rectPdf],
    'PDF rectangles may overlap even though representation text ranges do not')
  const initial = page(content([])), visual = initial.blocks[1]!
  for (const spans of [[span(0, 3), span(2, 4)], [span(3, 4), span(0, 2)], [span(0, 2), span(0, 2)]]) {
    assert.throws(() => createPageRepresentation({ ...original, spans }), /non-overlapping text order/)
    assert.equal(parsePageContent({ ...initial, blocks: [{ ...visual, representations: [{ ...original, spans }] }] }), undefined)
  }
  assert.ok(parsePageContent(appendPageRepresentation(initial, visual.id, valid)))
})

test('block identities include source, page and extraction while representations include producer and clean input identity', () => {
  const first = pageContentBlockId(identity, 'native-text')
  assert.equal(first, pageContentBlockId({ ...identity }, 'native-text'))
  for (const changed of [{ ...identity, sourceDigest: pageContentDigest('other') }, { ...identity, page: 2 },
    { ...identity, extractionIdentity: 'fixture-v2' }]) assert.notEqual(first, pageContentBlockId(changed, 'native-text'))
  assert.notEqual(first, pageContentBlockId(identity, 'full-page-visual'))
  const rep = derived('ocr-text', 'same')
  assert.equal(rep.id, pageRepresentationId(rep))
  assert.notEqual(rep.id, derived('ocr-text', 'same', 'profile-b').id)
  assert.notEqual(rep.id, createPageRepresentation({ ...rep, inputDigest: pageContentDigest('different pixels') }).id)
  assert.notEqual(rep.id, derived('image-description', 'same').id)
})

test('persisted cache validation rejects corruption, foreign fields, null geometry and invalid Unicode offsets', () => {
  const valid = page()
  const invalid: unknown[] = [null, [], {}, { ...valid, version: 2 }, { ...valid, sourceDigest: 'sha256:broken' },
    { ...valid, page: 0 }, { ...valid, pageRect: [0, 0, 0, 300] }, { ...valid, pageRect: [0, 0, NaN, 300] },
    { ...valid, png: 'base64 image bytes' }, { ...valid, nativeText: { ...valid.nativeText, text: 'tampered' } },
    { ...valid, nativeText: { ...valid.nativeText, paragraphBreaks: [7] } },
    { ...valid, nativeText: { ...valid.nativeText, paragraphBreaks: [3, 3] } },
    { ...valid, blocks: [...valid.blocks, valid.blocks[0]] },
    { ...valid, blocks: [{ ...valid.blocks[0], rectPdf: null }] },
    { ...valid, blocks: [{ ...valid.blocks[0], nativeRange: { startUtf16: 0, endUtf16: 7 } }] },
    { ...valid, blocks: [{ ...valid.blocks[0], representations: [{ ...valid.blocks[0]!.representations[0], digest: pageContentDigest('wrong') }] }] },
    { ...valid, blocks: [{ ...valid.blocks[0], representations: [{ ...valid.blocks[0]!.representations[0],
      spans: [{ startUtf16: 6, endUtf16: 7, rectPdf: [0, 0, 1, 1] }] }] }] },
  ]
  for (const value of invalid) assert.equal(parsePageContent(value), undefined)
  const changedNative = createPageRepresentation({ kind: 'native-text', text: 'different native wording',
    producer: { id: 'bad' }, status: 'complete', warnings: [] })
  assert.throws(() => appendPageRepresentation(valid, valid.blocks[0]!.id, changedNative))
})

test('page text, total representation text, counts and spans have bounded cache budgets', () => {
  assert.throws(() => page(content([{ ...item('x'), str: 'x'.repeat(MAX_PAGE_CONTENT_TEXT + 1), glyphs: undefined }])))
  const initial = page(content([])), visual = initial.blocks[1]!
  const large = derived('ocr-text', 'x'.repeat(MAX_PAGE_CONTENT_TEXT))
  const full = appendPageRepresentation(initial, visual.id, large)
  assert.throws(() => appendPageRepresentation(full, visual.id, derived('image-description', 'one more')))
  const many = Array.from({ length: 33 }, (_, index) => derived('ocr-text', String(index)))
  assert.equal(parsePageContent({ ...initial, blocks: [{ ...visual, representations: many }] }), undefined)
  const span = { startUtf16: 0, endUtf16: 1, rectPdf: [0, 0, 1, 1] as [number, number, number, number] }
  assert.throws(() => createPageRepresentation({ ...derived('ocr-text', 'x'), spans: Array(MAX_PAGE_CONTENT_SPANS + 1).fill(span) }))
  const orderedSpans = Array.from({ length: 6_000 }, (_, index) => ({ ...span, startUtf16: index, endUtf16: index + 1 }))
  const positionedOcr = createPageRepresentation({ ...derived('ocr-text', 'x'.repeat(6_000)), spans: orderedSpans })
  const positionedDescription = createPageRepresentation({ ...derived('image-description', 'x'.repeat(6_000)), spans: orderedSpans })
  const withSpans = appendPageRepresentation(initial, visual.id, positionedOcr)
  assert.throws(() => appendPageRepresentation(withSpans, visual.id, positionedDescription))
  const tooManyBlocks = Array.from({ length: 5 }, (_, blockIndex) => ({ ...visual,
    id: pageContentBlockId(identity, `block-${blockIndex}`),
    representations: Array.from({ length: 26 }, (_, index) => derived('ocr-text', `${blockIndex}/${index}`)) }))
  assert.equal(parsePageContent({ ...initial, blocks: tooManyBlocks }), undefined)
  const manyNativeSpans = page(content(Array.from({ length: MAX_PAGE_CONTENT_SPANS + 1 }, () => item('x'))))
  assert.equal(manyNativeSpans.blocks[0]?.representations[0]?.spans, undefined)
  assert.match(manyNativeSpans.warnings[0]!, /span budget/)
  assert.equal(manyNativeSpans.nativeText.text.length, MAX_PAGE_CONTENT_SPANS + 1)
})

test('native content paragraph grouping retains unknown and interleaved extraction order', () => {
  const lines = [item('Left', 10, 200, 10, true), item('Right', 150, 200, 10, true), item('Next', 10, 180)]
  assert.deepEqual(nativePageContentText(lines), { text: joinPageText(lines), paragraphBreaks: [] })
  assert.deepEqual(nativePageContentText([]), { text: '', paragraphBreaks: [] })
})
