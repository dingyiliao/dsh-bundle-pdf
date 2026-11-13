import type { PdfAnnotation, PdfDocumentInfo } from '../../../core/pdf-types.js'
import { readNativeSavedBytes } from './save-bytes.js'
import type { NativePdfPort } from '../../../engine/host/native-port.js'

const maxAnnotations = 20_000
const annotationBatchSize = 64
const nativeIdentity = 'protected-annot:'
type AnnotationWorker = Pick<NativePdfPort, 'readAnnotations' | 'editAnnotation' | 'materializeCopy' | 'readMaterializedChunk'>

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

/** Native positions bind mutable annotations to the encrypted source bytes, never to a Client-supplied ID. */
export async function readEncryptedAnnotations(worker: AnnotationWorker, documentId: string, pageCount: number,
  editable: boolean, signal: AbortSignal): Promise<PdfAnnotation[] | undefined> {
  const result: PdfAnnotation[] = []
  const claimed = new Set<string>()
  for (let page = 1; page <= pageCount; page++) {
    let offset = 0
    for (;;) {
      const reply = await worker.readAnnotations({ documentId, pageIndex: page - 1,
        offset, limit: annotationBatchSize }, signal)
      const { annotations, nextOffset } = reply.value
      let previous = offset - 1
      for (const { index, id, editable: supportedEdit, replyType: _replyType, ...annotation } of annotations) {
        if (index <= previous || index >= offset + annotationBatchSize) {
          fail('pdf/native-protocol', 'Invalid protected annotation order')
        }
        previous = index
        if (result.length === maxAnnotations) return undefined
        const sourceObjectId = nativeIdentity + page + ':' + index
        const preferredId = id && !id.includes('\0') && !id.startsWith(nativeIdentity) && !claimed.has(id) ? id : sourceObjectId
        claimed.add(preferredId)
        result.push({ ...annotation, id: preferredId, sourceObjectId, page,
          supported: true, editable: editable && supportedEdit,
          ...(!supportedEdit || !editable ? { readOnlyReason: 'encrypted-document' } : {}) })
      }
      if (nextOffset === null) break
      if (nextOffset <= Math.max(previous, offset) || nextOffset > offset + annotationBatchSize) {
        fail('pdf/native-protocol', 'Invalid protected annotation cursor')
      }
      offset = nextOffset
    }
  }
  return result
}

function sourcePosition(annotation: PdfAnnotation): { pageIndex: number; annotationIndex: number } {
  const parts = /^protected-annot:(\d+):(\d+)$/.exec(annotation.sourceObjectId ?? '')
  if (!parts || Number(parts[1]) !== annotation.page) {
    fail('pdf/native-protocol', 'Protected annotation has no valid source position')
  }
  return { pageIndex: annotation.page - 1, annotationIndex: Number(parts[2]) }
}

type UpdatePatch = Pick<PdfAnnotation, 'contents' | 'color' | 'rect' | 'modifiedAt'>
function updatePatch(before: PdfAnnotation, after: PdfAnnotation): UpdatePatch {
  const patch: UpdatePatch = {}
  for (const key of ['contents', 'color', 'rect'] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) Object.assign(patch, { [key]: after[key] })
  }
  if (Object.keys(patch).length && after.modifiedAt !== undefined) patch.modifiedAt = after.modifiedAt
  return patch
}

/** Apply the active projection to a fresh native handle. Delete in descending index order. */
export async function saveEncryptedAnnotations(worker: AnnotationWorker, documentId: string, baseline: PdfDocumentInfo,
  edited: PdfDocumentInfo, signal: AbortSignal): Promise<Uint8Array> {
  const before = new Map(baseline.annotations.map(annotation => [annotation.id, annotation]))
  const after = new Map(edited.annotations.map(annotation => [annotation.id, annotation]))
  if (after.size > maxAnnotations) fail('pdf/native-size', 'The protected PDF has too many annotations to save')
  const removals: Array<ReturnType<typeof sourcePosition>> = []
  for (const annotation of baseline.annotations) {
    const next = after.get(annotation.id)
    const patch = next && next.sourceObjectId === annotation.sourceObjectId ? updatePatch(annotation, next) : undefined
    if (patch && !Object.keys(patch).length) continue
    if (!annotation.editable) fail('pdf/annotation-read-only', 'A protected annotation cannot be edited')
    const position = sourcePosition(annotation)
    if (!patch) removals.push(position)
    else await worker.editAnnotation({ action: 'update', documentId, ...position, patch }, signal)
  }
  for (const position of removals.sort((a, b) => a.pageIndex - b.pageIndex || b.annotationIndex - a.annotationIndex)) {
    await worker.editAnnotation({ action: 'delete', documentId, ...position }, signal)
  }
  for (const annotation of edited.annotations) {
    if (before.get(annotation.id)?.sourceObjectId === annotation.sourceObjectId) continue
    const { id, subtype, rect, quadPoints, color, contents, author, createdAt, modifiedAt, opacity } = annotation
    await worker.editAnnotation({ action: 'add', documentId, pageIndex: annotation.page - 1,
      annotation: { id, subtype, rect, quadPoints, color, contents, author, createdAt, modifiedAt, opacity } }, signal)
  }

  return readNativeSavedBytes(worker, documentId, signal)
}

function similar(left: readonly number[] | undefined, right: readonly number[] | undefined, tolerance: number): boolean {
  return left === right || !!left && !!right && left.length === right.length
    && left.every((value, index) => Math.abs(value - right[index]) <= Math.max(tolerance, Math.abs(value) * 0.000001))
}

/** Reopened page order resolves imported annotations whose physical index changed after a delete. */
export function verifyEncryptedSave(edited: PdfDocumentInfo, saved: PdfDocumentInfo): void {
  const changedGeometry = edited.pages.length !== saved.pages.length || edited.pages.some((page, index) => {
    const actual = saved.pages[index]
    return actual.page !== page.page || actual.rotation !== page.rotation
      || Math.abs(page.userUnit - actual.userUnit) > Math.max(0.000001, page.userUnit * 0.000001)
      || !similar(page.cropBox, actual.cropBox, 0.001)
  })
  if (changedGeometry || edited.formKind !== saved.formKind) {
    fail('pdf/protected-save-verification', 'The saved PDF did not preserve its expected page geometry')
  }
  const expected = edited.annotations
  if (expected.length !== saved.annotations.length) fail('pdf/protected-save-verification', 'Saved PDF annotation count changed')
  for (const [index, annotation] of expected.entries()) {
    const actual = saved.annotations[index]
    if (actual.page !== annotation.page || actual.subtype !== annotation.subtype || actual.flags !== annotation.flags
      || !annotation.id.startsWith(nativeIdentity) && actual.id !== annotation.id
      || (actual.contents ?? '') !== (annotation.contents ?? '')
      || (actual.author ?? '') !== (annotation.author ?? '')
      || Math.abs((annotation.opacity ?? 1) - (actual.opacity ?? 1)) > 1 / 255
      || !similar(annotation.rect, actual.rect, 0.001)
      || !similar(annotation.quadPoints, actual.quadPoints, 0.001)
      || !similar(annotation.color, actual.color, 1 / 255)) {
      fail('pdf/protected-save-verification', 'The saved PDF did not preserve its expected annotations')
    }
  }
}
