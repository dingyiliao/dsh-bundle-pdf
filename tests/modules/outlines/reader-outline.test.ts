import assert from 'node:assert/strict'
import test from 'node:test'
import type { PdfDocumentInfo, PdfOutlineItem } from '../../../src/core/pdf-types.ts'
import type { NativeOutlineItem } from '../../../src/shared/native.ts'
import { projectedReaderOutline } from '../../../src/modules/outlines/reader-outline.ts'

const chapterView = [{ num: 17, gen: 0 }, { name: 'XYZ' }, 32, 700, 1.25]
const namedView = 'named-section'
const externalUrl = 'https://example.com/reference'
const baseline: PdfOutlineItem[] = [
  { id: 'chapter', title: 'Chapter', page: 1, children: [
    { id: 'section', title: 'Section', page: 2, children: [] },
  ] },
  { id: 'external', title: 'Reference', children: [] },
]
const native: NativeOutlineItem[] = [
  { title: 'Chapter', dest: chapterView, items: [
    { title: 'Section', dest: namedView, items: [] },
  ] },
  { title: 'Reference', url: externalUrl, items: [] },
]
function document(outline?: PdfOutlineItem[]): PdfDocumentInfo {
  return { pageCount: 5, pages: [], annotations: [], signed: false,
    encrypted: false, readOnly: false, ...(outline ? { outline } : {}) }
}

test('reader outline matches stable baseline IDs after rename, reordering and reparenting', () => {
  const projected = projectedReaderOutline(document([
    { ...baseline[0].children[0], title: 'Renamed section' },
    { ...baseline[1], title: 'External reference' },
    { ...baseline[0], children: [] },
  ]), baseline, native)!
  assert.deepEqual(projected.map(item => [item.id, item.title]), [
    ['section', 'Renamed section'], ['external', 'External reference'], ['chapter', 'Chapter'],
  ])
  assert.equal(projected[0].dest, namedView)
  assert.equal(projected[1].url, externalUrl)
  assert.strictEqual(projected[2].dest, chapterView, 'renaming/moving retains the original precise destination object')
  assert.equal(native[0].items[0].title, 'Section', 'the native baseline stays immutable')
  assert.equal(baseline[0].children.length, 1, 'the inspection baseline stays immutable')
})

test('new bookmarks and explicit page changes use one-based physical pages converted to Fit destinations', () => {
  const projected = projectedReaderOutline(document([
    { id: 'new', title: 'New chapter', page: 5, children: [] },
    { ...baseline[0], page: 3, children: [] },
  ]), baseline, native)!
  assert.deepEqual(projected[0].dest, [4, { name: 'Fit' }])
  assert.deepEqual(projected[1].dest, [2, { name: 'Fit' }])
  assert.equal(projected[1].url, undefined)
})

test('an explicitly replaced target on the same page does not restore the old precise destination', () => {
  const projected = projectedReaderOutline(document([
    { ...baseline[0], targetChanged: true, children: [] },
  ]), baseline, native)!
  assert.deepEqual(projected[0].dest, [0, { name: 'Fit' }])
  assert.notStrictEqual(projected[0].dest, chapterView)
})

test('untouched nested precise targets and external URLs survive an unrelated inserted bookmark', () => {
  const projected = projectedReaderOutline(document([
    { id: 'new', title: 'New', page: 4, children: [] }, ...baseline,
  ]), baseline, native)!
  assert.strictEqual(projected[1].dest, chapterView)
  assert.equal(projected[1].items[0].dest, namedView)
  assert.equal(projected[2].url, externalUrl)
})

test('unsupported inspection and outline read-only reasons retain the native outline unchanged', () => {
  assert.strictEqual(projectedReaderOutline(document(), baseline, native), native)
  assert.strictEqual(projectedReaderOutline({ ...document(baseline), outlineReadOnlyReason: 'Damaged outline tree' },
    baseline, native), native)
  assert.strictEqual(projectedReaderOutline(document(baseline), undefined, native), native)
  assert.equal(projectedReaderOutline(document(), undefined, null), null)
})

test('editable empty outlines retain the native null convention and missing peers project safely', () => {
  assert.equal(projectedReaderOutline(document([]), [], null), null)
  const projected = projectedReaderOutline(document([
    { id: 'group', title: 'Group', children: [{ id: 'child', title: 'Child', page: 2, children: [] }] },
  ]), [], null)!
  assert.equal(projected[0].dest, undefined)
  assert.equal(projected[0].url, undefined)
  assert.deepEqual(projected[0].items[0].dest, [1, { name: 'Fit' }])
  const unmatched = projectedReaderOutline(document(baseline), baseline, [])!
  assert.deepEqual(unmatched[0].dest, [0, { name: 'Fit' }])
  assert.deepEqual(unmatched[0].items[0].dest, [1, { name: 'Fit' }])
})
