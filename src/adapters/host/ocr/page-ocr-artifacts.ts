import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ByteCache } from '../../../shared/cache/index.js'
import { canonicalEngineJson } from '../../../modules/engines/index.js'
import type { RetrievalCache } from '../../../modules/retrieval/index.js'
import type { OcrOutput } from '../../../ocr/types.js'

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const rect = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
const inputSchema = z.object({ path: z.string().min(1).max(32768), sourceDigest: digest,
  page: z.number().int().positive(), render: z.object({
    renderer: z.string().min(1).max(200), profile: z.string().min(1).max(200),
    geometry: z.object({ page: z.number().int().positive(), mediaBox: rect.optional(), cropBox: rect,
      rotation: z.number().finite(), userUnit: z.number().finite().positive() }).strict(),
    width: z.number().int().positive().max(2048), height: z.number().int().positive().max(2048),
    annotations: z.literal(false), forms: z.literal(false),
  }).strict(),
}).strict()
const producerSchema = z.object({ id: z.string().min(1).max(512), version: z.string().min(1).max(512),
  fingerprint: z.string().min(1).max(4096), reusable: z.boolean(),
  /** Request parameters may affect output independently of backend configuration. */
  requestIdentity: z.string().min(1).max(4096).optional() }).strict()
const box = z.object({ x0: z.number().finite().nonnegative(), y0: z.number().finite().nonnegative(),
  x1: z.number().finite().nonnegative(), y1: z.number().finite().nonnegative() }).strict()
const confidence = z.object({ value: z.number().finite(), minimum: z.number().finite(), maximum: z.number().finite(),
  meaning: z.string().max(1000) }).strict().nullable()
const part = z.object({ id: z.string().max(512), parentId: z.string().max(512).optional(), text: z.string().max(200000),
  box: box.nullable(), confidence }).strict()
const outputSchema = z.object({ text: z.string().max(500000), blocks: z.array(part).max(10000),
  lines: z.array(part).max(10000), words: z.array(part).max(10000), confidence,
  status: z.enum(['complete', 'partial']), coverage: z.array(box).max(10000), warnings: z.array(z.string().max(2000)).max(64) }).strict()
const artifactSchema = z.object({ version: z.literal(1), input: inputSchema, producer: producerSchema,
  inputDigest: digest, output: outputSchema }).strict().superRefine((artifact, context) => {
  const { width, height } = artifact.input.render
  const boxes = [...artifact.output.coverage, ...[artifact.output.words, artifact.output.lines, artifact.output.blocks]
    .flatMap(parts => parts.flatMap(part => part.box ? [part.box] : []))]
  if (boxes.some(box => box.x1 < box.x0 || box.y1 < box.y0 || box.x1 > width || box.y1 > height)) {
    context.addIssue({ code: 'custom', message: 'OCR coordinates exceed the canonical input image' })
  }
  if (JSON.stringify(artifact.output).length > 4 * 1024 * 1024) {
    context.addIssue({ code: 'custom', message: 'OCR artifact exceeds the output budget' })
  }
})
export type PageOcrInput = z.infer<typeof inputSchema>
export type OcrProducerIdentity = z.infer<typeof producerSchema>
export type PageOcrArtifact = z.infer<typeof artifactSchema>
export interface PageOcrArtifactRequest {
  input: PageOcrInput
  producer: OcrProducerIdentity
  signal: AbortSignal
  /** Reauthorize the subscriber and fence its immutable source/producer snapshot. */
  check(): void
  produce(signal: AbortSignal): Promise<{ inputDigest: string; output: OcrOutput }>
}
const canonicalIdentity = (input: PageOcrInput, producer: OcrProducerIdentity) => canonicalEngineJson({ input, producer })
export const pageOcrArtifactKey = (input: PageOcrInput, producer: OcrProducerIdentity) =>
  `pageocr_${createHash('sha256').update(canonicalIdentity(input, producer)).digest('hex')}`
const storageFailure = (error: unknown) => !!error && typeof error === 'object' && 'code' in error
  && String(error.code).startsWith('pdf/index-storage-')

