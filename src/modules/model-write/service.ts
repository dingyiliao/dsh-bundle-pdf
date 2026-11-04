import { z } from 'zod'
import { evidenceSha256 } from '../evidence/index.js'
import type { AgentPageReadPort, TextReferenceResolverPort } from '../evidence/index.js'
import { describeAnnotation, prepareAnnotationBatch } from './annotation-batch.js'
import { buildSaveReview } from './save-review.js'
import { outlineOperationSchema } from '../../contracts/rpc/requests.js'
import { projectOutlineOperations } from '../outlines/index.js'
import { formFieldId, formConditionSchema, checkFormConditions, formChoiceGroupSchema, checkFormChoiceGroups } from '../forms/index.js'
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

export const modelAnnotationItemSchema = z.object({
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
export type ModelAnnotationItem = z.infer<typeof modelAnnotationItemSchema>
export const modelAnnotationSchema = modelAnnotationItemSchema.extend({ documentId, expectedRevision: revision }).strict()
export type ModelAnnotationInput = z.infer<typeof modelAnnotationSchema>
export const modelAnnotationBatchSchema = z.object({
  documentId, expectedRevision: revision,
  annotations: z.array(modelAnnotationItemSchema).min(1).max(50),
}).strict().refine(input => JSON.stringify(input).length <= 64_000, 'Annotation batch exceeds the tool budget')
export type ModelAnnotationBatchInput = z.infer<typeof modelAnnotationBatchSchema>
/** Strict alternatives reject mixing top-level single-item properties with annotations[]. */
export const modelAnnotationCreateSchema = z.union([modelAnnotationSchema, modelAnnotationBatchSchema])
export type ModelAnnotationCreateInput = z.infer<typeof modelAnnotationCreateSchema>

type ModelAnnotationWriteStatus = {
  documentId: string
  revision: number
  dirty: boolean
  canUndo: boolean
  savedToFile: false
}
export type ModelAnnotationResult = ReturnType<typeof describeAnnotation> & ModelAnnotationWriteStatus
export type ModelAnnotationBatchResult = ModelAnnotationWriteStatus & {
  status: 'updated' | 'already_annotated'
  /** Unique IDs across all entries; each entry retains its own complete coverage. */
  annotationIds: string[]
  annotations: Array<ReturnType<typeof describeAnnotation> & { index: number }>
}
export type ModelAnnotationCreateResult = ModelAnnotationResult | ModelAnnotationBatchResult
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
  conditions: z.array(formConditionSchema).max(100).optional(),
  choiceGroups: z.array(formChoiceGroupSchema).max(50).optional(),
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
export function createModelWriteService(workspaces: ModelWritePort, pages?: AgentPageReadPort,
  references?: TextReferenceResolverPort) {
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
    signal: AbortSignal): Promise<ModelAnnotationResult>
  async function annotate(sessionId: string, raw: ModelAnnotationBatchInput, agent: WorkingCopyAgent,
    signal: AbortSignal): Promise<ModelAnnotationBatchResult>
  async function annotate(sessionId: string, raw: ModelAnnotationCreateInput, agent: WorkingCopyAgent,
    signal: AbortSignal): Promise<ModelAnnotationCreateResult>
  async function annotate(sessionId: string, raw: ModelAnnotationCreateInput, agent: WorkingCopyAgent,
    signal: AbortSignal): Promise<ModelAnnotationCreateResult> {
    assertOpen()
    const input = modelAnnotationCreateSchema.parse(raw)
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    checkRevision(snapshot, input.expectedRevision)
    const batch = 'annotations' in input
    const items = batch ? input.annotations : [input]
    const prepared = await prepareAnnotationBatch(snapshot, items, batch, sessionId, pages, signal, references,
      async (owner, source, sourceSignal) => ({ path: source.path,
        digest: await currentSource(owner, source, agent, sourceSignal) }))
    assertOpen()
    signal.throwIfAborted()
    const additions = prepared.flatMap(entry => entry.filter(plan => plan.action === 'added').map(plan => plan.operation))
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
    const common = { documentId: value.id, revision: value.revision,
      dirty: value.dirty, canUndo: value.canUndo, savedToFile: false as const }
    const results = items.map((item, index) => describeAnnotation(item, prepared[index]!))
    return batch ? { ...common, status: additions.length ? 'updated' : 'already_annotated',
      annotationIds: [...new Set(results.flatMap(result => result.annotationIds))],
      annotations: results.map((result, index) => ({ index, ...result })) }
      : { ...common, ...results[0]! }
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
    const projected = projectFormOperations(snapshot.document, operations, { requireVisible: true })
    const conditionReview = input.conditions?.length ? checkFormConditions(snapshot.document, projected,
      new Set(input.fields.map(field => field.fieldId)), input.conditions) : undefined
    const choiceReview = input.choiceGroups?.length ? checkFormChoiceGroups(projected, input.choiceGroups) : undefined
    const fields = new Map(snapshot.document.formFields!.map(field => [formFieldId(field), field]))
    const nextFields = new Map(projected.formFields!.map(field => [formFieldId(field), field]))
    const changed = operations.filter(operation => JSON.stringify(fields.get(operation.fieldId)!.value)
      !== JSON.stringify(nextFields.get(operation.fieldId)!.value))
    let value = snapshot
    if (changed.length) value = await applyDraft(sessionId, snapshot, input.expectedRevision, changed, agent, signal)
    else {
      await currentSource(sessionId, snapshot, agent, signal)
      const latest = workspaces.readSnapshot(sessionId, input.documentId)
      if (latest.revision !== snapshot.revision || latest.contentVersion !== snapshot.contentVersion) {
        fail('pdf/stale-revision', 'The PDF changed while checking unchanged fields; read its status again')
      }
    }
    const updatedFieldIds = changed.map(operation => operation.fieldId)
    const reviewIds = new Set([...input.fields.map(field => field.fieldId),
      ...(input.conditions?.flatMap(rule => [...rule.fieldIds, rule.when.fieldId]) ?? []),
      ...(input.choiceGroups?.flatMap(group => group.fieldIds) ?? [])])
    const verificationPages = [...new Set(snapshot.document.formFields!.filter(field => reviewIds.has(formFieldId(field)))
      .flatMap(field => field.widgets.map(widget => widget.page)))].sort((a, b) => a - b)
    return { status: changed.length ? 'updated' as const : 'no_changes' as const,
      documentId: value.id, revision: value.revision, appliedCount: changed.length, updatedFieldIds,
      ...(conditionReview ? { conditionReview } : {}),
      ...(choiceReview ? { choiceReview } : {}), verificationPages,
      unchangedFieldIds: input.fields.filter(field => !updatedFieldIds.includes(field.fieldId)).map(field => field.fieldId),
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
