import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { applyNativeAnnotations, readNativeAnnotations } from '../../../src/adapters/host/pdfium/document-annotations.js'
import { decodeNativeReply, type NativeReply, type NativeRequest } from '../../../src/engine/protocol/commands.js'
import type { NativePayloadFor, NativePdfPort } from '../../../src/engine/host/native-port.js'
import type { PdfAnnotation, PdfDocumentInfo } from '../../../src/core/pdf-types.js'

type Row = NativeReply<'annotations'>['value']['annotations'][number]

const documentId = 'annotated-document'
const signal = new AbortController().signal
const noPayload = Buffer.alloc(0)
const row = (index: number, object: number, id: string, fields: Partial<Row> = {}): Row => ({
  index, object, id, subtype: 'Text', editable: true, flags: 0, ...fields,
})
const batch = (annotations: Row[], nextOffset: number | null = null): NativeReply<'annotations'>['value'] => ({ annotations, nextOffset })

function worker(respond: (request: NativeRequest) => unknown) {
  const execute = async <T extends NativeRequest>(request: T, bytes?: Uint8Array, active?: AbortSignal) => {
    assert.equal(bytes, undefined)
    assert.equal(active, signal)
    return decodeNativeReply(request, respond(request), noPayload)
  }
  return {
    listAnnotationPages: (payload: NativePayloadFor<'annotationPages'>, active?: AbortSignal) =>
      execute({ command: 'annotationPages', ...payload }, undefined, active),
    readAnnotations: (payload: NativePayloadFor<'annotations'>, active?: AbortSignal) =>
      execute({ command: 'annotations', ...payload }, undefined, active),
    editAnnotation: (payload: NativePayloadFor<'annotationEdit'>, active?: AbortSignal) =>
      execute({ command: 'annotationEdit', ...payload } as NativeRequest, undefined, active),
  } satisfies Pick<NativePdfPort, 'listAnnotationPages' | 'readAnnotations' | 'editAnnotation'>
}

test('native annotation inspection walks ordered sparse page batches and follows the native cursor', async () => {
  const requests: NativeRequest[] = []
  const input = worker(request => {
    requests.push(request)
    if (request.command === 'annotationPages') return { pageIndices: request.offset === 0 ? [0] : [2049] }
    assert.equal(request.command, 'annotations')
    if (request.pageIndex === 2049) return batch([row(0, 7, 'last')])
    return request.offset === 0 ? batch([row(2, 3, 'first')], 64) : batch([row(67, 4, 'next')])
  })
  const { annotations, positions } = await readNativeAnnotations(input, documentId, 2050, undefined, signal)
  assert.deepEqual(annotations.map(({ page, id }) => [page, id]), [[1, 'first'], [1, 'next'], [2050, 'last']])
  assert.deepEqual([...positions], [
    ['first', { pageIndex: 0, annotationIndex: 2 }],
    ['next', { pageIndex: 0, annotationIndex: 67 }],
    ['last', { pageIndex: 2049, annotationIndex: 0 }],
  ])
  assert.deepEqual(requests, [
    { command: 'annotationPages', documentId, offset: 0, limit: 2048 },
    { command: 'annotations', documentId, pageIndex: 0, offset: 0, limit: 64 },
    { command: 'annotations', documentId, pageIndex: 0, offset: 64, limit: 64 },
    { command: 'annotationPages', documentId, offset: 2048, limit: 2 },
    { command: 'annotations', documentId, pageIndex: 2049, offset: 0, limit: 64 },
  ])
})

test('native annotation inspection rejects unordered pages, invalid row positions and invalid cursors', async () => {
  const read = (pageIndices: number[], reply = batch([])) => readNativeAnnotations(
    worker(request => request.command === 'annotationPages' ? { pageIndices } : reply),
    documentId, 2, undefined, signal,
  )
  await assert.rejects(read([1, 0]), /Invalid native annotation page index/)
  await assert.rejects(read([2]), /Invalid native annotation page index/)
  for (const rows of [
    [row(0, 1, 'missing-object', { object: undefined })],
    [row(4, 1, 'first'), row(4, 2, 'duplicate-position')],
    [row(64, 1, 'outside-window')],
  ]) await assert.rejects(read([0], batch(rows)), /Invalid native annotation position/)
  await assert.rejects(read([0], batch([row(5, 1, 'one')], 5)), /Invalid native annotation cursor/)
  await assert.rejects(read([0], batch([], 65)), /Invalid native annotation cursor/)
})

test('native annotation inspection locks grouped and cross-page replies and breaks only cycle edges', async () => {
  const first = [
    row(0, 10, 'lead', { replyParent: 11, replyType: 1 }),
    row(1, 11, 'cycle-a', { replyParent: 12, replyType: 1 }),
    row(2, 12, 'cycle-b', { replyParent: 11, replyType: 1 }),
    row(3, 13, 'group-root'),
    row(4, 14, 'group-member', { replyParent: 13, replyType: 2 }),
    row(5, 15, 'cross-page-root'),
    row(6, 16, 'ordinary'),
  ]
  const second = [row(0, 17, 'cross-page-member', { replyParent: 15, replyType: 1 })]
  const input = worker(request => {
    if (request.command === 'annotationPages') return { pageIndices: [0, 1] }
    assert.equal(request.command, 'annotations')
    return batch(request.pageIndex === 0 ? first : second)
  })
  const { annotations } = await readNativeAnnotations(input, documentId, 2, undefined, signal)
  assert.deepEqual(annotations.map(({ id, replyType, replyToId, editable, readOnlyReason }) =>
    [id, replyType, replyToId, editable, readOnlyReason]), [
    ['lead', 'R', 'cycle-a', true, undefined],
    ['cycle-a', 'R', undefined, false, 'reply-chain'],
    ['cycle-b', 'R', undefined, false, 'reply-chain'],
    ['group-root', undefined, undefined, false, 'reply-chain'],
    ['group-member', 'Group', 'group-root', false, 'reply-chain'],
    ['cross-page-root', undefined, undefined, false, 'reply-chain'],
    ['ordinary', undefined, undefined, true, undefined],
    ['cross-page-member', 'R', undefined, false, 'reply-chain'],
  ])
})

test('native annotation writes refuse an orphaned or cross-page reply before issuing an add', async () => {
  const input = worker(request => {
    if (request.command === 'annotationPages') return { pageIndices: [0] }
    assert.equal(request.command, 'annotations', 'the invalid reply must never reach the native writer')
    return batch([row(0, 1, 'parent')])
  })
  const baseline = await readNativeAnnotations(input, documentId, 2, undefined, signal)
  const document: PdfDocumentInfo = {
    pageCount: 2, pages: [], annotations: baseline.annotations, encrypted: false, signed: false, readOnly: false,
  }
  const draft: PdfAnnotation = {
    id: 'new-reply', sourceObjectId: 'dsh-new:new-reply', subtype: 'Text', page: 1,
    rect: [10, 10, 20, 20], flags: 0, editable: true, supported: true,
  }
  for (const reply of [{ ...draft, replyToId: 'missing' }, { ...draft, page: 2, replyToId: 'parent' }]) {
    await assert.rejects(applyNativeAnnotations(input, documentId, baseline,
      { ...document, annotations: [...document.annotations, reply] }, signal),
    { code: 'invalid-operation', message: /parent no longer exists on the page/ })
  }
})
