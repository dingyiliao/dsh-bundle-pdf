import assert from 'node:assert/strict'
import test from 'node:test'
import { classicPdf } from '../../fixtures/plain-pdf.ts'
import { materializeFixturePdf, inspectFixturePdf } from '../../fixtures/native-document.ts'
import { projectPdfOperations } from '../../../src/modules/annotations/index.ts'
import type { NewPdfAnnotation, PdfAnnotation, PdfDocumentInfo, PdfAnnotationOperation } from '../../../src/core/pdf-types.ts'

const when = '2026-09-30T08:15:30.000Z'

const markup = '<< /Type /Annot /Subtype /Highlight /Rect [20 20 120 40] /QuadPoints [20 40 120 40 20 20 120 20]'

function fixture(): Uint8Array {
  return classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /MediaBox [0 0 300 400] >>',
    '<< /Type /Page /Parent 2 0 R /Annots [6 0 R 7 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /Annots [6 0 R 8 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /Annots [9 0 R] >>',
    `${markup} /C [1 1 0] /Contents (shared) /Popup 7 0 R >>`,
    '<< /Type /Annot /Subtype /Popup /Rect [130 20 230 70] /Parent 6 0 R >>',
    '<< /Type /Annot /Subtype /Text /Rect [30 100 50 120] /Contents (other) >>',
    '<< /Type /Annot /Subtype /Text /Rect [30 180 50 200] /Contents (last) >>',
  ])
}

function newText(id: string, page: number): NewPdfAnnotation {
  return { id, page, subtype: 'Text', rect: [60, 160, 80, 180], contents: id, color: [0, 0.5, 1] }
}

function visible(annotations: readonly PdfAnnotation[]) {
  return annotations.map(({ id, page, subtype, rect, quadPoints, color, commentPosition, contents, createdAt, modifiedAt, editable }) => ({
    id, page, subtype, rect, quadPoints, color: color?.map(Math.fround), commentPosition, contents, createdAt, modifiedAt, editable,
  }))
}

async function assertMatchesSaved(bytes: Uint8Array, baseline: PdfDocumentInfo, operations: PdfAnnotationOperation[]) {
  const projected = projectPdfOperations(baseline, operations, when)
  const saved = await materializeFixturePdf(bytes, operations, operations.map(() => when))
  assert.deepEqual(visible(projected.annotations), visible(saved.document.annotations))
  return projected
}

test('projection keeps page and annotation order when additions target different pages', async () => {
  const bytes = fixture()
  const baseline = await inspectFixturePdf(bytes)
  const operations: PdfAnnotationOperation[] = [
    { type: 'add', annotation: newText('new-third', 3) },
    { type: 'add', annotation: newText('new-first', 1) },
    { type: 'add', annotation: newText('new-second', 2) },
  ]
  const projected = await assertMatchesSaved(bytes, baseline, operations)
  assert.deepEqual(projected.annotations.map(({ page, id }) => [page, id]), [
    ...baseline.annotations.filter(item => item.page === 1).map(item => [1, item.id]),
    [1, 'new-first'],
    ...baseline.annotations.filter(item => item.page === 2).map(item => [2, item.id]),
    [2, 'new-second'],
    ...baseline.annotations.filter(item => item.page === 3).map(item => [3, item.id]),
    [3, 'new-third'],
  ])
})

test('editing either alias updates every reference to the same PDF dictionary', async () => {
  const bytes = fixture()
  const baseline = await inspectFixturePdf(bytes)
  const aliases = baseline.annotations.filter(item => item.sourceObjectId === baseline.annotations[0].sourceObjectId)
  assert.equal(aliases.length, 2)
  const projected = await assertMatchesSaved(bytes, baseline, [
    { type: 'update', id: aliases[1].id, patch: { contents: 'updated', color: [0, 1, 0] } },
  ])
  for (const id of aliases.map(item => item.id)) {
    const annotation = projected.annotations.find(item => item.id === id)
    assert.equal(annotation?.contents, 'updated')
    assert.deepEqual(annotation?.color, [0, 1, 0])
    assert.ok(annotation?.modifiedAt)
  }
  assert.equal(projected.annotations.find(item => item.contents === 'other')?.modifiedAt, undefined)
})

test('only standalone Text notes can be moved, and projection updates their PDF-space rectangle', async () => {
  const bytes = fixture()
  const baseline = await inspectFixturePdf(bytes)
  const note = baseline.annotations.find(item => item.contents === 'other')!
  const moved = await assertMatchesSaved(bytes, baseline, [
    { type: 'update', id: note.id, patch: { rect: [90, 120, 110, 140] } },
  ])
  const movedNote = moved.annotations.find(item => item.id === note.id)
  assert.deepEqual(movedNote?.rect, [90, 120, 110, 140])
  assert.equal(movedNote?.color, undefined)
  const mark = baseline.annotations.find(item => item.subtype === 'Highlight')!
  assert.throws(() => projectPdfOperations(baseline,
    [{ type: 'update', id: mark.id, patch: { rect: [90, 120, 110, 140] } }], when), /Only standalone notes/)
})

test('comment-card positions belong to root markups and project as PDF user-space points', async () => {
  const bytes = fixture()
  const baseline = await inspectFixturePdf(bytes)
  const mark = baseline.annotations.find(item => item.subtype === 'Highlight')!
  const position: [number, number] = [240, 310]
  const projected = await assertMatchesSaved(bytes, baseline, [
    { type: 'update', id: mark.id, patch: { commentPosition: position } },
  ])
  assert.deepEqual(projected.annotations.find(item => item.id === mark.id)?.commentPosition, position)
  const note = baseline.annotations.find(item => item.subtype === 'Text' && !item.replyToId)!
  assert.throws(() => projectPdfOperations(baseline,
    [{ type: 'update', id: note.id, patch: { commentPosition: position } }], when), /Only a root markup annotation/)
})

