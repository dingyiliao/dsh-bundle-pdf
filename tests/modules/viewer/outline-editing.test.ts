import assert from 'node:assert/strict'
import test from 'node:test'
import type { PdfDocumentInfo, PdfOutlineItem } from '../../../src/core/pdf-types.ts'
import { projectOutlineOperations } from '../../../src/modules/outlines/index.ts'
import { outlineDrop, outlineKeyboardMove, outlineLocations } from '../../../src/modules/viewer/model/outline-editing.ts'

const items: PdfOutlineItem[] = [
  { id: 'a', title: 'A', page: 1, children: [{ id: 'child', title: 'Child', page: 2, children: [] }] },
  { id: 'b', title: 'B', page: 3, children: [] }, { id: 'c', title: 'C', children: [] },
]
const locations = outlineLocations(items)
const document = { pageCount: 5, pages: [], annotations: [], outline: items, readOnly: false, signed: false, encrypted: false } satisfies PdfDocumentInfo

test('drag reorder accounts for source removal in both directions and ignores no-op drops', () => {
  const down = outlineDrop(locations, 'a', 'c', 'after')!
  assert.equal(down.index, 2)
  assert.deepEqual(projectOutlineOperations(document, [down]).outline?.map(item => item.id), ['b', 'c', 'a'])
  assert.deepEqual(projectOutlineOperations(document, [outlineDrop(locations, 'c', 'a', 'before')!]).outline?.map(item => item.id), ['c', 'a', 'b'])
  assert.equal(outlineDrop(locations, 'a', 'b', 'before'), undefined)
  assert.equal(outlineDrop(locations, 'b', 'a', 'after'), undefined)
})

test('drop inside nests whole subtrees without mutating the source or allowing cycles', () => {
  assert.equal(outlineDrop(locations, 'a', 'child', 'inside'), undefined)
  assert.equal(outlineDrop(locations, 'a', 'child', 'after'), undefined)
  assert.equal(outlineDrop(locations, 'a', 'a', 'before'), undefined)
  assert.equal(outlineDrop(locations, 'missing', 'a', 'inside'), undefined)
  const result = projectOutlineOperations(document, [outlineDrop(locations, 'a', 'b', 'inside')!])
  assert.equal(result.outline?.[0].children[0].id, 'a')
  assert.equal(result.outline?.[0].children[0].children[0].id, 'child')
  assert.equal(items[0].children[0].id, 'child')
})

test('keyboard moves share drag semantics for reorder, indent and outdent', () => {
  assert.deepEqual(outlineKeyboardMove(locations, items, 'b', 'up'), outlineDrop(locations, 'b', 'a', 'before'))
  assert.deepEqual(outlineKeyboardMove(locations, items, 'a', 'down'), outlineDrop(locations, 'a', 'b', 'after'))
  assert.deepEqual(outlineKeyboardMove(locations, items, 'b', 'indent'), { type: 'outline-move', id: 'b', parentId: 'a', index: 1 })
  assert.deepEqual(outlineKeyboardMove(locations, items, 'child', 'outdent'), { type: 'outline-move', id: 'child', parentId: undefined, index: 1 })
  assert.equal(outlineKeyboardMove(locations, items, 'a', 'outdent'), undefined)
  assert.equal(outlineKeyboardMove(locations, items, 'a', 'up'), undefined)
  assert.equal(outlineKeyboardMove(locations, items, 'c', 'down'), undefined)
})
