import { z } from 'zod'
import { evidenceSha256 } from '../evidence/index.js'
import type { AgentPageReadPort } from '../evidence/index.js'
import { annotationOverlaps } from './annotation-overlap.js'
import { buildAnnotationPlans } from './annotation-plan.js'
import { buildSaveReview } from './save-review.js'
import { outlineOperationSchema } from '../../contracts/rpc/requests.js'
import { projectOutlineOperations } from '../outlines/index.js'
import { formFieldId } from '../forms/index.js'
import type { PdfAnnotation, PdfColor, PdfOutlineOperation, PdfWorkingCopyOperation } from '../../core/pdf-types.js'
import { projectFormOperations, type HostWorkspaceSnapshot, type WorkingCopyAgent } from '../working-copy/index.js'

const coordinate = z.number().finite()
const rect = z.tuple([coordinate, coordinate, coordinate, coordinate])
const color = z.tuple([coordinate.min(0).max(1), coordinate.min(0).max(1), coordinate.min(0).max(1)])
const documentId = z.string().min(1).max(512)
const annotationId = z.string().min(1).max(512)
const revision = z.number().int().nonnegative()
const editableMarkup = new Set(['Highlight', 'Underline', 'StrikeOut'])
const textAnchor = z.object({ page: z.number().int().min(1).max(100_000),
  quote: z.string().min(2).max(512) }).strict()

export const modelAnnotationSchema = z.object({
  documentId, expectedRevision: revision,
  subtype: z.enum(['Highlight', 'Underline', 'StrikeOut', 'Text']),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pdf-region'), page: z.number().int().min(1).max(100_000), rectPdf: rect }).strict(),
    z.object({ kind: z.literal('pdf-text'), page: z.number().int().min(1).max(100_000),
      quote: z.string().min(2).max(512) }).strict(),
    z.object({ kind: z.literal('pdf-text-range'), start: textAnchor, end: textAnchor }).strict(),
    z.object({ kind: z.literal('reference'), refId: z.string().min(1).max(128) }).strict(),
  ]),
  color: color.optional(), comment: z.string().max(2000).optional(),
}).strict()
export type ModelAnnotationInput = z.infer<typeof modelAnnotationSchema>
export const modelAnnotationUpdateSchema = z.object({
  documentId, expectedRevision: revision, annotationId,
  color: color.optional(), comment: z.string().max(2000).optional(),
}).strict()
export type ModelAnnotationUpdateInput = z.infer<typeof modelAnnotationUpdateSchema>
export const modelAnnotationDeleteSchema = z.object({ documentId, expectedRevision: revision, annotationId }).strict()
export type ModelAnnotationDeleteInput = z.infer<typeof modelAnnotationDeleteSchema>
export const modelSaveSchema = z.object({ documentId, expectedRevision: revision }).strict()
export const modelOutlineEditSchema = z.object({ documentId, expectedRevision: revision,
  operations: z.array(outlineOperationSchema).min(1).max(100),
}).strict()
export type ModelOutlineEditInput = z.infer<typeof modelOutlineEditSchema>
export const modelFillFormSchema = z.object({ documentId, expectedRevision: revision,
  fields: z.array(z.object({ fieldId: z.string().min(1).max(2048),
    value: z.union([z.string().max(8000), z.boolean(), z.array(z.string().max(2048)).max(1000)]),
  }).strict()).min(1).max(100),
}).strict().refine(input => JSON.stringify(input).length <= 64_000, 'Form batch exceeds the tool budget')
export type ModelFillFormInput = z.infer<typeof modelFillFormSchema>

export interface ModelWritePort {
  readSnapshot(sessionId: string, documentId: string): HostWorkspaceSnapshot
  execute(sessionId: string, input: Record<string, unknown>, agent: WorkingCopyAgent,
    signal: AbortSignal): Promise<unknown>
}

