import { z } from 'zod'
import type { PdfAnnotation } from '../../core/pdf-types.js'
import type { NativeTextContent } from '../../shared/native.js'
import { annotationExcerpt } from '../../shared/annotation-excerpt.js'
import { joinPageText } from '../../shared/page-text.js'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../working-copy/index.js'
import { findExactInPage } from '../search/index.js'
import { windowPageText } from './text-window.js'
import { evidenceSha256 } from './provenance.js'
import { assertToolCursorIdentity, decodeToolCursor, encodeToolCursor } from './tool-cursor.js'
import { rememberTextEvidence } from './text-evidence.js'
import type { EvidenceReferenceStore, PdfTextEvidence } from './reference-store.js'

export interface AgentPageReadPort {
  readPageText(sessionId: string, documentId: string, page: number, signal: AbortSignal,
    options?: { recover?: boolean }): Promise<{
    snapshot: HostWorkspaceSnapshot; content: NativeTextContent
  }>
}

const MAX_SEARCH_OUTPUT_CHARS = 64_000

function stale(message: string): never {
  throw Object.assign(new Error(message), { code: 'pdf/stale-reader' })
}

function sameRevision(left: HostWorkspaceSnapshot, right: HostWorkspaceSnapshot): boolean {
  return left.contentVersion === right.contentVersion && left.revision === right.revision
}

/** Bounded joined-text read; no DSH Context or tool protocol enters this module. */
export async function readPageWindow(workspaces: WorkingCopyReadPort, pages: AgentPageReadPort,
  sessionId: string, documentId: string, page: number, offset: number | undefined,
  maxChars: number | undefined, signal: AbortSignal) {
  const { snapshot, content } = await pages.readPageText(sessionId, documentId, page, signal)
  if (!sameRevision(snapshot, workspaces.readSnapshot(sessionId, documentId))) stale('PDF changed while reading page text; retry')
  const extracted = joinPageText(content.items)
  const text = extracted.trim() ? extracted : ''
  return { status: text ? 'ok' : 'no_text', documentId: snapshot.id, path: snapshot.path,
    page, pageCount: snapshot.document.pageCount, revision: snapshot.revision,
    contentVersion: snapshot.contentVersion, sourceVersion: snapshot.sourceVersion,
    sourceDigest: evidenceSha256(snapshot.bytes), pageTextDigest: evidenceSha256(text),
    ...(content.extraction ? { extraction: content.extraction, limitations: content.warnings ?? [] } : {}),
    ...windowPageText(text, offset, maxChars) }
}