interface Subscriber {
  check(): void
  resolve(value: PageOcrArtifact): void
  reject(error: unknown): void
  detach(): void
}
interface Flight { controller: AbortController; subscribers: Set<Subscriber>; task: Promise<void> }

/** Stores raw derived OCR only. A cache hit never substitutes for a subscriber's authorization. */
export function createPageOcrArtifacts(options: { cache?: Pick<RetrievalCache, 'get' | 'set'>; maxBytes?: number } = {}) {
  // Persistent stores already own a bounded hot cache and its invalidation.
  // Avoid a second hot copy that could survive the user's explicit cache clear.
  const memory = new ByteCache<PageOcrArtifact>(options.maxBytes ?? (options.cache ? 0 : 8 * 1024 * 1024))
  const flights = new Map<string, Flight>(), pending = new Set<Promise<void>>()
  let closed = false
  function validate(flight: Flight) {
    for (const subscriber of [...flight.subscribers]) {
      try { subscriber.check() } catch (error) { subscriber.detach(); subscriber.reject(error) }
    }
    flight.controller.signal.throwIfAborted()
  }
  async function read(request: PageOcrArtifactRequest): Promise<PageOcrArtifact> {
    request.signal.throwIfAborted(); request.check()
    if (closed) throw new Error('PDF OCR artifacts are unloading')
    const input = inputSchema.parse(request.input), producer = producerSchema.parse(request.producer)
    const key = pageOcrArtifactKey(input, producer)
    let flight = flights.get(key)
    if (!flight) {
      flight = { controller: new AbortController(), subscribers: new Set(), task: Promise.resolve() }
      flights.set(key, flight)
      const current = flight
      current.task = Promise.resolve().then(async () => {
        try {
          validate(current)
          let artifact = memory.get(key)
          if (!artifact && producer.reusable) {
            let value: unknown
            try { value = await options.cache?.get(key) } catch (error) { if (storageFailure(error)) throw error }
            validate(current)
            const parsed = artifactSchema.safeParse(value)
            if (parsed.success && canonicalIdentity(parsed.data.input, parsed.data.producer) === canonicalIdentity(input, producer)) artifact = parsed.data
          }
          if (!artifact) {
            const result = await request.produce(current.controller.signal)
            validate(current)
            artifact = artifactSchema.parse({ version: 1, input, producer, ...result })
            if (producer.reusable) {
              try { await options.cache?.set(key, artifact) } catch (error) { if (storageFailure(error)) throw error }
              validate(current)
            }
          }
          memory.set(key, artifact, Buffer.byteLength(JSON.stringify(artifact)))
          validate(current)
          for (const subscriber of [...current.subscribers]) {
            subscriber.detach(); subscriber.resolve(structuredClone(artifact))
          }
        } catch (error) {
          for (const subscriber of [...current.subscribers]) { subscriber.detach(); subscriber.reject(error) }
        } finally {
          if (flights.get(key) === current) flights.delete(key)
          pending.delete(current.task)
        }
      })
      pending.add(current.task)
    }
    const current = flight
    return new Promise<PageOcrArtifact>((resolve, reject) => {
      const abort = () => { subscriber.detach(); reject(request.signal.reason) }
      const subscriber: Subscriber = { check() { request.signal.throwIfAborted(); request.check() }, resolve, reject,
        detach() {
          request.signal.removeEventListener('abort', abort); current.subscribers.delete(subscriber)
          if (!current.subscribers.size) {
            current.controller.abort(new Error('PDF OCR has no active subscribers'))
            if (flights.get(key) === current) flights.delete(key)
          }
        } }
      current.subscribers.add(subscriber)
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
    })
  }
  return { read, async dispose() {
    closed = true
    for (const flight of flights.values()) {
      const error = new Error('PDF OCR artifacts are unloading')
      flight.controller.abort(error)
      for (const subscriber of [...flight.subscribers]) { subscriber.detach(); subscriber.reject(error) }
    }
    flights.clear(); memory.clear()
    await Promise.allSettled([...pending])
  } }
}
export type PageOcrArtifacts = ReturnType<typeof createPageOcrArtifacts>
