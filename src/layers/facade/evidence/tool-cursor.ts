import { z } from 'zod'

const identity = {
  version: z.literal(1), sessionId: z.string().min(1).max(512),
  documentId: z.string().min(1).max(512), contentVersion: z.string().min(1).max(512),
  revision: z.number().int().nonnegative(), sourceDigest: z.string().min(1).max(128),
  queryHash: z.string().min(1).max(128),
}
const cursorSchema = z.discriminatedUnion('kind', [
  z.object({ ...identity, kind: z.literal('search'), page: z.number().int().min(1),
    offset: z.number().int().nonnegative() }).strict(),
  z.object({ ...identity, kind: z.literal('bookmarks'), offset: z.number().int().nonnegative() }).strict(),
])

export type ToolCursor = z.infer<typeof cursorSchema>
export type ToolCursorIdentity = Pick<ToolCursor,
  'kind' | 'sessionId' | 'documentId' | 'contentVersion' | 'revision' | 'sourceDigest' | 'queryHash'>

/** A continuation is a versioned locator, never authorization to access another document. */
export function encodeToolCursor(value: ToolCursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function decodeToolCursor(value: string): ToolCursor {
  try {
    if (value.length > 4096) throw new Error('Cursor too long')
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw new Error('Non-canonical cursor')
    return cursorSchema.parse(JSON.parse(decoded.toString('utf8')) as unknown)
  } catch {
    throw Object.assign(new Error('Invalid PDF cursor; restart from the first window'),
      { code: 'pdf/invalid-window' })
  }
}

export function assertToolCursorIdentity(cursor: ToolCursor, expected: ToolCursorIdentity): void {
  if (cursor.kind !== expected.kind || cursor.sessionId !== expected.sessionId
    || cursor.documentId !== expected.documentId || cursor.contentVersion !== expected.contentVersion
    || cursor.revision !== expected.revision || cursor.sourceDigest !== expected.sourceDigest
    || cursor.queryHash !== expected.queryHash) {
    throw Object.assign(new Error('PDF cursor does not match this query or document version; restart the list'),
      { code: 'pdf/stale-reader' })
  }
}
