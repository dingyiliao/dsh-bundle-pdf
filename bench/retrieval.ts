import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { EmbeddingRegistry, type EmbeddingBinding } from '../src/embedding/index.ts'
import { createOpenAiCompatibleEmbeddingEngine } from '../src/adapters/host/embedding/openai-compatible.ts'
import { rankRelatedText } from './legacy-related-text.ts'
import { chunkPage, RETRIEVAL_TEXT_VERSION, type RetrievalChunk } from '../src/modules/retrieval/text.ts'
import { createBm25Index, hybridCandidates, rankVectors, reciprocalRankFusion, searchBm25, type RankedChunk } from '../src/modules/retrieval/ranking.ts'
import { createRetrievalService, type RetrievalEmbedding, type RetrievalInput, type RetrievalPorts } from '../src/modules/retrieval/index.ts'
import { environmentMetadata } from './metadata.ts'
import { complexPageLimitations, retrievalCorpusVersion, retrievalPassages, retrievalQueries, type RetrievalQuery } from './retrieval-corpus.ts'

const { values } = parseArgs({ options: {
  'embedding-endpoint': { type: 'string' }, 'model-revision': { type: 'string', default: 'local' },
  'max-input-characters': { type: 'string', default: '16000' }, repeats: { type: 'string', default: '3' },
  out: { type: 'string' },
} })
const repeats = Number(values.repeats)
const maxInputCharacters = Number(values['max-input-characters'])
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('repeats must be 1..20')
if (!Number.isSafeInteger(maxInputCharacters) || maxInputCharacters < 64 || maxInputCharacters > 16000) throw new Error('max-input-characters must be 64..16000')

async function measure<T>(operation: () => T | Promise<T>) {
  const tickMs = 10
  let nextTick = performance.now() + tickMs
  let maximumLag = 0
  const ticker = setInterval(() => {
    const now = performance.now()
    maximumLag = Math.max(maximumLag, now - nextTick)
    nextTick = now + tickMs
  }, tickMs)
  const before = process.memoryUsage()
  const cpu = process.cpuUsage()
  const start = performance.now()
  let result: T
  try { result = await operation() } catch (error) { clearInterval(ticker); throw error }
  const durationMs = performance.now() - start
  const used = process.cpuUsage(cpu)
  const after = process.memoryUsage()
  await new Promise(resolve => setTimeout(resolve, 20))
  clearInterval(ticker)
  return { result, metrics: {
    durationMs, cpuMs: (used.user + used.system) / 1000,
    processCpuPercent: (used.user + used.system) / 1000 / Math.max(durationMs, 0.001) * 100,
    rssBytesAfter: after.rss, rssBytesDelta: after.rss - before.rss,
    heapBytesAfter: after.heapUsed, heapBytesDelta: after.heapUsed - before.heapUsed,
    eventLoopLagMaxMs: maximumLag,
  } }
}

function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null
  return { count: samples.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? null }
}

