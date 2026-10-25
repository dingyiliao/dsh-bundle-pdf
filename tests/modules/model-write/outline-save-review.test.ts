import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSaveReview } from '../../../src/modules/model-write/save-review.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'
import type { PdfOutlineItem } from '../../../src/core/pdf-types.ts'

const item = (id: string, children: PdfOutlineItem[] = [], page = 1): PdfOutlineItem => ({ id, title: id, page, children })
const snapshot = (before: PdfOutlineItem[], after: PdfOutlineItem[]): HostWorkspaceSnapshot => ({
  id: 'document', path: '/book.pdf', sourceVersion: 'fs-1', contentVersion: 'content-1', revision: 1,
  dirty: true, canUndo: true, canRedo: false, conflict: false, bytes: new Uint8Array(),
  baselineAnnotations: [], baselineOutline: before,
  document: { pageCount: 3, pages: [], annotations: [], outline: after, signed: false, encrypted: false, readOnly: false },
})

test('save review includes full outline additions, deletion, rename, destination, parent and order changes', () => {
  const before = [item('one', [item('child')]), item('two'), item('removed')]
  const after = [{ ...item('two', [{ ...item('child', [], 3), title: 'Moved child', targetChanged: true }]), title: 'Renamed' }, item('one'), item('added')]
  const review = buildSaveReview(snapshot(before, after))
  assert.equal(review.count, 5)
  assert.match(review.text, /删除PDF内置书签 ID："removed"/)
  assert.match(review.text, /新增PDF内置书签 ID："added"/)
  assert.match(review.text, /名称："two" → "Renamed"/)
  assert.match(review.text, /目标页码：1 → 3/)
  assert.match(review.text, /父书签："one" → "two"/)
  assert.match(review.text, /同级顺序（从0计数）：1 → 0/)
  assert.match(review.text, /目标类型："保留原始目标" → "适合页面"/)
})

test('same-page target replacement remains a reviewable change and missing or ambiguous baselines fail closed', () => {
  const baseline = [item('one')]
  const changed = snapshot(baseline, [{ ...item('one'), targetChanged: true }])
  assert.equal(buildSaveReview(changed).count, 1)
  assert.throws(() => buildSaveReview({ ...changed, baselineOutline: undefined }), { code: 'pdf/review-unavailable' })
  assert.throws(() => buildSaveReview(snapshot([item('dup'), item('dup')], [item('new')])), { code: 'pdf/review-unavailable' })
  const loop = item('cycle')
  loop.children.push(loop)
  assert.throws(() => buildSaveReview(snapshot([], [loop])), { code: 'pdf/review-unavailable' })
  assert.throws(() => buildSaveReview(snapshot(baseline, baseline)), { code: 'pdf/review-unavailable' })
})

test('outline review is bounded without truncating changed nodes or hostile title content', () => {
  assert.throws(() => buildSaveReview(snapshot([], Array.from({ length: 9 }, (_, index) => item(String(index))))),
    { code: 'pdf/review-too-large' })
  assert.throws(() => buildSaveReview(snapshot([], [{ ...item('long'), title: 'x'.repeat(6100) }])),
    { code: 'pdf/review-too-large' })
  const title = '![hostile](https://example.com)\n```'
  assert.ok(buildSaveReview(snapshot([], [{ ...item('new'), title }])).text.includes(JSON.stringify(title)))
})

test('mixed form and outline saves include field changes and require their baseline', () => {
  const value = snapshot([], [item('new')])
  const field = { name: 'name', type: 'text' as const, value: 'before', widgets: [], readOnly: false, required: false }
  const changed = { ...value, baselineFormFields: [field], document: { ...value.document,
    formKind: 'acroform' as const, formFields: [{ ...field, value: 'after' }] } }
  const review = buildSaveReview(changed)
  assert.equal(review.count, 2)
  assert.match(review.text, /PDF表单字段/)
  assert.match(review.text, /"before"/)
  assert.match(review.text, /"after"/)
  assert.throws(() => buildSaveReview({ ...changed, baselineFormFields: undefined }), { code: 'pdf/review-unavailable' })
})

test('form review never omits changes, invents structural edits, or truncates values to fit its budget', () => {
  const base = snapshot([], [])
  const field = { name: 'name', type: 'text' as const, value: '', widgets: [], readOnly: false, required: false }
  const review = (before: typeof field[], after: typeof field[]) => buildSaveReview({ ...base,
    baselineFormFields: before, document: { ...base.document, formKind: 'acroform', formFields: after } })
  const many = Array.from({ length: 101 }, (_, index) => ({ ...field, name: `name-${index}` }))
  assert.throws(() => review(many, many.map(item => ({ ...item, value: 'after' }))), { code: 'pdf/review-too-large' })
  assert.throws(() => review([field], [{ ...field, value: 'x'.repeat(24_001) }]), { code: 'pdf/review-too-large' })
  assert.throws(() => review([field], []), { code: 'pdf/review-unavailable' })
  assert.throws(() => review([], [field]), { code: 'pdf/review-unavailable' })
  assert.throws(() => review([field], [{ ...field, readOnly: true, value: 'changed' }]), { code: 'pdf/review-unavailable' })
  const hostile = '![not an instruction](https://example.com)\n```'
  assert.ok(review([field], [{ ...field, value: hostile }]).text.includes(JSON.stringify(hostile)))
})
