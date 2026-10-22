import assert from 'node:assert/strict'
import test from 'node:test'
import type { PdfDocumentInfo, PdfOutlineItem, PdfOutlineOperation } from '../../../src/core/pdf-types.ts'
import {
  isOutlineOperation, projectOutlineOperations, MAX_OUTLINE_ITEMS, MAX_OUTLINE_DEPTH,
} from '../../../src/modules/outlines/index.ts'
import { outlineOperationSchema, workingCopyOperationSchema } from '../../../src/contracts/rpc/requests.ts'

const document = (outline: PdfOutlineItem[] = []): PdfDocumentInfo => ({
  pageCount: 5, pages: [], annotations: [], signed: false, encrypted: false, readOnly: false, outline,
})
const item = (id: string, children: PdfOutlineItem[] = [], page?: number): PdfOutlineItem => ({ id, title: id, page, children })
const apply = (outline: PdfOutlineItem[], operations: PdfOutlineOperation[]) => projectOutlineOperations(document(outline), operations).outline!

test('outline edits preserve source metadata, support groups and external destinations, and never mutate the baseline', () => {
  const baseline = document([item('chapter', [item('child', [], 2)], 1), { ...item('external'), title: '' }])
  const before = structuredClone(baseline)
  const changed = projectOutlineOperations(baseline, [
    { type: 'outline-add', id: 'new', title: '  新书签  ', page: 4, parentId: 'chapter', index: 0 },
    { type: 'outline-update', id: 'external', patch: { title: 'External title' } },
    { type: 'outline-update', id: 'child', patch: { title: 'Changed', page: 5 } },
  ])
  assert.deepEqual(changed.outline?.[0].children.map(node => [node.id, node.title, node.page]), [
    ['new', '新书签', 4], ['child', 'Changed', 5],
  ])
  assert.equal(changed.outline?.[1].page, undefined, 'renaming does not fabricate a destination')
  assert.equal(changed.outline?.[0].children[0].targetChanged, true, 'every new bookmark uses an explicit page-fit target')
  assert.equal(changed.annotations, baseline.annotations)
  assert.deepEqual(baseline, before)
  assert.notEqual(changed.outline?.[0].children, baseline.outline?.[0].children)
})

test('deleting and recreating an ID on its original page still replaces the original view destination', () => {
  const baseline = [item('same-id', [], 2)]
  const changed = apply(baseline, [
    { type: 'outline-delete', id: 'same-id' },
    { type: 'outline-add', id: 'same-id', title: 'Recreated', page: 2 },
  ])
  assert.deepEqual(changed, [{ id: 'same-id', title: 'Recreated', page: 2, targetChanged: true, children: [] }])
  assert.equal(baseline[0].targetChanged, undefined)
})

test('move indexes refer to siblings after removal and moving/deleting keeps whole subtrees', () => {
  const source = [item('a', [item('a1')]), item('b'), item('c')]
  const reordered = apply(source, [{ type: 'outline-move', id: 'a', index: 2 }])
  assert.deepEqual(reordered.map(node => node.id), ['b', 'c', 'a'])
  assert.equal(reordered[2].children[0].id, 'a1')
  const nested = apply(reordered, [{ type: 'outline-move', id: 'a', parentId: 'b', index: 0 }])
  assert.equal(nested[0].children[0].children[0].id, 'a1')
  const promoted = apply(nested, [{ type: 'outline-move', id: 'a', index: 0 }])
  assert.deepEqual(promoted.map(node => node.id), ['a', 'b', 'c'])
  assert.deepEqual(apply(promoted, [{ type: 'outline-delete', id: 'a' }]).map(node => node.id), ['b', 'c'])
})

test('invalid operations reject the whole projection without changing existing or previously added nodes', () => {
  const original = [item('a', [item('child')]), item('b')]
  for (const bad of [
    { type: 'outline-add', id: 'a', title: 'Duplicate', page: 1 },
    { type: 'outline-add', id: 'new', title: ' ', page: 1 },
    { type: 'outline-add', id: 'new', title: 'x'.repeat(1025), page: 1 },
    { type: 'outline-add', id: 'new', title: 'Title', page: 6 },
    { type: 'outline-add', id: 'new', title: 'Title', page: 0 },
    { type: 'outline-add', id: 'new', title: 'Title', page: 1.2 },
    { type: 'outline-add', id: 'new', title: 'Title', page: 1, index: 4 },
    { type: 'outline-move', id: 'a', parentId: 'child', index: 0 },
    { type: 'outline-move', id: 'a', parentId: 'a', index: 0 },
    { type: 'outline-move', id: 'a', index: 3 },
    { type: 'outline-update', id: 'a', patch: {} },
    { type: 'outline-update', id: 'a', patch: { title: 'changed', unknown: true } },
    { type: 'outline-update', id: 'a', patch: { page: 99 } },
    { type: 'outline-add', id: '\0', title: 'Title', page: 1 },
  ] as PdfOutlineOperation[]) {
    const before = structuredClone(original)
    assert.throws(() => apply(original, [{ type: 'outline-add', id: 'early', title: 'Earlier', page: 1 }, bad]),
      { code: 'invalid-operation' }, JSON.stringify(bad))
    assert.deepEqual(original, before)
  }
  for (const operation of [
    { type: 'outline-delete', id: 'missing' },
    { type: 'outline-update', id: 'missing', patch: { title: 'New' } },
    { type: 'outline-move', id: 'a', parentId: 'missing', index: 0 },
    { type: 'outline-add', id: 'new', parentId: 'missing', title: 'New', page: 1 },
  ] as PdfOutlineOperation[]) assert.throws(() => apply(original, [operation]), { code: 'unknown-outline' })
})