function relevance(query: RetrievalQuery, result: readonly string[]) {
  if (!query.relevant.length) return null
  const expected = new Set(query.relevant)
  const unique = [...new Set(result)]
  const found = unique.slice(0, 5).filter(id => expected.has(id)).length
  const rank = unique.slice(0, 5).findIndex(id => expected.has(id))
  const dcg = unique.slice(0, 5).reduce((score, id, index) => score + (expected.has(id) ? 1 / Math.log2(index + 2) : 0), 0)
  const ideal = Array.from({ length: Math.min(5, expected.size) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0)
  return { recallAt5: found / expected.size, hitAt1: expected.has(unique[0] ?? '') ? 1 : 0,
    reciprocalRankAt5: rank >= 0 ? 1 / (rank + 1) : 0, ndcgAt5: dcg / ideal }
}

type Method = 'legacy' | 'bm25' | 'semantic' | 'rrf' | 'shortlistRrf' | 'protectTop1' | 'hybrid'
type QueryResult = { queryId: string; kind: RetrievalQuery['kind']; query: string; relevant: readonly string[];
  results: Partial<Record<Method, { passageIds: string[]; metrics: ReturnType<typeof relevance> }>> }

const registry = new EmbeddingRegistry()
const binding: EmbeddingBinding | undefined = values['embedding-endpoint'] ? {
  engineId: 'local-qwen3-embedding', config: {
    endpoint: values['embedding-endpoint'], modelRevision: values['model-revision'], maxInputCharacters,
  },
} : undefined
if (binding) registry.register(createOpenAiCompatibleEmbeddingEngine())

try {
  // No backend probe is hidden in benchmark timing: first actual embedding is
  // measured below. An explicitly requested endpoint must succeed or this run fails.
  const model = binding ? registry.describe(binding) : undefined
  const preparation = await measure(() => {
    const chunks = retrievalPassages.flatMap((passage, index) => chunkPage(index + 1, passage.text, 'pdf-text', {
      maxCharacters: Math.min(1200, model?.maxInputCharacters ?? 1200),
    }))
    return { chunks, lexical: createBm25Index(chunks) }
  })
  const { chunks, lexical } = preparation.result
  const passageByChunk = new Map(chunks.map(chunk => [chunk.id, retrievalPassages[chunk.page - 1]!.id]))
  const identify = (ranked: readonly RankedChunk[]): string[] => [...new Set(ranked.map(hit => passageByChunk.get(hit.chunkId)!))]
  async function embed(texts: readonly string[], purpose: 'query' | 'document') {
    if (!binding || !model) throw new Error('Semantic benchmark requires a real embedding endpoint.')
    const vectors: number[][] = []
    for (let offset = 0; offset < texts.length; offset += model.maxBatchSize) {
      const result = await registry.embed({ texts: texts.slice(offset, offset + model.maxBatchSize), purpose }, binding)
      if (result.model.fingerprint !== model.fingerprint) throw new Error('Embedding model identity changed during the run.')
      vectors.push(...result.vectors)
    }
    return vectors
  }
  const documentEmbedding = binding ? await measure(() => embed(chunks.map(chunk => chunk.text), 'document')) : undefined
  const vectors = documentEmbedding?.result.map((vector, index) => ({ chunkId: chunks[index]!.id, vector }))
  const queryVectors = new Map<string, number[]>()
  const queryLatencies: Record<Method, number[]> = { legacy: [], bm25: [], semantic: [], rrf: [], shortlistRrf: [], protectTop1: [], hybrid: [] }
  const queryRows: QueryResult[] = []
  const queryBenchmark = await measure(async () => {
    for (let iteration = 0; iteration < repeats; iteration++) {
      for (const query of retrievalQueries) {
        const row: QueryResult = { queryId: query.id, kind: query.kind, query: query.query, relevant: query.relevant, results: {} }
        let start = performance.now()
        const legacy = retrievalPassages.flatMap((passage, page) => rankRelatedText(passage.text, query.query).map(hit => ({ ...hit, id: passage.id, page })))
          .sort((a, b) => b.score - a.score || a.page - b.page)
        queryLatencies.legacy.push(performance.now() - start)
        const legacyIds = [...new Set(legacy.map(hit => hit.id))].slice(0, 10)
        row.results.legacy = { passageIds: legacyIds, metrics: relevance(query, legacyIds) }
        start = performance.now()
        const lexicalResult = searchBm25(lexical, query.query, 30)
        const lexicalMs = performance.now() - start
        queryLatencies.bm25.push(lexicalMs)
        const bm25Ids = identify(lexicalResult).slice(0, 10)
        row.results.bm25 = { passageIds: bm25Ids, metrics: relevance(query, bm25Ids) }
        if (vectors) {
          start = performance.now()
          const [queryVector] = await embed([query.query], 'query')
          queryVectors.set(query.id, queryVector!)
          const semanticResult = rankVectors(queryVector!, vectors, 30)
          const semanticMs = performance.now() - start
          queryLatencies.semantic.push(semanticMs)
          const semanticIds = identify(semanticResult).slice(0, 10)
          row.results.semantic = { passageIds: semanticIds, metrics: relevance(query, semanticIds) }
          const policies = {
            rrf: () => reciprocalRankFusion([lexicalResult, semanticResult], 5),
            shortlistRrf: () => reciprocalRankFusion([lexicalResult.slice(0, 10), semanticResult.slice(0, 10)], 5),
            protectTop1: () => {
              const fused = reciprocalRankFusion([lexicalResult, semanticResult], 60)
              const selected = new Set([semanticResult[0]?.chunkId, lexicalResult[0]?.chunkId].filter((id): id is string => id !== undefined))
              for (const candidate of fused) { if (selected.size >= 5) break; selected.add(candidate.chunkId) }
              return fused.filter(candidate => selected.has(candidate.chunkId))
            },
            hybrid: () => hybridCandidates(lexicalResult, semanticResult, 5),
          }
          for (const method of Object.keys(policies) as (keyof typeof policies)[]) {
            start = performance.now()
            const ids = identify(policies[method]())
            // Sum shared work once: query embedding+vector search+lexical+fusion.
            queryLatencies[method].push(semanticMs + lexicalMs + performance.now() - start)
            row.results[method] = { passageIds: ids, metrics: relevance(query, ids) }
          }
        }
        if (iteration === 0) queryRows.push(row)
      }
    }
  })
  const methods = (binding ? ['legacy', 'bm25', 'semantic', 'rrf', 'shortlistRrf', 'protectTop1', 'hybrid'] : ['legacy', 'bm25']) as Method[]
  const quality = Object.fromEntries(methods.map(method => {
    const summarize = (rows: QueryResult[]) => {
      const metrics = rows.flatMap(row => row.results[method]?.metrics ? [row.results[method]!.metrics!] : [])
      const average = (key: keyof NonNullable<ReturnType<typeof relevance>>) => metrics.length ? metrics.reduce((sum, entry) => sum + entry[key], 0) / metrics.length : null
      return { queries: metrics.length, recallAt5: average('recallAt5'), hitAt1: average('hitAt1'),
        mrrAt5: average('reciprocalRankAt5'), ndcgAt5: average('ndcgAt5') }
    }
    return [method, { overall: summarize(queryRows), byKind: Object.fromEntries(
      [...new Set(retrievalQueries.filter(query => query.relevant.length).map(query => query.kind))]
        .map(kind => [kind, summarize(queryRows.filter(row => row.kind === kind))])),
    noAnswerCandidateCounts: queryRows.filter(row => row.kind === 'no-answer').map(row => ({ queryId: row.queryId,
      countWithinTop5: row.results[method]!.passageIds.slice(0, 5).length })), queryLatency: distribution(queryLatencies[method]) }]
  }))

  const sourceVector = new Map(chunks.map((chunk, index) => [chunk.text, documentEmbedding?.result[index]]))
  const scales = []
  for (const pageCount of [100, 1000]) {
    const indexed = await measure(() => {
      const scaleChunks: RetrievalChunk[] = []
      for (let page = 1; page <= pageCount; page++) scaleChunks.push(...chunkPage(page, retrievalPassages[(page - 1) % retrievalPassages.length]!.text,
        'pdf-text', { maxCharacters: Math.min(1200, model?.maxInputCharacters ?? 1200) }))
      return { chunks: scaleChunks, lexical: createBm25Index(scaleChunks) }
    })
    const scaleVectors = vectors ? indexed.result.chunks.map(chunk => {
      const vector = sourceVector.get(chunk.text)
      if (!vector) throw new Error('Scale corpus must reuse an already embedded exact text chunk.')
      return { chunkId: chunk.id, vector }
    }) : undefined
    const latency: { bm25: number[]; vector: number[]; hybrid: number[] } = { bm25: [], vector: [], hybrid: [] }
    const queried = await measure(() => {
      for (let iteration = 0; iteration < repeats; iteration++) for (const query of retrievalQueries) {
        let start = performance.now()
        const lexicalResult = searchBm25(indexed.result.lexical, query.query)
        const lexicalMs = performance.now() - start
        latency.bm25.push(lexicalMs)
        if (scaleVectors) {
          start = performance.now()
          const semanticResult = rankVectors(queryVectors.get(query.id)!, scaleVectors)
          const vectorMs = performance.now() - start
          latency.vector.push(vectorMs)
          start = performance.now()
          hybridCandidates(lexicalResult, semanticResult, 5)
          latency.hybrid.push(lexicalMs + vectorMs + performance.now() - start)
        }
      }
    })
    scales.push({ pageCount, chunks: indexed.result.chunks.length, sourceCharacters: indexed.result.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      vectorBytesIfStoredFloat32: scaleVectors ? scaleVectors.length * model!.dimensions * 4 : null,
      note: 'Repeated synthetic passages; document and query vectors reused. Ranking cost only; not cold embedding or disk-cache timing.',
      build: indexed.metrics, query: queried.metrics, latency: Object.fromEntries(Object.entries(latency).map(([key, samples]) => [key, distribution(samples)])) })
  }

  const cache = new Map<string, unknown>()
  const counters = { pageReads: 0, documentEmbeddingRequests: 0, documentEmbeddingTexts: 0, queryEmbeddingRequests: 0 }
  const serviceProvider: RetrievalEmbedding | undefined = model && binding ? {
    ...model, generation: 'benchmark-generation',
    async embed(texts, purpose, signal) {
      if (purpose === 'document') { counters.documentEmbeddingRequests++; counters.documentEmbeddingTexts += texts.length }
      else counters.queryEmbeddingRequests++
      return (await registry.embed({ texts, purpose, signal }, binding)).vectors
    },
  } : undefined
  const ports: RetrievalPorts = {
    documents: { snapshot: (sessionId, documentId) => {
      if (sessionId !== 'synthetic-session' || documentId !== 'synthetic-document') throw new Error('Invalid synthetic benchmark document')
      return { id: documentId, path: '/synthetic/benchmark.pdf', sourceDigest: retrievalCorpusVersion,
        contentVersion: retrievalCorpusVersion, pageCount: retrievalPassages.length }
    } },
    pages: { read: async (_session, _document, page) => {
      counters.pageReads++
      return { text: retrievalPassages[page - 1]!.text, source: 'pdf-text' }
    } },
    embedding: { select: () => serviceProvider },
    cache: { get: async key => structuredClone(cache.get(key)), set: async (key, value) => { cache.set(key, structuredClone(value)) } },
  }
  let service = createRetrievalService(ports)
  async function serviceQuery() {
    const input: RetrievalInput = { documentId: 'synthetic-document', query: retrievalQueries[0]!.query,
      mode: binding ? 'hybrid' : 'lexical', topK: 5 }
    const before = { ...counters }
    let calls = 1
    let result = await service.search('synthetic-session', input)
    while (result.status !== 'complete' && result.nextCursor && calls < 30) {
      result = await service.search('synthetic-session', { ...input, cursor: result.nextCursor })
      calls++
    }
    if (result.status !== 'complete') throw new Error('Synthetic service indexing did not complete.')
    return { calls, topPages: result.chunks.map(chunk => chunk.page), coverage: result.coverage,
      work: Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, value - before[key as keyof typeof before]])) }
  }
  let serviceCache: unknown
  try {
    const first = await measure(serviceQuery)
    const second = await measure(serviceQuery)
    await service.dispose()
    service = createRetrievalService(ports)
    const restored = await measure(serviceQuery)
    if (second.result.work.pageReads || second.result.work.documentEmbeddingRequests
        || restored.result.work.pageReads || restored.result.work.documentEmbeddingRequests) {
      throw new Error('Warm or restored service unexpectedly re-extracted/re-embedded cached document content.')
    }
    serviceCache = { note: 'Actual retrieval service with synthetic page provider and structured-clone in-memory KV; this is cache reuse, not disk IO or real PDF timing.',
      first, second, restored, cachedRecords: cache.size }
  } finally { await service.dispose() }

  const report = {
    schemaVersion: 1, benchmark: 'retrieval-component-v1', generatedAt: new Date().toISOString(),
    corpus: { version: retrievalCorpusVersion, sha256: createHash('sha256').update(JSON.stringify({ retrievalPassages, retrievalQueries, complexPageLimitations })).digest('hex'),
      passages: retrievalPassages.length, queries: retrievalQueries.length, chunks: chunks.length, truth: 'frozen synthetic relevance labels authored before ranking' },
    environment: environmentMetadata(), embedding: model ?? { status: 'not-requested', modes: 'lexical-only' },
    configuration: { repeats, textVersion: RETRIEVAL_TEXT_VERSION, topK: 5,
      fusion: 'RRF k=60, protect first lexical and first two semantic candidates before truncation; no reranker' },
    scope: [
      'In-memory retrieval component benchmark; excludes PDF extraction, native rendering, UI and real disk persistence.',
      'CPU/RSS/heap cover this Node process only, not the external MLX server or GPU. CPU percent may exceed 100% for multithreaded work.',
      'First document embedding starts against an already running external model server; it is not cold model loading.',
      'Warm semantic query latency includes a fresh real query embedding on each repetition; hybrid sums shared component work once.',
      'No-answer results are reported, not treated as a calibrated rejection decision. A nonempty ranked list cannot prove an answer exists.',
      'The small hand-authored synthetic corpus and few repetitions do not establish production accuracy or stable tail latency.',
      'This is a development diagnostic corpus used to expose and compare fusion policies, not an untouched held-out evaluation set.',
      'Scale vectors share reused arrays; reported Float32 capacity is theoretical storage, not a measured production cache.',
      'Event-loop lag uses a coarse 10 ms timer. Scale query stages run the whole synthetic query series synchronously, not the Host worker scheduler.',
    ],
    stages: { chunkAndLexicalIndex: preparation.metrics, firstDocumentEmbedding: documentEmbedding?.metrics ?? null, warmQueries: queryBenchmark.metrics },
    quality, queries: queryRows, scale: scales, serviceCache,
    complexPageCoverage: complexPageLimitations.map(item => ({ ...item, textChunks: chunkPage(1, item.availableText).length, visualIndexed: false })),
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (values.out) await writeFile(values.out, serialized, { flag: 'wx' })
  process.stdout.write(serialized)
} finally { registry.dispose() }
