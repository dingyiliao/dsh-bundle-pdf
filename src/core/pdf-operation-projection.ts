import { PDFString } from 'pdf-lib'
import { measurePdfSync } from '../shared/performance.js'
import {
  PdfDocumentError,
  type NewPdfAnnotation, type PdfAnnotation, type PdfAnnotationOperation,
  type PdfColor, type PdfDocumentInfo, type PdfRect,
} from './pdf-types.js'

const editableTypes = new Set(['Highlight', 'Underline', 'StrikeOut', 'Text'])
const defaultColor: PdfColor = [1, 0.85, 0]

function invalid(message: string): never { throw new PdfDocumentError('invalid-operation', message) }

function validRect(value: unknown): value is PdfRect {
  return Array.isArray(value) && value.length === 4
    && value.every(item => typeof item === 'number' && Number.isFinite(item))
    && value[2] > value[0] && value[3] > value[1]
}

function validQuads(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length % 8 === 0
    && value.every(item => typeof item === 'number' && Number.isFinite(item))
}

function validateColor(value: unknown): asserts value is PdfColor {
  if (!Array.isArray(value) || value.length !== 3
    || value.some(item => typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1)) {
    invalid('Annotation color must contain three numbers between zero and one.')
  }
}

function validateNew(annotation: NewPdfAnnotation, pageCount: number) {
  if (!annotation || typeof annotation.id !== 'string' || !annotation.id.trim() || annotation.id.length > 200) {
    invalid('An annotation requires a unique ID.')
  }
  if (!Number.isInteger(annotation.page) || annotation.page < 1 || annotation.page > pageCount) invalid('Annotation page is outside this document.')
  if (!editableTypes.has(annotation.subtype)) invalid('Unsupported annotation type.')
  if (!validRect(annotation.rect)) invalid('Annotation rectangle must have a positive width and height.')
  if (annotation.subtype !== 'Text' && !validQuads(annotation.quadPoints)) invalid('Text markup requires quadrilateral coordinates.')
  if (annotation.quadPoints !== undefined) {
    if (!validQuads(annotation.quadPoints)) invalid('Invalid quadrilateral coordinates.')
    const [left, bottom, right, top] = annotation.rect
    annotation.quadPoints.forEach((n, index) => {
      if (n < (index % 2 ? bottom : left) - 0.01 || n > (index % 2 ? top : right) + 0.01) {
        invalid('Quadrilateral extends outside the annotation rectangle.')
      }
    })
    for (let index = 0; index < annotation.quadPoints.length; index += 8) {
      const q = annotation.quadPoints.slice(index, index + 8)
      const area = Math.abs((q[2] - q[0]) * (q[5] - q[1]) - (q[3] - q[1]) * (q[4] - q[0]))
      if (area < 0.000001) invalid('Annotation quadrilaterals must have a positive area.')
    }
  }
  if (annotation.color !== undefined) validateColor(annotation.color)
  if (annotation.contents !== undefined && typeof annotation.contents !== 'string') invalid('Annotation contents must be text.')
  if (annotation.author !== undefined && typeof annotation.author !== 'string') invalid('Annotation author must be text.')
}

/** Project an atomic batch onto annotation metadata without reading or rewriting PDF bytes. */
export function projectPdfOperations(
  document: PdfDocumentInfo,
  operations: readonly PdfAnnotationOperation[],
  operationDates: string | readonly string[],
): PdfDocumentInfo {
  return measurePdfSync('host.project', { pageCount: document.pageCount,
    annotationCount: document.annotations.length, operationCount: Array.isArray(operations) ? operations.length : 0 },
  () => projectPdfOperationsImpl(document, operations, operationDates))
}

