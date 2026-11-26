import { z } from 'zod'

export const EMBEDDING_TEST_METHOD = 'pdf.embedding.test'
export const embeddingTestResultSchema = z.object({ status: z.enum(['available', 'disabled', 'not-configured', 'unavailable']) }).strict()
