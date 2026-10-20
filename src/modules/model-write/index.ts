import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { projectPdfOperations } from '../annotations/index.js'
import { evidenceSha256 } from '../evidence/index.js'
import { buildSaveReview } from './save-review.js'
import type { PdfAnnotationOperation, PdfColor, PdfRect } from '../../core/pdf-types.js'
import type { HostWorkspaceSnapshot, WorkingCopyAgent } from '../working-copy/index.js'

const coordinate = z.number().finite()
const rect = z.tuple([coordinate, coordinate, coordinate, coordinate])
const color = z.tuple([coordinate.min(0).max(1), coordinate.min(0).max(1), coordinate.min(0).max(1)])
const documentId = z.string().min(1).max(512)
const revision = z.number().int().nonnegative()

export const annotationPreviewSchema = z.object({
  documentId, expectedRevision: revision,
  subtype: z.enum(['Highlight', 'Underline', 'StrikeOut', 'Text']),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pdf-region'), page: z.number().int().min(1).max(100_000), rectPdf: rect }).strict(),
    z.object({ kind: z.literal('reference'), refId: z.string().min(1).max(128) }).strict(),
  ]),
  color: color.optional(), comment: z.string().max(2000).optional(),
}).strict()
export type AnnotationPreviewInput = z.infer<typeof annotationPreviewSchema>

export const annotationCommitSchema = z.object({ proposalId: z.string().regex(/^pdfprop_[0-9a-f-]{36}$/) }).strict()
export const modelSaveSchema = z.object({ documentId, expectedRevision: revision }).strict()

export interface ModelWritePort {
  readSnapshot(sessionId: string, documentId: string): HostWorkspaceSnapshot
  execute(sessionId: string, input: Record<string, unknown>, agent: WorkingCopyAgent,
    signal: AbortSignal): Promise<unknown>
}

export interface ModelWriteReview {
  kind: 'annotation' | 'save'
  documentId: string
  path: string
  page?: number
  subtype?: AnnotationPreviewInput['subtype']
  rectPdf?: PdfRect
  color?: PdfColor
  comment?: string
  revision: number
  dirty: boolean
  beforeAnnotations?: number
  afterAnnotations?: number
  proposalId?: string
  saveDiffText?: string
  saveChangeCount?: number
}

type Proposal = {
  id: string; sessionId: string; documentId: string; path: string; contentVersion: string
  sourceVersion: string; sourceDigest: string; revision: number; createdAt: number; expiresAt: number
  operation: PdfAnnotationOperation; review: ModelWriteReview
  state: 'ready' | 'busy' | 'rejected' | 'committed'
  result?: { status: 'committed'; documentId: string; revision: number; dirty: true; canUndo: boolean;
    approval: 'user-questions-selected' }
}

const PROPOSAL_TTL_MS = 5 * 60_000
const MAX_PROPOSALS = 128
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

function checkRevision(snapshot: HostWorkspaceSnapshot, expectedRevision: number): void {
  if (snapshot.revision !== expectedRevision) fail('pdf/stale-revision', 'The PDF working copy changed; preview it again')
  if (snapshot.conflict) fail('pdf/source-conflict', 'The PDF source changed outside this working copy')
  if (snapshot.document.readOnly) fail('pdf/read-only', snapshot.document.readOnlyReason ?? 'This PDF is read-only')
  // The exact destination must be legible in the human review card. Do not
  // truncate it there: a truncated path could authorize the wrong file.
  if (snapshot.path.length > 1024) fail('pdf/review-too-large', 'PDF path is too long for a reviewable write approval')
}

function regionOperation(snapshot: HostWorkspaceSnapshot, input: AnnotationPreviewInput): Extract<PdfAnnotationOperation, { type: 'add' }> {
  if (input.subtype === 'Text' && !input.comment?.trim()) {
    fail('pdf/invalid-comment', 'A text note requires a non-empty comment')
  }
  if (input.target.kind === 'reference') {
    // Current text references have approximate glyph-origin boxes, not a verified
    // PDF quadrilateral. They are useful for reading, but never for writing.
    return fail('pdf/approximate-target', 'This text reference does not have verified PDF geometry; select an explicit region')
  }
  const { page, rectPdf } = input.target
  const bounds = snapshot.document.pages[page - 1]?.cropBox
  if (!bounds) fail('pdf/invalid-page', 'Annotation page is outside this document')
  const [left, bottom, right, top] = rectPdf
  if (!(right > left && top > bottom) || left < bounds[0] || bottom < bounds[1]
    || right > bounds[2] || top > bounds[3]) {
    fail('pdf/invalid-region', 'Annotation rectangle must lie inside the PDF page crop box')
  }
  const annotation = {
    id: `ai_${randomUUID()}`, page, subtype: input.subtype, rect: [...rectPdf] as PdfRect,
    ...(input.subtype === 'Text' ? {} : { quadPoints: [left, top, right, top, left, bottom, right, bottom] }),
    ...(input.color ? { color: [...input.color] as PdfColor } : {}),
    ...(input.comment !== undefined ? { contents: input.comment } : {}),
    author: 'AI suggestion',
  }
  return { type: 'add', annotation }
}

