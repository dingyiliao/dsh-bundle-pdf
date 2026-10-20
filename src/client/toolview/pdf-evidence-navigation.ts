import type { WorkspaceSnapshot } from '../../shared/contracts.js'
import type { PdfEvidenceEntry } from './pdf-evidence-model.js'

export interface VisiblePdfReader {
  sessionId: string
  snapshot: WorkspaceSnapshot
  /** Must return null when the tab or this exact snapshot is no longer visible. */
  current(): WorkspaceSnapshot | null
  readPageText(page: number, signal: AbortSignal): Promise<string>
  jump(page: number): Promise<boolean>
}

export type EvidenceNavigationResult = 'opened' | 'stale' | 'unavailable'
export interface PdfEvidenceNavigation {
  subscribe(listener: () => void): () => void
  getRevision(): number
  register(reader: VisiblePdfReader): () => void
  canNavigate(sessionId: string, evidence: PdfEvidenceEntry): boolean
  navigate(sessionId: string, evidence: PdfEvidenceEntry, signal: AbortSignal): Promise<EvidenceNavigationResult>
}

export interface EvidenceRevalidationRequest {
  action: 'revalidate'
  sessionId: string
  documentId: string
  sourcePathDigest: string
  page: number
  pageTextDigest: string
  startUtf16: number
  endUtf16: number
  excerpt: string
  excerptSha256: string
}

export interface EvidenceRevalidationResult {
  status: 'valid'
  documentId: string
  page: number
  sourceDigest: string
  sourceVersion: string
  contentVersion: string
  revision: number
}

export type RevalidateEvidence = (request: EvidenceRevalidationRequest, signal: AbortSignal) => Promise<EvidenceRevalidationResult>

function isCurrentResult(current: WorkspaceSnapshot, page: number, result: EvidenceRevalidationResult): boolean {
  return result.status === 'valid' && result.documentId === current.id && result.page === page
    && result.sourceDigest === current.reader.bytesHash && result.sourceVersion === current.sourceVersion
    && result.contentVersion === current.contentVersion && result.revision === current.revision
}

async function pageStillMatches(evidence: PdfEvidenceEntry, pageText: string,
  hashText: (text: string) => Promise<string>): Promise<boolean> {
  const { startUtf16, endUtf16 } = evidence.locator
  const excerpt = evidence.snapshot.text
  return endUtf16 >= startUtf16 && endUtf16 <= pageText.length
    && pageText.slice(startUtf16, startUtf16 + excerpt.length) === excerpt
    && await hashText(excerpt) === evidence.snapshot.sha256
    && await hashText(pageText) === evidence.pageTextDigest
}

async function browserSha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** A historical card navigates only after the Host reauthorizes the current
 * document and verifies the full page text; the Client then checks its own
 * visible Reader lease and page text before jumping. */
export function createPdfEvidenceNavigation(revalidate: RevalidateEvidence,
  hashText = browserSha256): PdfEvidenceNavigation {
  const readers = new Map<symbol, { reader: VisiblePdfReader; pathDigest?: string }>()
  const listeners = new Set<() => void>()
  let revision = 0
  const notify = () => { revision++; listeners.forEach(listener => listener()) }
  const matches = (entry: { reader: VisiblePdfReader; pathDigest?: string }, sessionId: string, evidence: PdfEvidenceEntry) => {
    const { reader } = entry
    const snapshot = reader.current()
    if (!snapshot) return false
    // The old source bytes may differ after an annotation-only save. We do not
    // infer equivalence here: the authenticated Host check is required on click.
    return evidence.snapshot.text.length > 0 && !!evidence.pageTextDigest && !!evidence.sourcePathDigest
      && reader.sessionId === sessionId && snapshot === reader.snapshot
      && entry.pathDigest === evidence.sourcePathDigest
      && evidence.page <= snapshot.document.pageCount
  }
  const matchingReader = (sessionId: string, evidence: PdfEvidenceEntry) =>
    [...readers.values()].reverse().find(entry => matches(entry, sessionId, evidence))
  const stillVisible = (entry: { reader: VisiblePdfReader; pathDigest?: string },
    sessionId: string, evidence: PdfEvidenceEntry) => entry.reader.current() === entry.reader.snapshot
      && matches(entry, sessionId, evidence)
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getRevision: () => revision,
    register(reader) {
      const key = Symbol('visible-pdf-reader')
      const entry = { reader, pathDigest: undefined as string | undefined }
      readers.set(key, entry)
      notify()
      void hashText(reader.snapshot.path).then(pathDigest => {
        if (readers.get(key) !== entry) return
        entry.pathDigest = pathDigest
        notify()
      }).catch(() => { /* A missing hash leaves long-path navigation disabled. */ })
      return () => { if (readers.delete(key)) notify() }
    },
    canNavigate: (sessionId, evidence) => !!matchingReader(sessionId, evidence),
    async navigate(sessionId, evidence, signal) {
      const entry = matchingReader(sessionId, evidence)
      if (!entry) return 'unavailable'
      const { reader } = entry
      try {
        signal.throwIfAborted()
        const current = reader.snapshot
        const { startUtf16, endUtf16 } = evidence.locator
        const excerpt = evidence.snapshot.text
        const boundedEnd = startUtf16 + excerpt.length
        if (!evidence.sourcePathDigest || !evidence.pageTextDigest || endUtf16 < boundedEnd
          || await hashText(current.path) !== evidence.sourcePathDigest) return 'stale'
        signal.throwIfAborted()
        const validated = await revalidate({ action: 'revalidate', sessionId, documentId: current.id,
          sourcePathDigest: evidence.sourcePathDigest, page: evidence.page,
          pageTextDigest: evidence.pageTextDigest, startUtf16, endUtf16: boundedEnd,
          excerpt, excerptSha256: evidence.snapshot.sha256 }, signal)
        signal.throwIfAborted()
        if (!stillVisible(entry, sessionId, evidence)
          || !isCurrentResult(current, evidence.page, validated)) return 'stale'
        const pageText = await reader.readPageText(evidence.page, signal)
        signal.throwIfAborted()
        if (!stillVisible(entry, sessionId, evidence)
          || !await pageStillMatches(evidence, pageText, hashText)) return 'stale'
        signal.throwIfAborted()
        if (!stillVisible(entry, sessionId, evidence)) return 'stale'
        return await reader.jump(evidence.page) ? 'opened' : 'unavailable'
      } catch {
        return signal.aborted ? 'unavailable' : 'stale'
      }
    },
  }
}
