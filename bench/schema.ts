import { z } from 'zod'

export const metricsSchema = z.record(z.string(), z.number().finite().nonnegative().nullable())
export const rowSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1), iteration: z.number().int().nonnegative(),
  repeatCount: z.number().int().positive(), expectedRowCount: z.number().int().positive(),
  suite: z.enum(['smoke', 'release']), measurementKind: z.enum(['host-component', 'reader-component']),
  scenario: z.string().min(1), documentId: z.string().min(1), documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  pageCount: z.number().int().positive(), annotationCount: z.number().int().nonnegative(),
  seed: z.number().int(), cacheState: z.string(), qualityMode: z.string(),
  status: z.enum(['ok', 'error', 'timeout']), qualityPassed: z.boolean(),
  metrics: metricsSchema,
  error: z.string().nullable(),
  environment: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  source: z.object({ commit: z.string(), dirty: z.boolean(), treeSha256: z.string(), protocolSha256: z.string().regex(/^[a-f0-9]{64}$/), benchmarkVersion: z.literal('m0-v1') }),
  stages: z.array(z.object({ name: z.string(), clockDomain: z.string(), startMs: z.number(),
    durationMs: z.number().finite().nonnegative(), status: z.string(), attributes: z.record(z.string(), z.union([z.number(), z.boolean()])) })),
})
export type BenchmarkRow = z.infer<typeof rowSchema>

export const corpusSchema = z.object({
  schemaVersion: z.literal(1), generator: z.literal('dsh-pdf-synthetic-v1'), seed: z.number().int(),
  documents: z.array(z.object({ id: z.string(), file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(), pages: z.number().int().positive(), annotations: z.number().int().nonnegative(),
    origin: z.literal('synthetic'), license: z.literal('MIT'), features: z.array(z.string()) })).min(1),
})
export type Corpus = z.infer<typeof corpusSchema>
