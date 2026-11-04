import type { NewPdfAnnotation, PdfAnnotation } from '../../core/pdf-types.js'
import type { AgentPageReadPort, FreshSourceRead, TextReferenceResolverPort } from '../evidence/index.js'
import type { HostWorkspaceSnapshot } from '../working-copy/index.js'
import type { ModelAnnotationItem } from './service.js'
import { buildAnnotationPlans, type AnnotationPlan } from './annotation-plan.js'
import { annotationOverlaps } from './annotation-overlap.js'

type Mark = Pick<PdfAnnotation, 'id' | 'page' | 'subtype' | 'quadPoints' | 'replyToId' | 'color' | 'contents'>
type ResolvedPlan = AnnotationPlan & { annotationId: string; action: 'added' | 'existing' }

function differs(requested: NewPdfAnnotation, mark: Mark, pending: boolean): boolean {
  const color = requested.color
  const differentColor = pending && (color === undefined) !== (mark.color === undefined)
    || color !== undefined && (!mark.color || color.some((value, index) => Math.abs(value - mark.color![index]!) > 0.001))
  // Existing marks retain the historical omitted-option wildcard. Pending marks
  // must agree in either order, before the native adapter chooses default color.
  const differentComment = pending ? (requested.contents ?? '') !== (mark.contents ?? '')
    : requested.contents !== undefined && requested.contents !== (mark.contents ?? '')
  return differentColor || differentComment
}

/** Validate every item before producing the one working-copy change transaction. */
export async function prepareAnnotationBatch(snapshot: HostWorkspaceSnapshot, items: readonly ModelAnnotationItem[],
  batch: boolean, sessionId: string, pages: AgentPageReadPort | undefined, signal: AbortSignal,
  references?: TextReferenceResolverPort, readSource?: FreshSourceRead): Promise<ResolvedPlan[][]> {
  const plans: AnnotationPlan[][] = []
  let operationCount = 0, totalChars = 0
  for (const [index, item] of items.entries()) {
    signal.throwIfAborted()
    try {
      const entry = await buildAnnotationPlans(snapshot, item, sessionId, pages, signal, references, readSource)
      operationCount += entry.length
      totalChars += entry.reduce((sum, plan) => sum + (plan.covered?.text.length ?? 0), 0)
      if (batch && (operationCount > 100 || totalChars > 64_000)) {
        throw Object.assign(new Error('Annotation batch exceeds 100 page marks or 64000 text characters; use smaller sequential batches'),
          { code: 'pdf/annotation-batch-too-large' })
      }
      plans.push(entry)
    } catch (error) {
      signal.throwIfAborted()
      if (!batch) throw error
      throw Object.assign(new Error(`annotations[${index}]: ${error instanceof Error ? error.message : String(error)}`, { cause: error }),
        { code: error instanceof Error && 'code' in error ? error.code : 'pdf/invalid-annotation', index, appliedCount: 0 })
    }
  }

  const marks: Mark[] = [...snapshot.document.annotations]
  const pendingIds = new Set<string>()
  const owners = new Map<string, number[]>()
  return plans.map((entry, index) => entry.map(plan => {
    const proposed = plan.operation.annotation
    const overlaps = annotationOverlaps(proposed, marks)
    const reject = (code: string, conflicts: typeof overlaps, reason: string): never => {
      const annotationIds = conflicts.map(overlap => overlap.annotationId)
      const conflictingIndexes = [...new Set(annotationIds.flatMap(id => owners.get(id) ?? []))]
      const prefix = batch ? `annotations[${index}]${conflictingIndexes.length
        ? ` conflicts with annotations[${conflictingIndexes.join('], annotations[')}]` : ''}: ` : ''
      throw Object.assign(new Error(`${prefix}No annotations were added: page ${proposed.page} ${reason} ${annotationIds.join(', ')}. Inspect existing IDs with pdf_annotation_list and adjust the range or use pdf_annotation_update.`),
        { code, ...(batch ? { index, conflictingIndexes, annotationIds, appliedCount: 0 } : {}) })
    }
    const partial = overlaps.filter(overlap => overlap.kind === 'partial')
    if (partial.length) reject('pdf/annotation-overlap', partial, `partially overlaps ${proposed.subtype} annotation(s)`)
    const exact = overlaps.filter(overlap => overlap.kind === 'exact')
    const different = exact.filter(overlap => differs(proposed, marks.find(mark => mark.id === overlap.annotationId)!,
      pendingIds.has(overlap.annotationId)))
    if (different.length) reject('pdf/annotation-already-exists', different, 'already has a mark with a different color or comment:')
    const annotationId = exact[0]?.annotationId ?? proposed.id
    if (!exact.length) {
      marks.push(proposed)
      pendingIds.add(annotationId)
    }
    owners.set(annotationId, [...(owners.get(annotationId) ?? []), index])
    return { ...plan, annotationId, action: exact.length ? 'existing' as const : 'added' as const }
  }))
}

/** Keep the single-item result contract for legacy callers and each batch item. */
export function describeAnnotation(input: ModelAnnotationItem, resolved: readonly ResolvedPlan[]) {
  const first = resolved[0]!
  return { status: resolved.some(plan => plan.action === 'added') ? 'updated' as const : 'already_annotated' as const,
    annotationId: first.annotationId, annotationIds: resolved.map(plan => plan.annotationId),
    resolvedTarget: { page: first.operation.annotation.page, rectPdf: first.operation.annotation.rect,
      ...(input.target.kind === 'pdf-text' ? { quote: input.target.quote } : {}),
      ...(input.target.kind === 'reference' ? { refId: input.target.refId } : {}),
      ...(input.target.kind === 'pdf-text-range' ? { start: input.target.start, end: input.target.end } : {}) },
    coverage: { complete: true as const, totalChars: resolved.reduce((sum, plan) => sum + (plan.covered?.text.length ?? 0), 0),
      pages: resolved.map(plan => ({ page: plan.operation.annotation.page,
        annotationId: plan.annotationId, action: plan.action, rectPdf: plan.operation.annotation.rect,
        ...(plan.covered ? { startUtf16: plan.covered.startUtf16, endUtf16: plan.covered.endUtf16,
          text: plan.covered.text, ...(plan.covered.refId ? { refId: plan.covered.refId } : {}) } : {}) })) } }
}