/** A volatile, bounded proposal ledger. All mutations use the existing V1 working-copy transaction. */
export function createModelWriteService(workspaces: ModelWritePort, now: () => number = Date.now) {
  const proposals = new Map<string, Proposal>()
  let disposed = false

  function collect(): void {
    const at = now()
    for (const [id, proposal] of proposals) {
      if (proposal.state !== 'busy' && proposal.expiresAt <= at) proposals.delete(id)
    }
    for (const [id, proposal] of proposals) {
      if (proposals.size < MAX_PROPOSALS) break
      if (proposal.state !== 'busy') proposals.delete(id)
    }
    if (proposals.size >= MAX_PROPOSALS) fail('pdf/proposals-full', 'Too many PDF annotations are awaiting review; retry after a review completes')
  }

  function assertLiveProposal(proposal: Proposal): void {
    if (disposed || proposals.get(proposal.id) !== proposal) {
      fail('pdf/proposal-unavailable', 'Annotation proposal is no longer available; preview it again')
    }
  }

  async function currentSource(sessionId: string, snapshot: HostWorkspaceSnapshot,
    agent: WorkingCopyAgent, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const observed = await workspaces.execute(sessionId,
      { action: 'inspectTarget', sessionId, path: snapshot.path }, agent, signal) as { version: string | null }
    const sourceDigest = evidenceSha256(snapshot.bytes)
    if (observed.version !== sourceDigest) fail('pdf/source-conflict', 'The PDF source changed outside this working copy')
    return sourceDigest
  }

  async function preview(sessionId: string, raw: AnnotationPreviewInput, agent: WorkingCopyAgent,
    signal: AbortSignal) {
    if (disposed) fail('pdf/proposal-unavailable', 'PDF model-write service has been disposed')
    const input = annotationPreviewSchema.parse(raw)
    const snapshot = workspaces.readSnapshot(sessionId, input.documentId)
    checkRevision(snapshot, input.expectedRevision)
    const sourceDigest = await currentSource(sessionId, snapshot, agent, signal)
    const operation = regionOperation(snapshot, input)
    const projected = projectPdfOperations(snapshot.document, [operation], new Date(now()).toISOString())
    const after = workspaces.readSnapshot(sessionId, input.documentId)
    if (after.revision !== snapshot.revision || after.contentVersion !== snapshot.contentVersion
      || after.path !== snapshot.path || evidenceSha256(after.bytes) !== sourceDigest) {
      fail('pdf/stale-revision', 'The PDF changed while creating the preview')
    }
    collect()
    const id = `pdfprop_${randomUUID()}`
    const createdAt = now(), expiresAt = createdAt + PROPOSAL_TTL_MS
    const annotation = operation.annotation
    const review: ModelWriteReview = { kind: 'annotation', documentId: snapshot.id, path: snapshot.path,
      page: annotation.page, subtype: annotation.subtype, rectPdf: annotation.rect,
      ...(annotation.color ? { color: annotation.color } : {}),
      ...(annotation.contents !== undefined ? { comment: annotation.contents } : {}),
      revision: snapshot.revision, dirty: snapshot.dirty,
      beforeAnnotations: snapshot.document.annotations.length, afterAnnotations: projected.annotations.length,
      proposalId: id }
    proposals.set(id, { id, sessionId, documentId: snapshot.id, path: snapshot.path,
      contentVersion: snapshot.contentVersion, sourceVersion: snapshot.sourceVersion, sourceDigest,
      revision: snapshot.revision, createdAt, expiresAt, operation, review, state: 'ready' })
    return { status: 'preview' as const, proposalId: id, expiresAt: new Date(expiresAt).toISOString(),
      sourceDigest, contentVersion: snapshot.contentVersion, revision: snapshot.revision,
      preview: { ...review }, limitations: [
        'This is a metadata-only preview; no PDF or draft has changed.',
        'The target is a PDF-space rectangle. It does not prove that a particular phrase is covered.',
        'Only a separate user-reviewed commit will create one undoable draft batch; saving is separate.',
      ] }
  }

  async function commit(sessionId: string, raw: { proposalId: string }, agent: WorkingCopyAgent,
    signal: AbortSignal, review: (details: ModelWriteReview) => Promise<boolean>) {
    if (disposed) fail('pdf/proposal-unavailable', 'PDF model-write service has been disposed')
    const { proposalId } = annotationCommitSchema.parse(raw)
    const proposal = proposals.get(proposalId)
    if (!proposal || proposal.sessionId !== sessionId) fail('pdf/proposal-unavailable', 'Annotation proposal is unavailable in this session')
    if (proposal.expiresAt <= now()) { proposals.delete(proposalId); fail('pdf/proposal-expired', 'Annotation proposal expired; preview it again') }
    if (proposal.state === 'committed') return proposal.result!
    if (proposal.state === 'busy') fail('pdf/proposal-busy', 'Annotation proposal is already being reviewed')
    if (proposal.state === 'rejected') fail('pdf/proposal-rejected', 'This annotation proposal was already declined')
    const initial = workspaces.readSnapshot(sessionId, proposal.documentId)
    checkProposal(initial, proposal)
    await currentSource(sessionId, initial, agent, signal)
    proposal.state = 'busy'
    try {
      const accepted = await review(proposal.review)
      assertLiveProposal(proposal)
      if (!accepted) { proposal.state = 'rejected'; return fail('pdf/approval-rejected', 'The user did not approve this annotation') }
      signal.throwIfAborted()
      if (proposal.expiresAt <= now()) fail('pdf/proposal-expired', 'Annotation proposal expired during review; preview it again')
      const latest = workspaces.readSnapshot(sessionId, proposal.documentId)
      checkProposal(latest, proposal)
      await currentSource(sessionId, latest, agent, signal)
      assertLiveProposal(proposal)
      if (proposal.expiresAt <= now()) fail('pdf/proposal-expired', 'Annotation proposal expired before commit; preview it again')
      const value = await workspaces.execute(sessionId, { action: 'change', sessionId,
        id: proposal.documentId, revision: proposal.revision,
        expectedSourceHash: proposal.sourceDigest, operations: [proposal.operation] }, agent, signal)
      if (!isSnapshot(value)) fail('pdf/invalid-response', 'PDF change did not return a working copy')
      const result = { status: 'committed' as const, documentId: value.id, revision: value.revision,
        dirty: true as const, canUndo: value.canUndo, approval: 'user-questions-selected' as const }
      proposal.state = 'committed'; proposal.result = result
      return result
    } catch (error) {
      if (proposal.state === 'busy') proposal.state = 'rejected'
      throw error
    }
  }

  function checkProposal(snapshot: HostWorkspaceSnapshot, proposal: Proposal): void {
    checkRevision(snapshot, proposal.revision)
    if (snapshot.id !== proposal.documentId || snapshot.path !== proposal.path
      || snapshot.contentVersion !== proposal.contentVersion
      || snapshot.sourceVersion !== proposal.sourceVersion
      || evidenceSha256(snapshot.bytes) !== proposal.sourceDigest) {
      fail('pdf/stale-proposal', 'The PDF source or working copy changed; preview the annotation again')
    }
  }

  async function save(sessionId: string, raw: { documentId: string; expectedRevision: number },
    agent: WorkingCopyAgent, signal: AbortSignal,
    review: (details: ModelWriteReview) => Promise<boolean>) {
    const assertOpen = () => {
      if (disposed) fail('pdf/write-unavailable', 'PDF model-write service has been disposed')
    }
    assertOpen()
    const input = modelSaveSchema.parse(raw)
    const initial = workspaces.readSnapshot(sessionId, input.documentId)
    checkRevision(initial, input.expectedRevision)
    if (!initial.dirty) return { status: 'no_changes' as const, documentId: initial.id,
      revision: initial.revision, dirty: false as const }
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

  return { preview, commit, save, dispose() { disposed = true; proposals.clear() } }
}

function isSnapshot(value: unknown): value is HostWorkspaceSnapshot {
  return !!value && typeof value === 'object' && 'bytes' in value && 'revision' in value && 'id' in value
}