export interface ModelWriteReview {
  kind: 'save'
  documentId: string
  path: string
  revision: number
  dirty: boolean
  saveDiffText?: string
  saveChangeCount?: number
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

function checkRevision(snapshot: HostWorkspaceSnapshot, expectedRevision: number): void {
  if (snapshot.revision !== expectedRevision) fail('pdf/stale-revision', 'The PDF working copy changed; read its status again')
  if (snapshot.conflict) fail('pdf/source-conflict', 'The PDF source changed outside this working copy')
  if (snapshot.document.readOnly) fail('pdf/read-only', snapshot.document.readOnlyReason ?? 'This PDF is read-only')
}

function editableAnnotation(snapshot: HostWorkspaceSnapshot, id: string): PdfAnnotation {
  const annotation = snapshot.document.annotations.find(item => item.id === id)
  if (!annotation) fail('pdf/unknown-annotation', 'This annotation no longer exists; list the page again')
  if (!annotation.editable || !annotation.supported
    || (!editableMarkup.has(annotation.subtype) && annotation.subtype !== 'Text')) {
    fail('pdf/annotation-read-only', 'This annotation cannot be edited by the PDF Reader')
  }
  return annotation
}

/** Model edits join the same durable, undoable working copy used by the Reader. */
export function createModelWriteService(workspaces: ModelWritePort, pages?: AgentPageReadPort) {
  let disposed = false
  const assertOpen = () => { if (disposed) fail('pdf/write-unavailable', 'PDF model-write service has been disposed') }

  async function currentSource(sessionId: string, snapshot: HostWorkspaceSnapshot,
    agent: WorkingCopyAgent, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const observed = await workspaces.execute(sessionId,
      { action: 'inspectTarget', sessionId, path: snapshot.path }, agent, signal) as { version: string | null }
    const sourceDigest = evidenceSha256(snapshot.bytes)
    if (observed.version !== sourceDigest) fail('pdf/source-conflict', 'The PDF source changed outside this working copy')
    return sourceDigest
  }

  async function applyDraft(sessionId: string, snapshot: HostWorkspaceSnapshot, expectedRevision: number,
    operations: PdfWorkingCopyOperation[], agent: WorkingCopyAgent, signal: AbortSignal): Promise<HostWorkspaceSnapshot> {
    const sourceDigest = await currentSource(sessionId, snapshot, agent, signal)
    assertOpen()
    // The working-copy queue rechecks revision and source hash against UI edits.
    const value = await workspaces.execute(sessionId, { action: 'change', sessionId,
      id: snapshot.id, revision: expectedRevision,
      expectedSourceHash: sourceDigest, operations }, agent, signal)
    if (!isSnapshot(value)) fail('pdf/invalid-response', 'PDF change did not return a working copy')
    return value
  }

  async function annotate(sessionId: string, raw: ModelAnnotationInput, agent: WorkingCopyAgent,
    signal: AbortSignal) {
    assertOpen()
    const input = modelAnnotationSchema.parse(raw)
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    checkRevision(snapshot, input.expectedRevision)
    const plans = await buildAnnotationPlans(snapshot, input, sessionId, pages, signal)
    const resolved = plans.map(plan => {
      const overlaps = annotationOverlaps(plan.operation.annotation, snapshot.document.annotations)
      const partial = overlaps.filter(item => item.kind === 'partial')
      if (partial.length) {
        fail('pdf/annotation-overlap', `No annotations were added: page ${plan.operation.annotation.page} partially overlaps existing ${input.subtype} annotation(s) ${partial.map(item => item.annotationId).join(', ')}. Inspect them with pdf_page_annotations and adjust the requested range or edit an existing mark.`)
      }
      const existing = overlaps.find(item => item.kind === 'exact')
      if (existing) {
        const mark = snapshot.document.annotations.find(item => item.id === existing.annotationId)!
        const requestedColor = plan.operation.annotation.color
        const requestedComment = plan.operation.annotation.contents
        const differentColor = requestedColor !== undefined
          && (!mark.color || requestedColor.some((value, index) => Math.abs(value - mark.color![index]!) > 0.001))
        const differentComment = requestedComment !== undefined && requestedComment !== (mark.contents ?? '')
        if (differentColor || differentComment) {
          fail('pdf/annotation-already-exists', `No annotations were added: page ${existing.page} already has mark ${existing.annotationId}, but its color or comment differs. Use pdf_annotation_update on that ID instead of creating a duplicate.`)
        }
      }
      return { ...plan, annotationId: existing?.annotationId ?? plan.operation.annotation.id,
        action: existing ? 'existing' as const : 'added' as const }
    })
    const additions = resolved.filter(item => item.action === 'added').map(item => item.operation)
    if (!additions.length) {
      await currentSource(sessionId, snapshot, agent, signal)
      const latest = workspaces.readSnapshot(sessionId, input.documentId)
      if (latest.revision !== snapshot.revision || latest.contentVersion !== snapshot.contentVersion) {
        fail('pdf/stale-revision', 'The PDF changed while checking existing annotations; read its status again')
      }
    }
    const value = additions.length
      ? await applyDraft(sessionId, snapshot, input.expectedRevision, additions, agent, signal)
      : snapshot
    const first = resolved[0]!
    return { status: additions.length ? 'updated' as const : 'already_annotated' as const,
      documentId: value.id, annotationId: first.annotationId,
      annotationIds: resolved.map(item => item.annotationId),
      resolvedTarget: { page: first.operation.annotation.page, rectPdf: first.operation.annotation.rect,
        ...(input.target.kind === 'pdf-text' ? { quote: input.target.quote } : {}),
        ...(input.target.kind === 'pdf-text-range' ? { start: input.target.start, end: input.target.end } : {}) },
      coverage: { complete: true as const, totalChars: resolved.reduce((sum, item) => sum + (item.covered?.text.length ?? 0), 0),
        pages: resolved.map(item => ({ page: item.operation.annotation.page,
          annotationId: item.annotationId, action: item.action, rectPdf: item.operation.annotation.rect,
          ...(item.covered ? { startUtf16: item.covered.startUtf16, endUtf16: item.covered.endUtf16,
            text: item.covered.text } : {}) })) },
      revision: value.revision, dirty: value.dirty, canUndo: value.canUndo, savedToFile: false as const }
  }

  async function updateAnnotation(sessionId: string, raw: ModelAnnotationUpdateInput,
    agent: WorkingCopyAgent, signal: AbortSignal) {
    assertOpen()
    const input = modelAnnotationUpdateSchema.parse(raw)
    if (input.color === undefined && input.comment === undefined) {
      fail('pdf/invalid-patch', 'Specify a color or comment to update')
    }
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    checkRevision(snapshot, input.expectedRevision)
    const annotation = editableAnnotation(snapshot, input.annotationId)
    if (input.color !== undefined && (!editableMarkup.has(annotation.subtype) || annotation.replyToId)) {
      fail('pdf/invalid-color', 'Only a root text-mark annotation has an editable color')
    }
    const comment = input.comment?.trim()
    if (comment === '' && annotation.subtype === 'Text') {
      fail('pdf/invalid-comment', 'A note or comment reply cannot have empty text; delete it instead')
    }
    const patch = { ...(input.color !== undefined ? { color: [...input.color] as PdfColor } : {}),
      ...(comment !== undefined ? { contents: comment } : {}) }
    const value = await applyDraft(sessionId, snapshot, input.expectedRevision,
      [{ type: 'update', id: input.annotationId, patch }], agent, signal)
    return { status: 'updated' as const, documentId: value.id, annotationId: input.annotationId,
      revision: value.revision, dirty: value.dirty, canUndo: value.canUndo, savedToFile: false as const }
  }

  async function deleteAnnotation(sessionId: string, raw: ModelAnnotationDeleteInput,
    agent: WorkingCopyAgent, signal: AbortSignal) {
    assertOpen()
    const input = modelAnnotationDeleteSchema.parse(raw)
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    checkRevision(snapshot, input.expectedRevision)
    editableAnnotation(snapshot, input.annotationId)
    const value = await applyDraft(sessionId, snapshot, input.expectedRevision,
      [{ type: 'delete', id: input.annotationId }], agent, signal)
    return { status: 'deleted' as const, documentId: value.id, annotationId: input.annotationId,
      revision: value.revision, dirty: value.dirty, canUndo: value.canUndo, savedToFile: false as const }
  }

  async function editOutline(sessionId: string, raw: ModelOutlineEditInput,
    agent: WorkingCopyAgent, signal: AbortSignal) {
    assertOpen()
    const input = modelOutlineEditSchema.parse(raw)
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    checkRevision(snapshot, input.expectedRevision)
    // Validate the entire batch before starting the shared, revision-checked write.
    // The transaction repeats these pure checks against its authoritative snapshot.
    projectOutlineOperations(snapshot.document, input.operations)
    const value = await applyDraft(sessionId, snapshot, input.expectedRevision, input.operations, agent, signal)
    return { status: 'updated' as const, documentId: value.id, revision: value.revision,
      outlineIds: [...new Set(input.operations.map((operation: PdfOutlineOperation) => operation.id))],
      operationCount: input.operations.length, dirty: value.dirty, canUndo: value.canUndo,
      savedToFile: false as const }
  }

  async function fillForm(sessionId: string, raw: ModelFillFormInput, agent: WorkingCopyAgent, signal: AbortSignal) {
    assertOpen()
    const input = modelFillFormSchema.parse(raw)
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    checkRevision(snapshot, input.expectedRevision)
    const operations = input.fields.map(({ fieldId, value }) => ({ type: 'set-field' as const, fieldId, value }))
    // The same pure validation and transaction are used by Reader widgets.
    // A bad field rejects the whole batch, with no partial edits or file writes.
    projectFormOperations(snapshot.document, operations)
    const fields = new Map(snapshot.document.formFields!.map(field => [formFieldId(field), field]))
    if (input.fields.some(field => !fields.get(field.fieldId)!.widgets.length)) {
      fail('pdf/form-field-not-visible', 'A requested field has no visible controls; inspect its page before filling')
    }
    const value = await applyDraft(sessionId, snapshot, input.expectedRevision, operations, agent, signal)
    return { status: 'updated' as const, documentId: value.id, revision: value.revision,
      fieldIds: input.fields.map(field => field.fieldId), dirty: value.dirty, canUndo: value.canUndo,
      savedToFile: false as const }
  }

  async function save(sessionId: string, raw: { documentId: string; expectedRevision: number },
    agent: WorkingCopyAgent, signal: AbortSignal,
    review: (details: ModelWriteReview) => Promise<boolean>) {
    assertOpen()
    const input = modelSaveSchema.parse(raw)
    const initial = workspaces.readSnapshot(sessionId, input.documentId)
    checkRevision(initial, input.expectedRevision)
    if (!initial.dirty) return { status: 'no_changes' as const, documentId: initial.id,
      revision: initial.revision, dirty: false as const }
    if (initial.path.length > 1024) fail('pdf/review-too-large', 'PDF path is too long for a reviewable save approval')
    const saveDiff = buildSaveReview(initial)
    const sourceDigest = await currentSource(sessionId, initial, agent, signal)
    assertOpen()
    const accepted = await review({ kind: 'save', documentId: initial.id, path: initial.path,
      revision: initial.revision, dirty: initial.dirty,
      saveDiffText: saveDiff.text, saveChangeCount: saveDiff.count })
    assertOpen()
    if (!accepted) fail('pdf/approval-rejected', 'The user did not approve saving this PDF')
    signal.throwIfAborted()
    const latest = workspaces.readSnapshot(sessionId, input.documentId)
    checkRevision(latest, input.expectedRevision)
    if (latest.path !== initial.path || latest.contentVersion !== initial.contentVersion
      || latest.sourceVersion !== initial.sourceVersion || evidenceSha256(latest.bytes) !== sourceDigest
      || !latest.dirty) fail('pdf/stale-revision', 'The PDF changed while waiting for save approval')
    if (buildSaveReview(latest).text !== saveDiff.text) {
      fail('pdf/stale-revision', 'The PDF changes differ from the approved review')
    }
    await currentSource(sessionId, latest, agent, signal)
    assertOpen()
    const value = await workspaces.execute(sessionId, { action: 'save', sessionId,
      id: input.documentId, revision: input.expectedRevision, options: {} }, agent, signal)
    if (!isSnapshot(value)) fail('pdf/invalid-response', 'PDF save did not return a working copy')
    return { status: 'saved' as const, documentId: value.id, path: value.path,
      sourceVersion: value.sourceVersion, contentVersion: value.contentVersion,
      revision: value.revision, dirty: value.dirty, approval: 'user-questions-selected' as const,
      ...(value.warning ? { warning: value.warning } : {}) }
  }

  return { annotate, updateAnnotation, deleteAnnotation, editOutline, fillForm, save, dispose() { disposed = true } }
}

function isSnapshot(value: unknown): value is HostWorkspaceSnapshot {
  return !!value && typeof value === 'object' && 'bytes' in value && 'revision' in value && 'id' in value
}
