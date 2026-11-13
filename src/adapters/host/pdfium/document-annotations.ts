import { PdfDocumentError, type PdfAnnotation, type PdfDocumentInfo } from '../../../core/pdf-types.js'
import type { NativePdfPort } from '../../../engine/host/native-port.js'

type Worker = Pick<NativePdfPort, 'listAnnotationPages' | 'readAnnotations' | 'editAnnotation'>
type Row = Awaited<ReturnType<typeof readRows>>[number]
const writableTypes = new Set(['Text', 'Highlight', 'Underline', 'StrikeOut'])

async function readRows(worker: Worker, documentId: string, pageCount: number, signal: AbortSignal) {
  const rows = []
  for (let start = 0; start < pageCount; start += 2048) {
    const limit = Math.min(2048, pageCount - start)
    const { value: { pageIndices } } = await worker.listAnnotationPages({ documentId, offset: start, limit }, signal)
    let previousPage = start - 1
    for (const pageIndex of pageIndices) {
      if (pageIndex <= previousPage || pageIndex >= start + limit) throw new Error('Invalid native annotation page index')
      previousPage = pageIndex
      for (let offset = 0; ;) {
        const { value: { annotations, nextOffset } } = await worker.readAnnotations({
          documentId, pageIndex, offset, limit: 64,
        }, signal)
        let previous = offset - 1
        for (const row of annotations) {
          if (row.object === undefined || row.index <= previous || row.index >= offset + 64) {
            throw new Error('Invalid native annotation position')
          }
          previous = row.index
          rows.push({ ...row, page: pageIndex + 1 })
          if (rows.length > 100_000) throw new Error('Native annotation metadata exceeds its budget')
        }
        if (nextOffset === null) break
        if (nextOffset <= Math.max(offset, previous) || nextOffset > offset + 64) {
          throw new Error('Invalid native annotation cursor')
        }
        offset = nextOffset
      }
    }
  }
  return rows
}

function lock(annotation: PdfAnnotation, reason: string) {
  if (!annotation.editable) return
  annotation.editable = false
  annotation.readOnlyReason = reason
}

function resolveReplies(rows: readonly Row[], annotations: PdfAnnotation[]) {
  const byObject = new Map<number, PdfAnnotation[]>()
  for (const [index, row] of rows.entries()) {
    const aliases = byObject.get(row.object!) ?? []
    aliases.push(annotations[index])
    byObject.set(row.object!, aliases)
  }
  for (const [index, row] of rows.entries()) {
    const annotation = annotations[index]
    if (annotation.subtype === 'Popup' || row.replyType === undefined) continue
    const parents = row.replyParent === undefined ? [] : byObject.get(row.replyParent) ?? []
    const parent = parents.find(candidate => candidate.page === annotation.page && candidate.subtype !== 'Popup')
    if (parent && row.replyParent !== row.object) annotation.replyToId = parent.id
    if (row.replyType !== -1) annotation.replyType = row.replyType === 1 ? 'R' : 'Group'
    if (row.replyType !== 1 || annotation.subtype !== 'Text' || !annotation.replyToId) lock(annotation, 'reply-chain')
    if (!parent || row.replyType === 2) for (const alias of parents) lock(alias, 'reply-chain')
  }
  const byId = new Map(annotations.map(annotation => [annotation.id, annotation]))
  const visited = new Set<string>()
  for (const annotation of annotations) {
    const chain = new Map<string, PdfAnnotation>()
    let next: PdfAnnotation | undefined = annotation
    while (next?.replyToId && !visited.has(next.id) && !chain.has(next.id)) {
      chain.set(next.id, next)
      next = byId.get(next.replyToId)
    }
    if (next && chain.has(next.id)) {
      let inCycle = false
      for (const entry of chain.values()) {
        inCycle ||= entry === next
        if (inCycle) { lock(entry, 'reply-chain'); delete entry.replyToId }
      }
    }
    for (const id of chain.keys()) visited.add(id)
  }
}

