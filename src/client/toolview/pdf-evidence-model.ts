import { z } from 'zod'

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const locator = z.object({ kind: z.literal('text-window'), startUtf16: z.number().int().nonnegative(),
  endUtf16: z.number().int().nonnegative() }).passthrough()
const excerpt = z.object({ text: z.string().max(8_000), sha256: digest,
  truncated: z.boolean().optional() }).passthrough()
const evidence = z.object({ documentId: z.string().min(1).max(512), sourcePath: z.string().min(1).max(512),
  sourcePathDigest: digest.optional(),
  sourceDigest: digest, pageTextDigest: digest.optional(), contentVersion: z.string().min(1).max(512), revision: z.number().int().nonnegative(),
  page: z.number().int().positive(), locator, snapshot: excerpt }).passthrough()
const common = z.object({ kind: z.literal('pdf-evidence-snapshot'), version: z.literal(1),
  documentId: z.string().min(1).max(512), status: z.string().max(80) })
const readPage = common.extend({ tool: z.enum(['pdf_page_read', 'pdf_read_page']), sourcePath: z.string().min(1).max(512),
  sourcePathDigest: digest.optional(),
  sourceDigest: digest, pageTextDigest: digest.optional(), contentVersion: z.string().min(1).max(512), revision: z.number().int().nonnegative(),
  page: z.number().int().positive(), locator, snapshot: excerpt }).passthrough()
const locate = common.extend({ tool: z.enum(['pdf_keyword_search', 'pdf_locate']), matches: z.array(evidence).max(20) }).passthrough()
const context = common.extend({ tool: z.enum(['pdf_evidence_read', 'pdf_context']), chunks: z.array(evidence).max(10),
  candidates: z.array(evidence).max(5) }).passthrough()

export type PdfEvidenceEntry = z.infer<typeof evidence>
export interface PdfEvidenceCardModel {
  tool: 'pdf_page_read' | 'pdf_keyword_search' | 'pdf_evidence_read' | 'pdf_read_page' | 'pdf_locate' | 'pdf_context'
  status: string
  documentId: string
  entries: PdfEvidenceEntry[]
}

/** Persisted presentation data is display-only; never a navigation capability. */
export function pdfEvidenceCardModel(toolName: string, meta: unknown): PdfEvidenceCardModel | null {
  // The three old names are display-only session-log formats, not live tools.
  const parsed = ['pdf_page_read', 'pdf_read_page'].includes(toolName) ? readPage.safeParse(meta)
    : ['pdf_keyword_search', 'pdf_locate'].includes(toolName) ? locate.safeParse(meta)
      : ['pdf_evidence_read', 'pdf_context'].includes(toolName) ? context.safeParse(meta) : null
  if (!parsed?.success) return null
  const value = parsed.data
  if (value.tool !== toolName || value.tool === 'pdf_locate' && 'matches' in value
    && (value.matches as unknown[]).length > 5) return null
  const entries = value.tool === 'pdf_read_page' || value.tool === 'pdf_page_read' ? [value as z.infer<typeof readPage>]
    : value.tool === 'pdf_locate' || value.tool === 'pdf_keyword_search' ? (value as z.infer<typeof locate>).matches
      : [...(value as z.infer<typeof context>).chunks, ...(value as z.infer<typeof context>).candidates]
  if (entries.some(entry => entry.documentId !== value.documentId
    || entry.locator.endUtf16 < entry.locator.startUtf16
    || entry.locator.endUtf16 - entry.locator.startUtf16 < entry.snapshot.text.length
    || !entry.snapshot.truncated
      && entry.locator.endUtf16 - entry.locator.startUtf16 !== entry.snapshot.text.length)) return null
  return { tool: value.tool, status: value.status, documentId: value.documentId,
    entries: entries.map(entry => ({ ...entry, locator: entry.locator, snapshot: entry.snapshot })) }
}
