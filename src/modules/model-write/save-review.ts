import type { PdfAnnotation, PdfFormField, PdfOutlineItem } from '../../core/pdf-types.js'
import { MAX_OUTLINE_DEPTH, MAX_OUTLINE_ITEMS } from '../outlines/index.js'
import { formFieldId } from '../forms/index.js'
import type { HostWorkspaceSnapshot } from '../working-copy/index.js'

const MAX_REVIEW_ITEMS = 8
const MAX_REVIEW_CHARS = 6000
const MAX_FORM_REVIEW_ITEMS = 100
const MAX_FORM_REVIEW_CHARS = 24_000

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

type ReviewFields = Pick<PdfAnnotation, 'page' | 'subtype' | 'rect' | 'quadPoints' | 'color'
  | 'commentPosition'
  | 'opacity' | 'contents' | 'author' | 'createdAt' | 'modifiedAt' | 'flags'
  | 'supported' | 'editable' | 'readOnlyReason' | 'sourceObjectId' | 'popupObjectId' | 'linkAction'
  | 'replyToId' | 'replyType' | 'hasRichText'>

function fields(annotation: PdfAnnotation): ReviewFields {
  const { page, subtype, rect, quadPoints, color, commentPosition, opacity, contents, author, createdAt, modifiedAt,
    flags, supported, editable, readOnlyReason, sourceObjectId, popupObjectId, linkAction, replyToId, replyType,
    hasRichText } = annotation
  return { page, subtype, rect, quadPoints, color, commentPosition, opacity, contents, author, createdAt, modifiedAt,
    flags, supported, editable, readOnlyReason, sourceObjectId, popupObjectId, linkAction, replyToId, replyType,
    hasRichText }
}

function indexed(annotations: readonly PdfAnnotation[]): Map<string, PdfAnnotation> {
  const result = new Map<string, PdfAnnotation>()
  for (const annotation of annotations) {
    if (result.has(annotation.id)) fail('pdf/review-unavailable', 'Duplicate PDF annotation IDs prevent a safe save review; save in the PDF Reader UI')
    result.set(annotation.id, annotation)
  }
  return result
}

function value(value: unknown): string { return value === undefined ? '∅' : JSON.stringify(value) }

function describe(index: number, id: string, before?: PdfAnnotation, after?: PdfAnnotation): string {
  const change = before && after ? '修改' : before ? '删除' : '新增'
  const previous = before && fields(before), next = after && fields(after)
  const pair = (label: string, oldValue: unknown, newValue: unknown) =>
    `${label}：${value(oldValue)} → ${value(newValue)}`
  return [
    `${index}. ${change}批注 ID：${JSON.stringify(id)}`,
    pair('页码', previous?.page, next?.page),
    pair('类型', previous?.subtype, next?.subtype),
    pair('区域', previous && { rect: previous.rect, quadPoints: previous.quadPoints },
      next && { rect: next.rect, quadPoints: next.quadPoints }),
    ...(JSON.stringify(previous?.commentPosition) !== JSON.stringify(next?.commentPosition)
      ? [pair('评论框位置', previous?.commentPosition, next?.commentPosition)] : []),
    pair('颜色', previous?.color, next?.color),
    pair('评论', previous?.contents, next?.contents),
    pair('作者', previous?.author, next?.author),
    pair('不透明度', previous?.opacity, next?.opacity),
    pair('其它元数据', previous && {
      createdAt: previous.createdAt, modifiedAt: previous.modifiedAt, flags: previous.flags,
      supported: previous.supported, editable: previous.editable, readOnlyReason: previous.readOnlyReason,
      sourceObjectId: previous.sourceObjectId, popupObjectId: previous.popupObjectId,
      replyToId: previous.replyToId, replyType: previous.replyType, hasRichText: previous.hasRichText,
      linkAction: previous.linkAction,
    }, next && {
      createdAt: next.createdAt, modifiedAt: next.modifiedAt, flags: next.flags,
      supported: next.supported, editable: next.editable, readOnlyReason: next.readOnlyReason,
      sourceObjectId: next.sourceObjectId, popupObjectId: next.popupObjectId,
      replyToId: next.replyToId, replyType: next.replyType, hasRichText: next.hasRichText,
      linkAction: next.linkAction,
    }),
  ].join('\n')
}

interface OutlineReviewItem {
  title: string
  page?: number
  parentId?: string
  index: number
  targetChanged: boolean
}

function outlineIndex(items: readonly PdfOutlineItem[]): Map<string, OutlineReviewItem> {
  const result = new Map<string, OutlineReviewItem>()
  const objects = new Set<PdfOutlineItem>()
  const pending = items.map((item, index) => ({ item, index, parentId: undefined as string | undefined, depth: 1 })).reverse()
  while (pending.length) {
    const { item, index, parentId, depth } = pending.pop()!
    if (!item || objects.has(item) || result.has(item.id) || !item.id || !Array.isArray(item.children)
      || depth > MAX_OUTLINE_DEPTH || result.size >= MAX_OUTLINE_ITEMS) {
      fail('pdf/review-unavailable', 'PDF bookmark identities or hierarchy cannot be safely reviewed; save in the PDF Reader UI')
    }
    objects.add(item)
    result.set(item.id, { title: item.title, page: item.page, parentId, index, targetChanged: item.targetChanged === true })
    for (let child = item.children.length - 1; child >= 0; child--) {
      pending.push({ item: item.children[child]!, index: child, parentId: item.id, depth: depth + 1 })
    }
  }
  return result
}

