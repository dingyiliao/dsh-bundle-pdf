import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument, PDFName } from 'pdf-lib'
import { loadPdfDocument } from '../src/core/pdf-document.ts'
import { createPdfApi } from '../src/client/api.ts'
import { projectPdfOperations } from '../src/core/pdf-operation-projection.ts'
import type { NewPdfAnnotation, PdfAnnotationOperation, PdfDocumentInfo } from '../src/core/pdf-types.ts'
import { NavigationHistory, type NavigationPosition } from '../src/navigation/index.ts'

const timestamp = '2026-10-18T00:00:00.000Z'
const document = (): PdfDocumentInfo => ({ pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 100, 100],
  rotation: 0, userUnit: 1 }], annotations: [], signed: false, encrypted: false, readOnly: false })
const annotation = (): NewPdfAnnotation => ({ id: 'mark', page: 1, subtype: 'Highlight',
  rect: [10, 10, 50, 30], quadPoints: [10, 30, 50, 30, 10, 10, 50, 10], color: [1, 0.5, 0] })

test('projection rejects invalid identifiers, colors, quadrilaterals, and update fields atomically', () => {
  const base = document()
  const invalid = (operation: PdfAnnotationOperation) => {
    assert.throws(() => projectPdfOperations(base, [operation], timestamp),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid-operation')
    assert.deepEqual(base.annotations, [])
  }
  invalid({ type: 'add', annotation: { ...annotation(), id: '' } })
  invalid({ type: 'add', annotation: { ...annotation(), color: [Number.NaN, 0, 0] } })
  invalid({ type: 'add', annotation: { ...annotation(), quadPoints: [10, 30, 51, 30, 10, 10, 50, 10] } })
  const added = projectPdfOperations(base, [{ type: 'add', annotation: annotation() }], timestamp)
  assert.throws(() => projectPdfOperations(added,
    [{ type: 'update', id: 'mark', patch: { author: 'not editable' } } as unknown as PdfAnnotationOperation], timestamp),
  (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid-operation')
  assert.equal(added.annotations[0]?.author, undefined)
})

test('PDF document decodes CMYK annotation colors into bounded RGB', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([100, 100])
  const reference = pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Highlight', Rect: [10, 10, 50, 30],
    QuadPoints: [10, 30, 50, 30, 10, 10, 50, 10], C: [0, 0.25, 1, 0.2],
  }))
  page.node.set(PDFName.of('Annots'), pdf.context.obj([reference]))
  const loaded = await loadPdfDocument(await pdf.save({ useObjectStreams: false }))
  const color = loaded.annotations[0]?.color
  assert.ok(color)
  assert.ok(Math.abs(color[0] - 0.8) < 0.001)
  assert.ok(Math.abs(color[1] - 0.55) < 0.001)
  assert.equal(color[2], 0)
})

test('changing history capacity cancels a pending navigation before its viewport applies', async () => {
  const history = new NavigationHistory({ capacity: 5 })
  const from: NavigationPosition = { documentVersion: 'version-1', page: 1, x: 0, y: 0, scale: 1, fit: 'page' }
  const to: NavigationPosition = { ...from, page: 2 }
  let release!: () => void
  const entered = new Promise<void>(resolve => { release = resolve })
  let applying!: () => void
  const started = new Promise<void>(resolve => { applying = resolve })
  const jump = history.jump(to, { capture: () => from,
    apply: async () => { applying(); await entered; return to } })
  await started
  const before = history.snapshot().revision
  history.setCapacity(3)
  assert.equal(history.snapshot().revision, before + 1)
  release()
  assert.deepEqual(await jump, { status: 'cancelled' })
  assert.equal(history.size, 0)
})

test('client replays a lost mutation reply only once with its original identity', async () => {
  const calls: object[] = []
  const wire = { id: 'doc', path: '/document.pdf', sourceVersion: 'source', contentVersion: 'content',
    revision: 1, dirty: false, canUndo: false, canRedo: false, conflict: false,
    reader: { bytesHash: `sha256:${'a'.repeat(64)}`, generation: 1, protocolVersion: 1 },
    document: document() }
  const api = createPdfApi({ rpc: { async call(_path, _method, payload) {
    calls.push(payload)
    if (calls.length === 1) throw new Error('reply lost after commit')
    return { ok: true, value: wire }
  } } }, new AbortController().signal)
  assert.equal((await api.reload('session', 'doc', 0)).revision, 1)
  assert.equal(calls.length, 2)
  const [first, second] = calls as Array<{ mutationId: string }>
  assert.match(first.mutationId, /^[0-9a-f-]{36}$/)
  assert.equal(second.mutationId, first.mutationId, 'retry must not duplicate the mutation')
})
