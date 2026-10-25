import type { NativeOutlineItem } from '../../shared/native.js'
import { windowPageText, evidenceSha256, assertToolCursorIdentity, decodeToolCursor,
  encodeToolCursor } from '../evidence/index.js'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../working-copy/index.js'

export type BookmarkSummary = {
  key: string; title: string; page: number | null
  depth: number; children: number
  externalLink?: boolean; titleTruncated?: boolean
  /** Stable PDF outline ID for draft editing; key retains its existing tree-path meaning. */
  outlineId?: string
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
    result.push({ key, title: title.text, page,
      ...(item.id ? { outlineId: item.id } : {}),
      depth, children: item.items.length, ...(item.url ? { externalLink: true } : {}),
      ...(title.truncated ? { titleTruncated: true } : {}) })
    for (let index = item.items.length - 1; index >= 0; index--) {
      stack.push({ item: item.items[index]!, key: `${key}/${index}`, depth: depth + 1 })
    }
  }
  return result
}

/** Read the current embedded outline with session and revision fencing. */
export async function listAgentBookmarks(workspaces: WorkingCopyReadPort, outlinePort: AgentOutlinePort,
  sessionId: string, documentId: string, cursor: string | undefined, limit: number | undefined, signal: AbortSignal) {
  signal.throwIfAborted()
  const snapshot = workspaces.readSnapshot(sessionId, documentId)
  const sourceDigest = evidenceSha256(snapshot.bytes)
  const outline = await outlinePort.readOutline(sessionId, documentId, signal)
  signal.throwIfAborted()
  const ensureCurrent = (current: HostWorkspaceSnapshot) => {
    if (current.id !== snapshot.id || current.contentVersion !== snapshot.contentVersion || current.revision !== snapshot.revision
      || current.bytes !== snapshot.bytes && evidenceSha256(current.bytes) !== sourceDigest) {
      throw Object.assign(new Error('PDF changed while reading bookmarks; retry'), { code: 'pdf/stale-reader' })
    }
  }
  ensureCurrent(outline.snapshot)
  const entries = summarizeOutline(outline.items ?? [], snapshot.document.pageCount)
  ensureCurrent(workspaces.readSnapshot(sessionId, documentId))
  const identity = { kind: 'bookmarks' as const, sessionId, documentId: snapshot.id,
    contentVersion: snapshot.contentVersion, revision: snapshot.revision, sourceDigest,
    // Native outline changes must not splice pages even if a provider fails to bump its revision.
    queryHash: evidenceSha256(JSON.stringify(entries)) }
  const previous = cursor === undefined ? undefined : decodeToolCursor(cursor)
  if (previous) assertToolCursorIdentity(previous, identity)
  const start = previous?.offset ?? 0
  if (start > entries.length) throw Object.assign(new Error('Bookmark cursor is outside the list'), { code: 'pdf/invalid-window' })
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) {
    throw Object.assign(new Error('Bookmark limit must be between 1 and 50'), { code: 'pdf/invalid-window' })
  }
  const end = Math.min(entries.length, start + (limit ?? 30))
  return { documentId: snapshot.id, path: snapshot.path, pageCount: snapshot.document.pageCount,
    revision: snapshot.revision, contentVersion: snapshot.contentVersion,
    total: entries.length, entries: entries.slice(start, end),
    nextCursor: end < entries.length ? encodeToolCursor({ version: 1, ...identity, offset: end }) : null }
}
