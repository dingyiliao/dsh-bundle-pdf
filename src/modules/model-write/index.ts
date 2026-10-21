import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { evidenceSha256 } from '../evidence/index.js'
import type { AgentPageReadPort } from '../evidence/index.js'
import { buildSaveReview } from './save-review.js'
import { locateTextTarget } from './text-target.js'
import type { PdfAnnotation, PdfAnnotationOperation, PdfColor, PdfRect } from '../../core/pdf-types.js'
import type { HostWorkspaceSnapshot, WorkingCopyAgent } from '../working-copy/index.js'

const coordinate = z.number().finite()
const rect = z.tuple([coordinate, coordinate, coordinate, coordinate])
const color = z.tuple([coordinate.min(0).max(1), coordinate.min(0).max(1), coordinate.min(0).max(1)])
const documentId = z.string().min(1).max(512)
const annotationId = z.string().min(1).max(512)
const revision = z.number().int().nonnegative()
const editableMarkup = new Set(['Highlight', 'Underline', 'StrikeOut'])

export const modelAnnotationSchema = z.object({
  documentId, expectedRevision: revision,
  subtype: z.enum(['Highlight', 'Underline', 'StrikeOut', 'Text']),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pdf-region'), page: z.number().int().min(1).max(100_000), rectPdf: rect }).strict(),
    z.object({ kind: z.literal('pdf-text'), page: z.number().int().min(1).max(100_000),
      quote: z.string().min(2).max(512) }).strict(),
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

async function annotationOperation(snapshot: HostWorkspaceSnapshot, input: ModelAnnotationInput,
  sessionId: string, pages: AgentPageReadPort | undefined, signal: AbortSignal): Promise<Extract<PdfAnnotationOperation, { type: 'add' }>> {
  if (input.subtype === 'Text' && !input.comment?.trim()) fail('pdf/invalid-comment', 'A text note requires a non-empty comment')
  if (input.target.kind === 'reference') {
    // References have approximate glyph-origin boxes, not verified PDF geometry.
    return fail('pdf/approximate-target', 'This text reference does not have verified PDF geometry; select an explicit region')
  }
  const { page } = input.target
  const bounds = snapshot.document.pages[page - 1]?.cropBox
  if (!bounds) fail('pdf/invalid-page', 'Annotation page is outside this document')
  if (input.target.kind === 'pdf-region' && input.subtype !== 'Text') {
    fail('pdf/unverified-region', 'Text markup requires an exact pdf-text quote; guessed rectangles are not safe annotation targets')
  }
  if (input.target.kind === 'pdf-text' && input.subtype === 'Text') {
    fail('pdf/invalid-target', 'A standalone text note requires a PDF position, not a quoted text span')
  }
  let rectPdf: PdfRect
  let quadPoints: number[] | undefined
  if (input.target.kind === 'pdf-text') {
    if (!pages) fail('pdf/text-geometry-unavailable', 'The PDF text geometry reader is unavailable')
    const read = await pages.readPageText(sessionId, snapshot.id, page, signal)
    if (read.snapshot.contentVersion !== snapshot.contentVersion || read.snapshot.revision !== snapshot.revision) {
      fail('pdf/stale-revision', 'The PDF changed while locating the quoted text; read its status again')
    }
    const geometry = locateTextTarget(read.content, input.target.quote)
    rectPdf = geometry.rect
    quadPoints = geometry.quadPoints
  } else rectPdf = input.target.rectPdf
  const [left, bottom, right, top] = rectPdf
  if (!(right > left && top > bottom) || left < bounds[0] || bottom < bounds[1]
    || right > bounds[2] || top > bounds[3]) {
    fail('pdf/invalid-region', 'Annotation rectangle must lie inside the PDF page crop box')
  }
  return { type: 'add', annotation: {
    id: `ai_${randomUUID()}`, page, subtype: input.subtype, rect: [...rectPdf] as PdfRect,
    ...(quadPoints ? { quadPoints } : {}),
    ...(input.color ? { color: [...input.color] as PdfColor } : {}),
    ...(input.comment !== undefined ? { contents: input.comment } : {}), author: 'AI suggestion',
  } }
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
    operation: PdfAnnotationOperation, agent: WorkingCopyAgent, signal: AbortSignal): Promise<HostWorkspaceSnapshot> {
    const sourceDigest = await currentSource(sessionId, snapshot, agent, signal)
    assertOpen()
    // The working-copy queue rechecks revision and source hash against UI edits.
    const value = await workspaces.execute(sessionId, { action: 'change', sessionId,
      id: snapshot.id, revision: expectedRevision,
      expectedSourceHash: sourceDigest, operations: [operation] }, agent, signal)
    if (!isSnapshot(value)) fail('pdf/invalid-response', 'PDF change did not return a working copy')
    return value
  }

  async function annotate(sessionId: string, raw: ModelAnnotationInput, agent: WorkingCopyAgent,
    signal: AbortSignal) {
    assertOpen()
    const input = modelAnnotationSchema.parse(raw)
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    checkRevision(snapshot, input.expectedRevision)
    const operation = await annotationOperation(snapshot, input, sessionId, pages, signal)
    const value = await applyDraft(sessionId, snapshot, input.expectedRevision, operation, agent, signal)
    return { status: 'updated' as const, documentId: value.id, annotationId: operation.annotation.id,
      resolvedTarget: { page: operation.annotation.page, rectPdf: operation.annotation.rect,
        ...(input.target.kind === 'pdf-text' ? { quote: input.target.quote } : {}) },
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
      { type: 'update', id: input.annotationId, patch }, agent, signal)
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
      { type: 'delete', id: input.annotationId }, agent, signal)
    return { status: 'deleted' as const, documentId: value.id, annotationId: input.annotationId,
      revision: value.revision, dirty: value.dirty, canUndo: value.canUndo, savedToFile: false as const }
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
      fail('pdf/stale-revision', 'The PDF annotation changes differ from the approved review')
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

  return { annotate, updateAnnotation, deleteAnnotation, save, dispose() { disposed = true } }
}

function isSnapshot(value: unknown): value is HostWorkspaceSnapshot {
  return !!value && typeof value === 'object' && 'bytes' in value && 'revision' in value && 'id' in value
}
