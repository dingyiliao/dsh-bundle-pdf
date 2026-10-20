import assert from 'node:assert/strict'
import test from 'node:test'
import { currentOutlineKey, outlineAncestorKeys } from '../../../src/modules/viewer/model/bookmark-current.ts'
import type { ReaderOutlineItem } from '../../../src/modules/viewer/ports/reader-document.ts'

const outline: ReaderOutlineItem[] = [
  { title: 'Introduction', dest: [0, { name: 'Fit' }], items: [] },
  { title: 'Chapter 1', dest: [2, { name: 'Fit' }], items: [
    { title: 'Section 1', dest: [2, { name: 'Fit' }], items: [] },
    { title: 'Section 2', dest: [5, { name: 'Fit' }], items: [] },
  ] },
  { title: 'Online appendix', url: 'https://example.com', items: [] },
]

test('outline selection tracks the nearest preceding destination and the more specific section', () => {
  assert.equal(currentOutlineKey(outline, 1, 10), '0')
  assert.equal(currentOutlineKey(outline, 2, 10), '0')
  assert.equal(currentOutlineKey(outline, 3, 10), '1/0')
  assert.equal(currentOutlineKey(outline, 6, 10), '1/1')
  assert.deepEqual(outlineAncestorKeys('1/0/3'), ['1', '1/0'])
})

test('outline selection ignores missing, invalid, and future destinations', () => {
  assert.equal(currentOutlineKey(outline, 0, 10), undefined)
  assert.equal(currentOutlineKey(outline.slice(1), 2, 10), undefined)
  assert.equal(currentOutlineKey([{ title: 'Named', dest: 'chapter', items: [] }], 2, 10), undefined)
  assert.equal(currentOutlineKey([{ title: 'Out of bounds', dest: [12, { name: 'Fit' }], items: [] }], 10, 10), undefined)
})