function projectPdfOperationsImpl(
  document: PdfDocumentInfo,
  operations: readonly PdfAnnotationOperation[],
  operationDates: string | readonly string[],
): PdfDocumentInfo {
  if (document.readOnly) throw new PdfDocumentError('read-only', document.readOnlyReason ?? 'This PDF is read-only.')
  if (!Array.isArray(operations)) invalid('An annotation operation list is required.')
  const dates = typeof operationDates === 'string' ? undefined : operationDates
  if (dates && dates.length !== operations.length) invalid('Operation dates do not match the operation list.')
  const entries = new Map(document.annotations.map(item => [item.id, item]))
  const byObject = new Map<string, Set<string>>()
  const objectId = (item: PdfAnnotation) => item.sourceObjectId ?? item.id
  const indexAnnotation = (item: PdfAnnotation) => {
    const key = objectId(item)
    let ids = byObject.get(key)
    if (!ids) { ids = new Set(); byObject.set(key, ids) }
    ids.add(item.id)
  }
  for (const item of document.annotations) indexAnnotation(item)
  const removeObject = (key: string, popupOnly = false) => {
    const ids = byObject.get(key)
    if (!ids) return
    for (const id of ids) {
      const item = entries.get(id)
      if (!item || (popupOnly && item.subtype !== 'Popup')) continue
      entries.delete(id)
      ids.delete(id)
    }
    if (!ids.size) byObject.delete(key)
  }
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]
    const dateText = typeof operationDates === 'string' ? operationDates : operationDates[index]
    const instant = new Date(dateText)
    if (!Number.isFinite(instant.getTime())) invalid('An operation has an invalid date.')
    const pdfDate = PDFString.fromDate(instant).decodeText()
    if (!operation || !['add', 'update', 'delete'].includes(operation.type)) invalid('Unsupported annotation operation.')
    if (operation.type === 'add') {
      validateNew(operation.annotation, document.pageCount)
      if (entries.has(operation.annotation.id)) invalid('Annotation ID already exists.')
      const annotation: PdfAnnotation = {
        ...operation.annotation,
        rect: [...operation.annotation.rect],
        quadPoints: operation.annotation.quadPoints?.slice(),
        color: operation.annotation.color ? [...operation.annotation.color] : [...defaultColor],
        flags: 4, supported: true, editable: true,
        createdAt: pdfDate, modifiedAt: pdfDate,
        sourceObjectId: `dsh-new:${operation.annotation.id}`,
      }
      entries.set(annotation.id, annotation)
      indexAnnotation(annotation)
      continue
    }
    const existing = entries.get(operation.id)
    if (!existing) throw new PdfDocumentError('unknown-annotation', `Annotation not found: ${operation.id}`)
    if (!existing.editable) throw new PdfDocumentError('annotation-read-only', `Annotation cannot be edited: ${existing.readOnlyReason}`)
    if (operation.type === 'delete') {
      removeObject(objectId(existing))
      if (existing.popupObjectId) removeObject(existing.popupObjectId, true)
      continue
    }
    const patch = operation.patch
    if (!patch || Object.keys(patch).some(key => key !== 'contents' && key !== 'color')) {
      invalid('Only annotation color and contents can be changed.')
    }
    if (patch.contents !== undefined && typeof patch.contents !== 'string') invalid('Annotation contents must be text.')
    if (patch.color !== undefined) validateColor(patch.color)
    for (const id of byObject.get(objectId(existing)) ?? []) {
      const item = entries.get(id)
      if (!item) continue
      entries.set(id, {
        ...item,
        ...(patch.contents !== undefined ? { contents: patch.contents } : {}),
        ...(patch.color !== undefined ? { color: [...patch.color] as PdfColor } : {}),
        modifiedAt: pdfDate,
      })
    }
  }
  // Page buckets retain each page's annotation-array order while placing new
  // annotations after existing ones, without sorting the entire annotation set.
  const pages = new Array<PdfAnnotation[]>(document.pageCount)
  for (const item of entries.values()) (pages[item.page - 1] ??= []).push(item)
  return { ...document, annotations: pages.flatMap(page => page ?? []) }
}
