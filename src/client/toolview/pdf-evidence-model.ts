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
const readPage = common.extend({ tool: z.literal('pdf_read_page'), sourcePath: z.string().min(1).max(512),
  sourcePathDigest: digest.optional(),
  sourceDigest: digest, pageTextDigest: digest.optional(), contentVersion: z.string().min(1).max(512), revision: z.number().int().nonnegative(),
  page: z.number().int().positive(), locator, snapshot: excerpt }).passthrough()
const locate = common.extend({ tool: z.literal('pdf_locate'), matches: z.array(evidence).max(5) }).passthrough()
const context = common.extend({ tool: z.literal('pdf_context'), chunks: z.array(evidence).max(10),
  candidates: z.array(evidence).max(5) }).passthrough()

export type PdfEvidenceEntry = z.infer<typeof evidence>
export interface PdfEvidenceCardModel {
  tool: 'pdf_read_page' | 'pdf_locate' | 'pdf_context'
  status: string
  documentId: string
  entries: PdfEvidenceEntry[]
}

/** Persisted presentation data is display-only; never a navigation capability. */
export function pdfEvidenceCardModel(toolName: string, meta: unknown): PdfEvidenceCardModel | null {
  const parsed = toolName === 'pdf_read_page' ? readPage.safeParse(meta)
    : toolName === 'pdf_locate' ? locate.safeParse(meta)
      : toolName === 'pdf_context' ? context.safeParse(meta) : null
  if (!parsed?.success) return null
  const value = parsed.data
  const entries = value.tool === 'pdf_read_page' ? [value]
    : value.tool === 'pdf_locate' ? value.matches : [...value.chunks, ...value.candidates]
  if (entries.some(entry => entry.documentId !== value.documentId
    || entry.locator.endUtf16 < entry.locator.startUtf16
    || entry.locator.endUtf16 - entry.locator.startUtf16 < entry.snapshot.text.length
    || !entry.snapshot.truncated
      && entry.locator.endUtf16 - entry.locator.startUtf16 !== entry.snapshot.text.length)) return null
  return { tool: value.tool, status: value.status, documentId: value.documentId,
    entries: entries.map(entry => ({ ...entry, locator: entry.locator, snapshot: entry.snapshot })) }
}