test('missing inspection, damaged trees and document restrictions stay read only while a genuine empty outline is editable', () => {
  const change: PdfOutlineOperation[] = [{ type: 'outline-add', id: 'new', title: 'New', page: 1 }]
  for (const baseline of [
    { ...document(), readOnly: true },
    { ...document(), outlineReadOnlyReason: 'Damaged links' },
    { ...document(), outline: undefined },
    document([item('same'), item('same')]),
    document([item('invalid-page', [], 9)]),
  ]) assert.throws(() => projectOutlineOperations(baseline, change), { code: 'outline-read-only' })
  const cyclic = item('cycle')
  cyclic.children.push(cyclic)
  assert.throws(() => apply([cyclic], change), { code: 'outline-read-only' })
  assert.equal(projectOutlineOperations(document(), change).outline?.[0].title, 'New')
  const unavailable = { ...document(), outline: undefined }
  assert.equal(projectOutlineOperations(unavailable, []), unavailable)
})

test('tree size and depth limits apply to additions and moves as well as imported trees', () => {
  const full = Array.from({ length: MAX_OUTLINE_ITEMS }, (_, index) => item(String(index)))
  assert.throws(() => apply(full, [{ type: 'outline-add', id: 'overflow', title: 'New', page: 1 }]), { code: 'invalid-operation' })
  assert.throws(() => apply([...full, item('overflow')], [{ type: 'outline-delete', id: '0' }]), { code: 'outline-read-only' })
  let nested = item('leaf')
  for (let depth = MAX_OUTLINE_DEPTH - 1; depth > 0; depth--) nested = item(String(depth), [nested])
  assert.throws(() => apply([nested], [{ type: 'outline-add', id: 'overflow', title: 'New', page: 1, parentId: 'leaf' }]),
    { code: 'invalid-operation' })
  assert.throws(() => apply([nested, item('branch', [item('branch-child')])],
    [{ type: 'outline-move', id: 'branch', parentId: 'leaf', index: 0 }]), { code: 'invalid-operation' })
  assert.throws(() => apply([item('too-deep', [nested])], [{ type: 'outline-delete', id: 'too-deep' }]),
    { code: 'outline-read-only' })
})

test('the RPC contract accepts only bounded, explicit outline mutations', () => {
  assert.deepEqual(outlineOperationSchema.parse({ type: 'outline-update', id: 'chapter', patch: { title: '  新名称  ' } }),
    { type: 'outline-update', id: 'chapter', patch: { title: '新名称' } })
  const operations: PdfOutlineOperation[] = [
    { type: 'outline-add', id: 'new', title: 'New', page: 1 },
    { type: 'outline-update', id: 'new', patch: { page: 2 } },
    { type: 'outline-move', id: 'new', index: 0 },
    { type: 'outline-delete', id: 'new' },
  ]
  for (const operation of operations) {
    assert.equal(isOutlineOperation(workingCopyOperationSchema.parse(operation)), true)
  }
  assert.equal(isOutlineOperation({ type: 'set-field', name: 'x', value: true }), false)
  for (const invalid of [
    { type: 'outline-update', id: 'a', patch: {} },
    { type: 'outline-update', id: 'a', patch: { url: 'https://example.com' } },
    { type: 'outline-add', id: 'a', title: '  ', page: 1 },
    { type: 'outline-add', id: 'a', title: 'Title', page: 0 },
    { type: 'outline-add', id: '\0', title: 'Title', page: 1 },
    { type: 'outline-move', id: 'a', index: -1 },
    { type: 'outline-move', id: 'a' },
    { type: 'outline-delete', id: 'a', deletePersonal: true },
  ]) assert.equal(workingCopyOperationSchema.safeParse(invalid).success, false)
})
