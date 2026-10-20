import type { PdfAnnotation } from '../../core/pdf-types.js'
import type { HostWorkspaceSnapshot } from '../working-copy/index.js'

const MAX_REVIEW_ITEMS = 8
const MAX_REVIEW_CHARS = 6000

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

type ReviewFields = Pick<PdfAnnotation, 'page' | 'subtype' | 'rect' | 'quadPoints' | 'color'
  | 'opacity' | 'contents' | 'author' | 'createdAt' | 'modifiedAt' | 'flags'
  | 'supported' | 'editable' | 'readOnlyReason' | 'sourceObjectId' | 'popupObjectId' | 'linkAction'
  | 'replyToId' | 'replyType' | 'hasRichText'>

function fields(annotation: PdfAnnotation): ReviewFields {
  const { page, subtype, rect, quadPoints, color, opacity, contents, author, createdAt, modifiedAt,
    flags, supported, editable, readOnlyReason, sourceObjectId, popupObjectId, linkAction, replyToId, replyType,
    hasRichText } = annotation
  return { page, subtype, rect, quadPoints, color, opacity, contents, author, createdAt, modifiedAt,
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

/** The entire final save delta, never a truncated selection of draft operations. */
export function buildSaveReview(snapshot: HostWorkspaceSnapshot): { text: string; count: number } {
  if (!snapshot.baselineAnnotations) fail('pdf/review-unavailable', 'PDF baseline is unavailable; save in the PDF Reader UI')
  const before = indexed(snapshot.baselineAnnotations), after = indexed(snapshot.document.annotations)
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort()
  const lines: string[] = []
  for (const id of ids) {
    const oldValue = before.get(id), newValue = after.get(id)
    if (oldValue && newValue && JSON.stringify(fields(oldValue)) === JSON.stringify(fields(newValue))) continue
    if (lines.length >= MAX_REVIEW_ITEMS) fail('pdf/review-too-large', 'Too many PDF annotation changes to review here; save manually in the PDF Reader UI')
    lines.push(describe(lines.length + 1, id, oldValue, newValue))
    if (lines.join('\n\n').length > MAX_REVIEW_CHARS) {
      fail('pdf/review-too-large', 'PDF annotation review text is too long; save manually in the PDF Reader UI')
    }
  }
  if (!lines.length) fail('pdf/review-unavailable', 'The dirty draft has no reviewable annotation difference; save in the PDF Reader UI')
  return { text: lines.join('\n\n'), count: lines.length }
}