/** Exact/case-sensitive model search, with continuations fenced to one query and PDF version. */
export async function searchPageWindows(workspaces: WorkingCopyReadPort, pages: AgentPageReadPort,
  sessionId: string, documentId: string,
  input: { query: string; fromPage?: number; offset?: number; cursor?: string }, signal: AbortSignal,
  references?: EvidenceReferenceStore) {
  signal.throwIfAborted()
  const snapshot = workspaces.readSnapshot(sessionId, documentId)
  if (input.cursor !== undefined && (input.fromPage !== undefined || input.offset !== undefined)) {
    throw Object.assign(new Error('Continue with cursor and the same query only; omit fromPage and offset'),
      { code: 'pdf/invalid-window' })
  }
  const identity = { kind: 'search' as const, sessionId, documentId: snapshot.id,
    contentVersion: snapshot.contentVersion, revision: snapshot.revision, sourceDigest: evidenceSha256(snapshot.bytes),
    queryHash: evidenceSha256(JSON.stringify({ query: input.query, exact: true, caseSensitive: true,
      maxPages: 10, maxMatches: 20 })) }
  const previous = input.cursor === undefined ? undefined : decodeToolCursor(input.cursor)
  if (previous) assertToolCursorIdentity(previous, identity)
  const startPage = previous?.kind === 'search' ? previous.page : input.fromPage ?? 1
  const startOffset = previous?.offset ?? input.offset ?? 0
  if (!Number.isSafeInteger(startPage) || startPage < 1 || startPage > snapshot.document.pageCount) {
    throw Object.assign(new Error('Page is outside the document'), { code: 'pdf/invalid-page' })
  }
  const ensureCurrent = (current: HostWorkspaceSnapshot) => {
    if (current.id !== snapshot.id || !sameRevision(snapshot, current)
      || current.bytes !== snapshot.bytes && evidenceSha256(current.bytes) !== identity.sourceDigest) {
      stale('PDF changed while searching; retry from the current version')
    }
  }
  const continuation = (page: number, offset: number) => encodeToolCursor({ version: 1, ...identity, page, offset })
  const response = (throughPage: number, nextCursor: string | null) => {
    signal.throwIfAborted()
    ensureCurrent(workspaces.readSnapshot(sessionId, documentId))
    return { documentId: snapshot.id, path: snapshot.path, pageCount: snapshot.document.pageCount,
      revision: snapshot.revision, contentVersion: snapshot.contentVersion, fromPage: startPage, throughPage,
      matches, noTextPages, ...(ocrRepairedPages.length ? { ocrRepairedPages } : {}), nextCursor }
  }
  const throughPage = Math.min(snapshot.document.pageCount, startPage + 9)
  const matches: { page: number; offset: number; excerpt: string; evidence?: PdfTextEvidence }[] = []
  const noTextPages: number[] = []
  const ocrRepairedPages: number[] = []
  for (let current = startPage; current <= throughPage; current++) {
    signal.throwIfAborted()
    const read = await pages.readPageText(sessionId, documentId, current, signal)
    signal.throwIfAborted()
    ensureCurrent(read.snapshot)
    const pageText = joinPageText(read.content.items)
    if (read.content.extraction === 'local-ocr') ocrRepairedPages.push(current)
    if (!pageText.trim()) noTextPages.push(current)
    const start = current === startPage ? startOffset : 0
    if (start > pageText.length) throw Object.assign(new Error('Search offset is outside the page'), { code: 'pdf/invalid-window' })
    const found = findExactInPage(pageText, input.query, start, 20 - matches.length)
    for (const match of found.matches) {
      const evidence = references ? await rememberTextEvidence(references, sessionId, snapshot, current,
        pageText, match.offset, match.endOffset, read.content, identity.sourceDigest) : undefined
      signal.throwIfAborted()
      ensureCurrent(workspaces.readSnapshot(sessionId, documentId))
      const candidate = { page: current, offset: match.offset, excerpt: match.excerpt, ...(evidence ? { evidence } : {}) }
      // Full provenance can be larger than the short search excerpt. Resume at the omitted
      // match, not at the end of the native search batch; always emit one item for progress.
      if (matches.length && JSON.stringify({ path: snapshot.path, matches: [...matches, candidate], noTextPages,
        ocrRepairedPages }).length > MAX_SEARCH_OUTPUT_CHARS) {
        return response(current, continuation(current, match.offset))
      }
      matches.push(candidate)
    }
    if (matches.length === 20) {
      const nextOffset = found.nextOffset ?? pageText.length
      return response(current, nextOffset < pageText.length ? continuation(current, nextOffset)
        : current < snapshot.document.pageCount ? continuation(current + 1, 0) : null)
    }
  }
  return response(throughPage, throughPage < snapshot.document.pageCount ? continuation(throughPage + 1, 0) : null)
}

/** Navigation and form entries are not the markup a reader means by an annotation. */
const nonMarkupSubtypes = new Set(['Link', 'Popup', 'Widget'])
const excerptSubtypes = new Set(['Highlight', 'Underline', 'StrikeOut'])

export type PageAnnotation = {
  id: string; idTruncated?: true; subtype: string; truncatedFields?: string[]
  replyToId?: string
  color?: number[]; opacity?: number; contents?: string; author?: string; createdAt?: string; modifiedAt?: string
  draft?: true; readOnly?: true; excerpt?: string
}

const cursorSchema = z.object({ documentId: z.string().min(1).max(512),
  page: z.number().int().min(1).max(100000), revision: z.number().int().nonnegative(),
  contentVersion: z.string().min(1).max(512), offset: z.number().int().nonnegative() }).strict()
const MAX_OUTPUT_CHARS = 30_000

function makeCursor(value: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function parseCursor(value: string): z.infer<typeof cursorSchema> {
  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw new Error('Non-canonical cursor')
    return cursorSchema.parse(JSON.parse(decoded.toString('utf8')) as unknown)
  } catch {
    throw Object.assign(new Error('Invalid annotation cursor; restart from the first page of results'),
      { code: 'pdf/invalid-window' })
  }
}

function boundedField(value: string, maxChars: number): { text: string; truncated: boolean } {
  const window = windowPageText(value, 0, maxChars)
  return { text: window.text, truncated: window.truncated }
}

function draftOf(annotation: PdfAnnotation, baseline: Map<string, PdfAnnotation>): true | undefined {
  const stored = baseline.get(annotation.id)
  if (!stored) return true
  const sameColor = (stored.color ?? []).join() === (annotation.color ?? []).join()
  return stored.contents === annotation.contents && sameColor ? undefined : true
}