function describeOutline(index: number, id: string, before?: OutlineReviewItem, after?: OutlineReviewItem): string {
  const change = before && after ? '修改' : before ? '删除' : '新增'
  const pair = (label: string, oldValue: unknown, newValue: unknown) => `${label}：${value(oldValue)} → ${value(newValue)}`
  return [
    `${index}. ${change}PDF内置书签 ID：${JSON.stringify(id)}`,
    pair('名称', before?.title, after?.title),
    pair('目标页码', before?.page, after?.page),
    pair('父书签', before ? before.parentId ?? '根目录' : undefined, after ? after.parentId ?? '根目录' : undefined),
    pair('同级顺序（从0计数）', before?.index, after?.index),
    pair('目标类型', before ? '保留原始目标' : undefined,
      after ? !before || after.targetChanged ? '适合页面' : '保留原始目标' : undefined),
  ].join('\n')
}

function formIndex(items: readonly PdfFormField[]): Map<string, PdfFormField> {
  const result = new Map<string, PdfFormField>()
  for (const item of items) {
    const id = formFieldId(item)
    if (result.has(id)) fail('pdf/review-unavailable', 'Duplicate PDF form identities prevent a safe save review; save in the PDF Reader UI')
    result.set(id, item)
  }
  return result
}

/** The entire final save delta, never a truncated selection of draft operations. */
export function buildSaveReview(snapshot: HostWorkspaceSnapshot): { text: string; count: number } {
  if (!snapshot.baselineAnnotations) fail('pdf/review-unavailable', 'PDF baseline is unavailable; save in the PDF Reader UI')
  const before = indexed(snapshot.baselineAnnotations), after = indexed(snapshot.document.annotations)
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort()
  const lines: string[] = []
  const append = (text: string) => {
    if (lines.length >= MAX_REVIEW_ITEMS) fail('pdf/review-too-large', 'Too many PDF changes to review here; save manually in the PDF Reader UI')
    lines.push(text)
    if (lines.join('\n\n').length > MAX_REVIEW_CHARS) {
      fail('pdf/review-too-large', 'PDF review text is too long; save manually in the PDF Reader UI')
    }
  }
  for (const id of ids) {
    const oldValue = before.get(id), newValue = after.get(id)
    if (oldValue && newValue && JSON.stringify(fields(oldValue)) === JSON.stringify(fields(newValue))) continue
    append(describe(lines.length + 1, id, oldValue, newValue))
  }
  if (snapshot.baselineOutline !== undefined || snapshot.document.outline !== undefined) {
    if (snapshot.baselineOutline === undefined || snapshot.document.outline === undefined) {
      fail('pdf/review-unavailable', 'PDF bookmark baseline is unavailable; save in the PDF Reader UI')
    }
    const oldOutlines = outlineIndex(snapshot.baselineOutline), newOutlines = outlineIndex(snapshot.document.outline)
    for (const id of [...new Set([...oldOutlines.keys(), ...newOutlines.keys()])].sort()) {
      const oldValue = oldOutlines.get(id), newValue = newOutlines.get(id)
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue
      append(describeOutline(lines.length + 1, id, oldValue, newValue))
    }
  }
  if (snapshot.baselineFormFields !== undefined || snapshot.document.formFields !== undefined) {
    if (snapshot.baselineFormFields === undefined || snapshot.document.formFields === undefined) {
      fail('pdf/review-unavailable', 'PDF form baseline is unavailable; save in the PDF Reader UI')
    }
    const oldFields = formIndex(snapshot.baselineFormFields), newFields = formIndex(snapshot.document.formFields)
    const formLines: string[] = []
    for (const id of [...new Set([...oldFields.keys(), ...newFields.keys()])].sort()) {
      const oldValue = oldFields.get(id), newValue = newFields.get(id)
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue
      if (!oldValue || !newValue
        || JSON.stringify({ ...oldValue, value: undefined }) !== JSON.stringify({ ...newValue, value: undefined })) {
        fail('pdf/review-unavailable', 'Unexpected form structure changes cannot be reviewed as field-value edits; save in the PDF Reader UI')
      }
      // Full values, not full widget dictionaries. A normal form can have far
      // more than eight fields; keep a separate, explicit budget without ever
      // truncating an approval or omitting other draft changes.
      formLines.push(`${lines.length + formLines.length + 1}. 修改PDF表单字段 ID：${JSON.stringify(id)}`
        + `；名称：${value(newValue.name)}；页码：${value([...new Set(newValue.widgets.map(widget => widget.page))])}`
        + `；类型：${newValue.type}\n值：${value(oldValue.value)} → ${value(newValue.value)}`)
      if (formLines.length > MAX_FORM_REVIEW_ITEMS || formLines.join('\n\n').length > MAX_FORM_REVIEW_CHARS) {
        fail('pdf/review-too-large', 'Complete form changes exceed the save review budget; save manually in the PDF Reader UI')
      }
    }
    lines.push(...formLines)
  }
  if (!lines.length) fail('pdf/review-unavailable', 'The dirty draft has no reviewable PDF difference; save in the PDF Reader UI')
  return { text: lines.join('\n\n'), count: lines.length }
}
