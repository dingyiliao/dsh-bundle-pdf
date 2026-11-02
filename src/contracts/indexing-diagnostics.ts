import { z } from 'zod'

export const PDF_INDEXING_DIAGNOSTICS_METHOD = 'pdf.indexing.diagnostics'
export const indexingDiagnosticsRequestSchema = z.object({
  action: z.enum(['report', 'open']),
  sessionId: z.string().min(1).max(512), documentId: z.string().min(1).max(512),
  occurrence: z.number().int().positive(),
}).strict()
/** The report is a copyable JSON document; log contents are never sent to the model. */
export const indexingDiagnosticsResultSchema = z.object({
  directory: z.string().min(1).max(4096), report: z.string().min(1).max(256 * 1024), canOpen: z.boolean(),
}).strict()
export type PdfIndexingDiagnostics = z.infer<typeof indexingDiagnosticsResultSchema>