test('deleting an alias removes every reference and its associated popup', async () => {
  const bytes = fixture()
  const baseline = await inspectFixturePdf(bytes)
  const shared = baseline.annotations[0]
  const aliases = baseline.annotations.filter(item => item.sourceObjectId === shared.sourceObjectId)
  const popup = baseline.annotations.find(item => item.subtype === 'Popup')
  assert.equal(aliases.length, 2)
  assert.equal(shared.popupObjectId, popup?.sourceObjectId)
  const projected = await assertMatchesSaved(bytes, baseline, [{ type: 'delete', id: aliases[1].id }])
  assert.deepEqual(projected.annotations.map(item => item.contents), ['other', 'last'])
})

test('a rejected batch leaves the input intact and later operations use the updated index', async () => {
  const bytes = fixture()
  const baseline = await inspectFixturePdf(bytes)
  const original = structuredClone(baseline)
  const temporary = newText('temporary', 2)
  assert.throws(() => projectPdfOperations(baseline, [
    { type: 'add', annotation: temporary },
    { type: 'update', id: temporary.id, patch: { contents: 'edited' } },
    { type: 'delete', id: 'missing' },
  ], when), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'unknown-annotation')
  assert.deepEqual(baseline, original)
  const projected = await assertMatchesSaved(bytes, baseline, [
    { type: 'add', annotation: temporary },
    { type: 'update', id: temporary.id, patch: { contents: 'edited' } },
    { type: 'delete', id: temporary.id },
  ])
  assert.deepEqual(visible(projected.annotations), visible(baseline.annotations))
})

test('reply comments follow their parent and cannot leave an orphan', async () => {
  const bytes = fixture()
  const baseline = await inspectFixturePdf(bytes)
  const parent = baseline.annotations.find(item => item.subtype === 'Highlight')!
  const reply: NewPdfAnnotation = {
    id: 'thread-reply', page: parent.page, subtype: 'Text', rect: [60, 160, 80, 180],
    replyToId: parent.id, contents: 'An explanation', author: 'Reader',
  }
  const projected = projectPdfOperations(baseline, [{ type: 'add', annotation: reply }], when)
  const saved = await materializeFixturePdf(bytes, [{ type: 'add', annotation: reply }], [when])
  assert.equal(projected.annotations.find(item => item.id === reply.id)?.replyToId, parent.id)
  assert.equal(projected.annotations.find(item => item.id === reply.id)?.replyType, 'R')
  assert.deepEqual(
    visible(projected.annotations.filter(item => item.id === reply.id)),
    visible(saved.document.annotations.filter(item => item.id === reply.id)),
  )
  assert.equal(saved.document.annotations.find(item => item.id === reply.id)?.replyToId, parent.id)
  assert.throws(() => projectPdfOperations(projected, [
    { type: 'update', id: reply.id, patch: { color: [0, 1, 0] } },
  ], when), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid-operation')
  assert.throws(() => projectPdfOperations(projected, [{ type: 'delete', id: parent.id }], when),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'annotation-read-only')
  const deleted = projectPdfOperations(projected, [
    { type: 'delete', id: reply.id }, { type: 'delete', id: parent.id },
  ], [when, when])
  assert.equal(deleted.annotations.some(item => item.id === reply.id || item.sourceObjectId === parent.sourceObjectId), false)
  assert.throws(() => projectPdfOperations(baseline, [{ type: 'add', annotation: {
    ...reply, page: 2,
  } }], when), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid-operation')
  assert.throws(() => projectPdfOperations(baseline, [{ type: 'add', annotation: {
    ...reply, contents: '  ',
  } }], when), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid-operation')
})

test('reply projection uses the canonical parent alias for a duplicated PDF annotation', async () => {
  const bytes = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 300 400] >>',
    '<< /Type /Page /Parent 2 0 R /Annots [4 0 R 4 0 R] >>',
    `${markup} >>`,
  ])
  const baseline = await inspectFixturePdf(bytes)
  const aliases = baseline.annotations.filter(item => item.subtype === 'Highlight')
  assert.equal(aliases.length, 2)
  const operation: PdfAnnotationOperation = { type: 'add', annotation: {
    id: 'aliased-reply', page: 1, subtype: 'Text', rect: [50, 50, 60, 60],
    replyToId: aliases[1].id, contents: 'Reply to the same mark',
  } }
  const projected = projectPdfOperations(baseline, [operation], when)
  assert.equal(projected.annotations.find(item => item.id === 'aliased-reply')?.replyToId, aliases[0].id)
  const materialized = await materializeFixturePdf(bytes, [operation], [when])
  assert.equal(materialized.document.annotations.find(item => item.id === 'aliased-reply')?.replyToId, aliases[0].id)
})

test('editing imported rich-text Contents clears only its rich-text marker in the projected draft', async () => {
  const baseline = await inspectFixturePdf(fixture())
  const target = baseline.annotations.find(item => item.subtype === 'Text')!
  const richBaseline = { ...baseline, annotations: baseline.annotations.map(item =>
    item.id === target.id ? { ...item, hasRichText: true as const } : item) }
  const recolored = projectPdfOperations(richBaseline, [
    { type: 'update', id: target.id, patch: { color: [0, 1, 0] } },
  ], when)
  assert.equal(recolored.annotations.find(item => item.id === target.id)?.hasRichText, true)
  const edited = projectPdfOperations(richBaseline, [
    { type: 'update', id: target.id, patch: { contents: 'Plain text replacement' } },
  ], when)
  assert.equal(edited.annotations.find(item => item.id === target.id)?.hasRichText, undefined)
})
