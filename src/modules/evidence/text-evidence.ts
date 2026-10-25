import { randomUUID } from 'node:crypto'
import type { HostWorkspaceSnapshot } from '../working-copy/index.js'
import type { NativeTextContent } from '../../shared/native.js'
import { approximateTextRects } from './geometry.js'
import { evidenceSha256 } from './provenance.js'
import type { EvidenceReferenceStore, PdfTextEvidence } from './reference-store.js'

/** Shared capture for search, locate, context and replay. Approximate boxes remain read-only hints. */
export function createTextEvidence(snapshot: HostWorkspaceSnapshot, page: number, text: string,
  startUtf16: number, endUtf16: number, content?: NativeTextContent,
  sourceDigest = evidenceSha256(snapshot.bytes)): PdfTextEvidence {
  const excerpt = text.slice(startUtf16, endUtf16)
  const rects = content && approximateTextRects(content, snapshot.document.pages?.[page - 1], startUtf16, endUtf16)
  return { refId: `pdfref_${randomUUID()}`, documentId: snapshot.id,
    sourcePath: snapshot.path, sourceDigest, sourceVersion: snapshot.sourceVersion,
    contentVersion: snapshot.contentVersion, revision: snapshot.revision, page, source: 'pdf-text',
    ...(content?.extraction ? { extraction: content.extraction } : {}),
    pageTextDigest: evidenceSha256(text), snapshot: { text: excerpt, sha256: evidenceSha256(excerpt) },
    locator: { kind: 'text-window', startUtf16, endUtf16, ...(rects ? { rectsPdf: rects } : {}) },
    precision: rects ? 'approximate-geometry' : 'exact-text',
    limitations: [...(content?.warnings ?? []), ...(rects
      ? ['PDF-space boxes approximate selection bounds from glyph origins; they are not exact painted outlines.']
      : ['Text offsets refer to joined page text; visual PDF coordinates are not verified.'])].slice(0, 8) }
}

export async function rememberTextEvidence(references: EvidenceReferenceStore, sessionId: string,
  snapshot: HostWorkspaceSnapshot, page: number, text: string, startUtf16: number, endUtf16: number,
  content?: NativeTextContent, sourceDigest?: string): Promise<PdfTextEvidence> {
  const evidence = createTextEvidence(snapshot, page, text, startUtf16, endUtf16, content, sourceDigest)
  await references.put(evidence.refId, { sessionId, evidence, pageTextDigest: evidenceSha256(text), createdAt: Date.now() })
  return evidence
}
