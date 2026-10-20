import { z } from 'zod'
import { joinPageText } from '../../shared/page-text.js'
import type { WorkingCopyReadPort } from '../working-copy/index.js'
import type { AgentPageReadPort } from './agent-page-read.js'
import { evidenceSha256 } from './provenance.js'
import { assertFreshSource, type FreshSourceRead } from './source-freshness.js'

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)

/** An old tool card is evidence to verify, never an authorization token. */
export const evidenceNavigationRequestSchema = z.object({
  action: z.literal('revalidate'),
  sessionId: z.string().min(1).max(512),
  documentId: z.string().min(1).max(512),
  sourcePathDigest: digest,
  page: z.number().int().min(1).max(100_000),
  pageTextDigest: digest,
  startUtf16: z.number().int().nonnegative(),
  endUtf16: z.number().int().nonnegative(),
  excerpt: z.string().min(1).max(8_000),
  excerptSha256: digest,
}).strict().refine(value => value.endUtf16 - value.startUtf16 === value.excerpt.length,
  'Evidence window must exactly span its excerpt')
export type EvidenceNavigationRequest = z.infer<typeof evidenceNavigationRequestSchema>

function stale(message: string): never {
  throw Object.assign(new Error(message), { code: 'pdf/stale-reader' })
}

/** Reauthorize the current working copy and compare the *whole* page text.
 * Annotation-only saves may change PDF bytes without invalidating the text.
 */
export async function revalidateEvidenceNavigation(workspaces: WorkingCopyReadPort,
  pages: AgentPageReadPort, request: EvidenceNavigationRequest, signal: AbortSignal,
  readSource: FreshSourceRead) {
  signal.throwIfAborted()
  const { sessionId, documentId, page } = request
  const before = workspaces.readSnapshot(sessionId, documentId)
  await assertFreshSource(sessionId, before, readSource, signal)
  if (evidenceSha256(before.path) !== request.sourcePathDigest) {
    return stale('The visible PDF no longer has the referenced source path')
  }
  if (page > before.document.pageCount) return stale('Referenced PDF page no longer exists')
  const read = await pages.readPageText(sessionId, documentId, page, signal)
  signal.throwIfAborted()
  const after = workspaces.readSnapshot(sessionId, documentId)
  const sameSnapshot = (candidate: typeof before) => candidate.id === before.id
    && candidate.path === before.path && candidate.contentVersion === before.contentVersion
    && candidate.revision === before.revision && candidate.sourceVersion === before.sourceVersion
    && evidenceSha256(candidate.bytes) === evidenceSha256(before.bytes)
  if (!sameSnapshot(read.snapshot) || !sameSnapshot(after)) {
    return stale('PDF changed while checking the reference; retry')
  }
  await assertFreshSource(sessionId, after, readSource, signal)
  const text = joinPageText(read.content.items)
  if (evidenceSha256(text) !== request.pageTextDigest
    || evidenceSha256(request.excerpt) !== request.excerptSha256
    || text.slice(request.startUtf16, request.endUtf16) !== request.excerpt) {
    return stale('Referenced page text changed; locate the quote again')
  }
  return { status: 'valid' as const, documentId: before.id, page,
    sourceDigest: evidenceSha256(before.bytes), sourceVersion: before.sourceVersion,
    contentVersion: before.contentVersion, revision: before.revision }
}
