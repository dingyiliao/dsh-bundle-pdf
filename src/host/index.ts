import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { Config, readConfig, type HostConfig } from './config.ts'
import { registerPdfTransport } from './transport.ts'
import { createLocalFiles } from './local-files.ts'
import { registerAssets } from './assets.ts'
import { createWorkspaces } from './workspaces.ts'
import { createPdfService } from './pdf-service.ts'
import { draftSchema, type DraftRecord } from './validation.ts'
import { createHostTranslations, type TranslationHostContext } from './translations.js'

export { Config }
export const name = 'pdf-reader'
export const inject = ['connection', 'sessionController', 'fs', 'sandboxPolicy', 'storageDomain', 'loader']

type TransportContext = Parameters<typeof registerPdfTransport>[0]
type LocalContext = Parameters<typeof createLocalFiles>[0]
interface HostContext extends Omit<TransportContext, 'connection'>, LocalContext, TranslationHostContext {
  reflect: { provide(key: string, value: unknown): () => void }
  connection: {
    fetch: {
      register(route: {
        path: string
        methods: readonly ('GET' | 'HEAD' | 'POST')[]
        requestBody: 'buffered' | 'streaming'
        fetch(request: Request): Promise<Response>
      }): () => Promise<void>
    }
  }
  loader: { locate(): string | undefined; resolve(id: string): { options: { id: string } } }
  effect(callback: () => (() => void | Promise<void>), label?: string): unknown
  storageDomain: {
    open(spec: ReturnType<typeof defineDomain>): Promise<{
      table(name: 'drafts'): {
        get(key: string): DraftRecord | undefined
        put(key: string, value: DraftRecord): Promise<void>
        delete(key: string): Promise<unknown>
      }
      close(): Promise<void>
    }>
  }
}

export async function apply(ctx: HostContext, config: HostConfig): Promise<void> {
  const namespace = ctx.loader.locate()
  if (!namespace) throw new Error('PDF must be loaded as a configured plugin entry')
  const settingsNamespace = ctx.loader.resolve(namespace).options.id
  const suffix = createHash('sha256').update(namespace).digest('hex').slice(0, 16)
  // One adapter owns every session's canonical-path save queue. Its limit is
  // read again at operation boundaries after settings change.
  const files = createLocalFiles(ctx, { getMaxBytes: () => config.maxFileBytes.get() })
  const domain = await ctx.storageDomain.open(defineDomain({
    name: `pdf_drafts_${suffix}`, version: 1, layout: 'per-record', tables: { drafts: domainTable(draftSchema) },
  }))
  const workspaces = createWorkspaces(files, domain.table('drafts'))
  const pdfService = createPdfService(workspaces, {
    executable: process.env.DSH_PDF_NATIVE_HELPER ?? fileURLToPath(new URL(`./native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url)),
    engine: () => config.readerEngine?.get() ?? 'auto',
  })
  const translations = createHostTranslations(ctx, namespace, () => readConfig(config))
  const disposers: (() => Promise<void>)[] = []
  let disposed: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposed) return disposed
    // Close operation admission synchronously, then release transports. Domain
    // writes remain available until every already-admitted operation settles.
    const drain = workspaces.dispose()
    translations.registry.dispose()
    disposed = (async () => {
      const results = await Promise.allSettled(disposers.splice(0).reverse().map(close => close()))
      await drain
      pdfService.dispose()
      await domain.close()
      const rejected = results.filter(result => result.status === 'rejected')
      if (rejected.length) throw new AggregateError(rejected.map(result => result.reason), 'Could not fully dispose PDF routes')
    })()
    return disposed
  }
  try {
    ctx.effect(() => {
      disposers.push(registerPdfTransport(ctx, pdfService.dispatch))
      disposers.push(registerPdfTransport(ctx, pdfService.native, { endpoint: 'pdf.native', maxRequestBytes: 64 * 1024 }))
      disposers.push(registerPdfTransport(ctx, translations.dispatch, { endpoint: 'pdf.translation', maxRequestBytes: 64 * 1024 }))
      disposers.push(registerAssets(ctx))
      // Settings bootstrap carries no file contents and works outside a session.
      disposers.push(ctx.connection.fetch.register({
        path: '/api/pdf.info', methods: ['POST'], requestBody: 'streaming',
        async fetch(request) {
          const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
          const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
          if (type !== 'application/json') return new Response('JSON required', { status: 415, headers })
          let input: unknown
          try { input = JSON.parse(await readInfoRequest(request)) } catch (error) {
            return new Response(error instanceof InfoRequestTooLarge ? 'Request too large' : 'Invalid JSON', {
              status: error instanceof InfoRequestTooLarge ? 413 : request.signal.aborted ? 499 : 400, headers,
            })
          }
          if (!input || typeof input !== 'object' || Array.isArray(input)
            || !('type' in input) || input.type !== 'client-request'
            || !('method' in input) || input.method !== 'pdf.info'
            || !('rpcId' in input) || typeof input.rpcId !== 'string' || !input.rpcId || input.rpcId.length > 256) {
            return new Response('Invalid RPC', { status: 400, headers })
          }
          return Response.json({ type: 'server-response', rpcId: input.rpcId,
            result: { ok: true, value: { namespace, settingsNamespace, settings: readConfig(config), translationEngines: translations.registry.list() } },
          }, { headers })
        },
      }))
      return dispose
    }, 'pdf: routes, working copies and draft storage')
    ctx.effect(() => ctx.reflect.provide('pdfTranslation', translations.registry), 'pdf: Host translation engines')
    ctx.effect(() => ctx.reflect.provide('pdf', pdfService), 'pdf: shared document service')
  } catch (error) {
    await dispose().catch(() => undefined)
    throw error
  }
}

class InfoRequestTooLarge extends Error {}

/** Stop reading at the byte limit rather than buffering unbounded request.text(). */
async function readInfoRequest(request: Request): Promise<string> {
  const limit = 4096
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new InfoRequestTooLarge()
  if (!request.body) return ''
  const reader = request.body.getReader()
  const bytes = new Uint8Array(limit)
  let offset = 0
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  request.signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      request.signal.throwIfAborted()
      const next = await reader.read()
      request.signal.throwIfAborted()
      if (next.done) break
      if (offset + next.value.byteLength > limit) throw new InfoRequestTooLarge()
      bytes.set(next.value, offset)
      offset += next.value.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    request.signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}
