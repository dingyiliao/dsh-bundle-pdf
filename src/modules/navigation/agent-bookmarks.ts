import type { PdfUserBookmark } from '../../shared/contracts.js'
import type { NativeOutlineItem } from '../../shared/native.js'
import { windowPageText } from '../evidence/index.js'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../working-copy/index.js'

export type BookmarkSummary = {
  kind: 'personal' | 'embedded'; key: string; title: string; page: number | null
  depth: number; children: number; stale?: PdfUserBookmark['stale']; updatedAt?: string
  externalLink?: boolean; titleTruncated?: boolean
}

export interface AgentOutlinePort {
  readOutline(sessionId: string, documentId: string, signal: AbortSignal): Promise<{
    snapshot: HostWorkspaceSnapshot; items: NativeOutlineItem[] | null
  }>
}

/** Flatten a bounded native outline without exposing unsafe URLs or raw destinations. */
export function summarizeOutline(items: readonly NativeOutlineItem[], pageCount: number): BookmarkSummary[] {
  const result: BookmarkSummary[] = []
  const stack = items.map((item, index) => ({ item, key: String(index), depth: 1 })).reverse()
  while (stack.length) {
    const { item, key, depth } = stack.pop()!
    const pageIndex = Array.isArray(item.dest) ? item.dest[0] : undefined
    const page = Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pageCount ? pageIndex + 1 : null
    const title = windowPageText(item.title, 0, 300)
    result.push({ kind: 'embedded', key, title: title.text, page,
      depth, children: item.items.length, ...(item.url ? { externalLink: true } : {}),
      ...(title.truncated ? { titleTruncated: true } : {}) })
    for (let index = item.items.length - 1; index >= 0; index--) {
      stack.push({ item: item.items[index]!, key: `${key}/${index}`, depth: depth + 1 })
    }
  }
  return result
}

/** One session-fenced list; the DSH adapter supplies the authorized personal-bookmark call. */
export async function listAgentBookmarks(workspaces: WorkingCopyReadPort, outlinePort: AgentOutlinePort,
  listPersonal: (sessionId: string, documentId: string, signal: AbortSignal) => Promise<PdfUserBookmark[]>,
  sessionId: string, documentId: string, kind: 'all' | 'personal' | 'embedded' | undefined,
  cursor: number | undefined, limit: number | undefined, signal: AbortSignal) {
  const snapshot = workspaces.readSnapshot(sessionId, documentId)
  const entries: BookmarkSummary[] = []
  if (kind !== 'embedded') {
    const personal = await listPersonal(sessionId, documentId, signal)
    entries.push(...personal.map(item => ({ kind: 'personal' as const, key: item.id,
      title: item.title, page: item.position.page, depth: 1, children: 0, stale: item.stale,
      updatedAt: item.updatedAt })))
  }
  if (kind !== 'personal') {
    const outline = await outlinePort.readOutline(sessionId, documentId, signal)
    if (outline.snapshot.contentVersion !== snapshot.contentVersion || outline.snapshot.revision !== snapshot.revision) {
      throw Object.assign(new Error('PDF changed while reading bookmarks; retry'), { code: 'pdf/stale-reader' })
    }
    entries.push(...summarizeOutline(outline.items ?? [], snapshot.document.pageCount))
  }
  const current = workspaces.readSnapshot(sessionId, documentId)
  if (current.contentVersion !== snapshot.contentVersion || current.revision !== snapshot.revision) {
    throw Object.assign(new Error('PDF changed while reading bookmarks; retry'), { code: 'pdf/stale-reader' })
  }
  const start = cursor ?? 0
  if (start > entries.length) throw Object.assign(new Error('Bookmark cursor is outside the list'), { code: 'pdf/invalid-window' })
  const end = Math.min(entries.length, start + (limit ?? 30))
  return { documentId: snapshot.id, path: snapshot.path, pageCount: snapshot.document.pageCount,
    revision: snapshot.revision, contentVersion: snapshot.contentVersion,
    total: entries.length, entries: entries.slice(start, end), nextCursor: end < entries.length ? end : null }
}