export async function readNativeAnnotations(worker: Worker, documentId: string, pageCount: number,
  readOnlyReason: string | undefined, signal: AbortSignal) {
  const rows = await readRows(worker, documentId, pageCount, signal)
  const claimed = new Set<string>()
  const unpersistedDirect = new Set<string>()
  const positions = new Map<string, { pageIndex: number; annotationIndex: number }>()
  const annotations: PdfAnnotation[] = rows.map(row => {
    const { index, id: savedId, object, referenceId, replyParent: _parent, replyType: _type,
      popup, editable, ...data } = row
    const physical = referenceId ?? `direct:${row.page}:${index}`
    const candidate = savedId || physical
    let id = claimed.has(candidate) ? `${candidate}@${physical}:${index}` : candidate
    while (claimed.has(id)) id += '@'
    claimed.add(id)
    positions.set(id, { pageIndex: row.page - 1, annotationIndex: index })
    if (!referenceId && !savedId) unpersistedDirect.add(id)
    const supported = writableTypes.has(row.subtype)
    const reason = readOnlyReason ?? (editable ? undefined : !supported ? 'unsupported-annotation-type'
      : row.flags & (64 | 128 | 512) ? 'annotation-locked' : 'invalid-annotation-geometry')
    return { ...data, id, sourceObjectId: `pdf-existing:${object}`,
      ...(popup === undefined ? {} : { popupObjectId: `pdf-existing:${popup}` }),
      supported, editable: !reason, readOnlyReason: reason }
  })
  resolveReplies(rows, annotations)
  return { annotations, positions, unpersistedDirect }
}

export async function applyNativeAnnotations(worker: Worker, documentId: string,
  before: Awaited<ReturnType<typeof readNativeAnnotations>>, projected: PdfDocumentInfo, signal: AbortSignal) {
  const final = new Map(projected.annotations.map(annotation => [annotation.id, annotation]))
  const initial = new Map(before.annotations.map(annotation => [annotation.id, annotation]))
  const positions = new Map(before.positions)
  const removed: { pageIndex: number; annotationIndex: number; associatedPopup?: true }[] = []
  const changed = new Set<string>()
  for (const annotation of before.annotations) {
    const next = final.get(annotation.id)
    const position = positions.get(annotation.id)!
    if (!next || next.sourceObjectId !== annotation.sourceObjectId) {
      removed.push({ ...position, ...(annotation.subtype === 'Popup' ? { associatedPopup: true } : {}) })
      positions.delete(annotation.id)
      continue
    }
    const identity = annotation.sourceObjectId ?? annotation.id
    if (changed.has(identity)) continue
    const patch = Object.fromEntries((['contents', 'color', 'rect', 'commentPosition', 'modifiedAt'] as const)
      .filter(key => JSON.stringify(annotation[key]) !== JSON.stringify(next[key])).map(key => [key, next[key]]))
    // A direct dictionary can move to another array slot or become an indirect
    // object when it gets a reply. Persist its previous working-copy identity.
    if (annotation.editable && before.unpersistedDirect.has(annotation.id)) patch.id = annotation.id
    if (!Object.keys(patch).length) continue
    changed.add(identity)
    await worker.editAnnotation({ action: 'update', documentId, ...position, patch }, signal)
  }
  // Append replies while baseline positions are still valid. Remove old
  // annotations after all additions have been linked to their source parent.
  for (const annotation of projected.annotations) {
    if (initial.get(annotation.id)?.sourceObjectId === annotation.sourceObjectId) continue
    const { id, subtype, rect, quadPoints, color, contents, author, createdAt, modifiedAt, opacity, commentPosition } = annotation
    const pageIndex = annotation.page - 1
    const parent = annotation.replyToId ? positions.get(annotation.replyToId) : undefined
    if (annotation.replyToId && parent?.pageIndex !== pageIndex) {
      throw new PdfDocumentError('invalid-operation', 'Annotation reply parent no longer exists on the page.')
    }
    const { value: { index } } = await worker.editAnnotation({ action: 'add', documentId, pageIndex,
      annotation: { id, subtype, rect, quadPoints, color, contents, author, createdAt, modifiedAt, opacity, commentPosition,
        ...(parent ? { replyParentIndex: parent.annotationIndex } : {}) },
    }, signal)
    if (index === undefined) throw new Error('Native annotation write did not return its position')
    positions.set(id, { pageIndex, annotationIndex: index })
  }
  for (const position of removed.sort((a, b) => a.pageIndex - b.pageIndex || b.annotationIndex - a.annotationIndex)) {
    await worker.editAnnotation({ action: 'delete', documentId, ...position }, signal)
  }
}
