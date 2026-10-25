import assert from 'node:assert/strict'
import test from 'node:test'
import { retrievalPageText } from '../../../src/modules/retrieval/paragraphs.ts'
import { chunkPage } from '../../../src/modules/retrieval/text.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'
import { joinPageText } from '../../../src/shared/page-text.ts'

type Item = NativeTextContent['items'][number]
function line(str: string, y: number, size = 15, x = 42, hasEOL = true): Item {
  return { str, transform: [size, 0, 0, size, x, y], height: size, width: str.length * size / 2,
    hasEOL, fontName: 'fixture', dir: 'ltr' }
}
const chunks = (items: Item[]) => {
  const page = retrievalPageText(items)
  assert.equal(page.text, joinPageText(items))
  return chunkPage(1, page.text, 'pdf-text', { paragraphBreaks: page.paragraphBreaks })
}

test('native paragraph gaps isolate useful short-page passages while keeping their wrapped lines together', () => {
  const body = ['A model may memorize training examples', 'and fail on unfamiliar data.']
  const items = [line('Field notes', 632, 10), line('Generalization', 606, 9),
    line('When memorization fails', 558, 25), line(body[0], 505), line(body[1], 480),
    line('Another paragraph starts here', 429), line('and continues here.', 404),
    line('Footer', 44, 9)]
  const result = chunks(items)
  assert.deepEqual(result.map(chunk => chunk.text), ['Field notes', 'Generalization', 'When memorization fails',
    body.join('\n'), 'Another paragraph starts here\nand continues here.', 'Footer'])
  assert.equal(result[3]!.startUtf16, joinPageText(items.slice(0, 3)).length + 1)
  assert.ok(result.length < items.length, 'each visual line must not become an independent indexed vector')
})

test('font-size changes between blocks split headings but inline font changes keep a single paragraph', () => {
  const items = [line('Heading', 400, 25), line('Plain ', 360, 12, 42, false),
    line('emphasis', 360, 18, 78, false), line(' text.', 360, 12, 150), line('Wrapped continuation.', 340, 12)]
  assert.deepEqual(chunks(items).map(chunk => chunk.text), ['Heading', 'Plain emphasis text.\nWrapped continuation.'])
})

test('line-end superscripts and leading small markers do not split an ordinary wrapped paragraph', () => {
  const endSuperscript = [line('A body sentence with a footnote marker', 300, 12, 42, false),
    line('1', 304, 8, 270), line('continues on the next visual line.', 286, 12)]
  assert.deepEqual(retrievalPageText(endSuperscript).paragraphBreaks, [])
  assert.equal(chunks(endSuperscript).length, 1)
  const leadingMarker = [line('The first visual body line continues', 300, 12),
    line('2', 290, 8, 42, false), line('with ordinary prose after a short marker.', 286, 12, 50)]
  assert.deepEqual(retrievalPageText(leadingMarker).paragraphBreaks, [])
  assert.equal(chunks(leadingMarker).length, 1)
  // Several shorter body runs still outweigh one longer superscript run.
  const fragments = [line('Body ', 300, 12, 42, false), line('words ', 300, 12, 72, false),
    line('here ', 300, 12, 108, false), line('123456', 304, 8, 138),
    line('A normally wrapped continuation.', 286, 12)]
  assert.deepEqual(retrievalPageText(fragments).paragraphBreaks, [])
  assert.equal(chunks(fragments).length, 1)
})

test('ordinary double-spaced lines remain one bounded passage rather than one vector per line', () => {
  const items = Array.from({ length: 16 }, (_, index) => line(`Wrapped line ${index}.`, 700 - index * 24, 12))
  assert.deepEqual(retrievalPageText(items).paragraphBreaks, [])
  assert.equal(chunks(items).length, 1)
  // The previous line may consist of several same-baseline runs.
  const runs = [line('Wrapped ', 300, 12, 42, false), line('line.', 300, 12, 90),
    line('Next visual line.', 276, 12), line('Still the same paragraph.', 252, 12)]
  assert.equal(chunks(runs).length, 1)
})

test('obviously large uniform gaps can delimit short one-line paragraphs', () => {
  const items = [line('First short paragraph.', 500), line('Second short paragraph.', 430), line('Third.', 360)]
  assert.deepEqual(chunks(items).map(chunk => chunk.text), items.map(item => item.str))
})

test('interleaved columns retain their original ambiguous range and extraction order', () => {
  const items = [line('Left start', 260, 12, 60, false), line('Right unrelated', 260, 12, 180, false),
    line('Left following', 240, 12, 60)]
  assert.equal(chunks(items).length, 1)
  // Incorrect/same-baseline EOLs are not permission to reorder column text.
  const sameBaseline = [line('Title', 400, 24), line('Left start', 340, 12, 60),
    line('Right unrelated', 340, 12, 180), line('Left following', 320, 12, 60)]
  assert.deepEqual(retrievalPageText(sameBaseline).paragraphBreaks, [])
  assert.equal(chunks(sameBaseline).length, 1)
})

test('unknown geometry, orientation changes and upward column jumps do not invent paragraph boundaries', () => {
  const invalid = [line('First', 300), { ...line('No geometry', 250), transform: [NaN, 0, 0, 15, 42, 250] },
    { ...line('Zero scale', 200), transform: [0, 0, 0, 0, 42, 200], height: 0 },
    { ...line('Rotated elsewhere', 150), transform: [0, 15, -15, 0, 150, 42] }]
  assert.deepEqual(retrievalPageText(invalid).paragraphBreaks, [])
  assert.equal(chunks([line('Lower', 100), line('Upper column', 500)]).length, 1)
  assert.deepEqual(retrievalPageText([line('First', 300), line(' ', 200), line('Last', 100)]).paragraphBreaks, [])
  assert.deepEqual(retrievalPageText([]), { text: '', paragraphBreaks: [] })
})

test('explicit blank lines survive even when an item itself contains several lines without final-baseline geometry', () => {
  const items = [line('One paragraph\nwraps here.\n\nAnother paragraph.', 300), line('Continues.', 250)]
  assert.deepEqual(retrievalPageText(items).paragraphBreaks, [])
  assert.deepEqual(chunks(items).map(chunk => chunk.text), ['One paragraph\nwraps here.', 'Another paragraph.\nContinues.'])
})

test('parallel rotated text uses its own baseline and leading without reordering source text', () => {
  const items = [line('First rotated line', 0), line('Wrapped rotated line', 0), line('Next paragraph', 0)]
    .map((item, index) => ({ ...item, transform: [0, 15, -15, 0, [100, 125, 180][index]!, 42] }))
  assert.deepEqual(chunks(items).map(chunk => chunk.text), ['First rotated line\nWrapped rotated line', 'Next paragraph'])
})