/** Session-owned, revision-bound annotation listing, including unsaved reader projection. */
export async function listPageAnnotations(workspaces: WorkingCopyReadPort, pages: AgentPageReadPort,
  sessionId: string, documentId: string, page: number, cursorToken: string | undefined,
  limit: number | undefined, signal: AbortSignal) {
  const snapshot = workspaces.readSnapshot(sessionId, documentId)
  if (page > snapshot.document.pageCount) {
    throw Object.assign(new Error('Page is outside the document'), { code: 'pdf/invalid-page' })
  }
  const previous = cursorToken === undefined ? undefined : parseCursor(cursorToken)
  if (previous && (previous.documentId !== documentId || previous.page !== page
    || previous.revision !== snapshot.revision || previous.contentVersion !== snapshot.contentVersion)) {
    stale('PDF changed since this annotation cursor was issued; restart the list')
  }
  const baseline = new Map((snapshot.baselineAnnotations ?? []).map(annotation => [annotation.id, annotation]))
  const onPage = snapshot.document.annotations
    .filter(annotation => annotation.page === page && !nonMarkupSubtypes.has(annotation.subtype))
    .sort((left, right) => left.id.localeCompare(right.id))
  const cursor = previous?.offset ?? 0
  if (cursor > onPage.length) throw Object.assign(new Error('Annotation cursor is outside the list'), { code: 'pdf/invalid-window' })
  const end = Math.min(onPage.length, cursor + (limit ?? 30))
  const candidates = onPage.slice(cursor, end)
  let content: NativeTextContent | undefined
  if (candidates.some(annotation => excerptSubtypes.has(annotation.subtype))) {
    const read = await pages.readPageText(sessionId, documentId, page, signal)
    if (!sameRevision(snapshot, read.snapshot)) stale('PDF changed while reading annotations; retry')
    content = read.content
  }
  if (!sameRevision(snapshot, workspaces.readSnapshot(sessionId, documentId))) stale('PDF changed while reading annotations; retry')

  const path = boundedField(snapshot.path, 512)
  const base = { documentId: snapshot.id, path: path.text,
    ...(path.truncated ? { pathTruncated: true as const } : {}),
    page, pageCount: snapshot.document.pageCount,
    revision: snapshot.revision, contentVersion: snapshot.contentVersion, total: onPage.length }
  const nextCursor = (offset: number): string | null => offset < onPage.length
    ? makeCursor({ documentId, page, revision: snapshot.revision, contentVersion: snapshot.contentVersion, offset }) : null
  const annotations: PageAnnotation[] = []
  for (const [index, annotation] of candidates.entries()) {
    const excerpt = content && excerptSubtypes.has(annotation.subtype)
      ? annotationExcerpt(annotation, content) : undefined
    const id = boundedField(annotation.id, 512)
    const subtype = boundedField(annotation.subtype, 80)
    const replyToId = annotation.replyToId === undefined ? undefined : boundedField(annotation.replyToId, 512)
    const contents = annotation.contents === undefined ? undefined : boundedField(annotation.contents, 1000)
    const author = annotation.author === undefined ? undefined : boundedField(annotation.author, 160)
    const createdAt = annotation.createdAt === undefined ? undefined : boundedField(annotation.createdAt, 80)
    const modifiedAt = annotation.modifiedAt === undefined ? undefined : boundedField(annotation.modifiedAt, 80)
    const truncatedFields = [id.truncated && 'id', subtype.truncated && 'subtype',
      replyToId?.truncated && 'replyToId',
      contents?.truncated && 'contents', author?.truncated && 'author',
      createdAt?.truncated && 'createdAt', modifiedAt?.truncated && 'modifiedAt']
      .filter((field): field is string => typeof field === 'string')
    const item: PageAnnotation = { id: id.text, subtype: subtype.text,
      ...(replyToId ? { replyToId: replyToId.text } : {}),
      ...(id.truncated ? { idTruncated: true as const } : {}),
      ...(truncatedFields.length ? { truncatedFields } : {}),
      ...(annotation.color ? { color: annotation.color.map(channel => Math.round(channel * 255)) } : {}),
      ...(annotation.opacity !== undefined ? { opacity: annotation.opacity } : {}),
      ...(contents ? { contents: contents.text } : {}),
      ...(author ? { author: author.text } : {}),
      ...(createdAt ? { createdAt: createdAt.text } : {}),
      ...(modifiedAt ? { modifiedAt: modifiedAt.text } : {}),
      ...(draftOf(annotation, baseline) ? { draft: true as const } : {}),
      ...(annotation.editable && annotation.supported ? {} : { readOnly: true as const }),
      ...(excerpt ? { excerpt } : {}) }
    const offset = cursor + index + 1
    const proposed = { ...base, annotations: [...annotations, item], nextCursor: nextCursor(offset) }
    if (JSON.stringify(proposed).length > MAX_OUTPUT_CHARS) break
    annotations.push(item)
  }
  return { ...base, annotations, nextCursor: nextCursor(cursor + annotations.length) }
}
