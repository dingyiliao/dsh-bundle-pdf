/** Carrier-neutral, authenticated PDF operations without generated core remotes. */
export const PDF_ENDPOINT = 'pdf.dispatch'

export interface PdfAgent {
  readonly session: { readonly id: string; readonly header: { readonly cwd?: string } }
}

interface TransportContext {
  connection: {
    fetch: {
      register(route: {
        path: string
        methods: readonly ['POST']
        requestBody: 'streaming'
        fetch(request: Request): Promise<Response>
      }): () => Promise<void>
    }
  }
  sessionController: {
    resolveAgent(sessionId: string): Promise<{ agent: PdfAgent } | { error: unknown }>
  }
}

export type PdfDispatch = (
  sessionId: string,
  input: Record<string, unknown>,
  agent: PdfAgent,
  signal: AbortSignal,
) => Promise<unknown>

/**
 * Register through Connection, which owns Web and shell authentication. The
 * existing Client call is connection.rpc.call('/api', PDF_ENDPOINT, input).
 * input.sessionId selects an ordinary session via the public Host resolver.
 * Connection owns the returned registration's context lifetime.
 */
export function registerPdfTransport(
  ctx: TransportContext,
  dispatch: PdfDispatch,
  options: { maxRequestBytes?: number; endpoint?: string } = {},
): () => Promise<void> {
  const maxBytes = options.maxRequestBytes ?? 16 * 1024 * 1024
  const endpoint = options.endpoint ?? PDF_ENDPOINT
  if (!/^pdf\.[a-z.]+$/.test(endpoint)) throw new TypeError('Invalid PDF endpoint')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid PDF request limit')
  return ctx.connection.fetch.register({
    path: `/api/${endpoint}`,
    methods: ['POST'],
    requestBody: 'streaming',
    async fetch(request) {
      const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') return new Response('JSON required', { status: 415, headers })
      let envelope: unknown
      try {
        envelope = JSON.parse(await readBoundedRequest(request, maxBytes))
      } catch (error) {
        const tooLarge = error instanceof RequestTooLarge
        return new Response(tooLarge ? 'PDF request exceeds byte limit' : 'Invalid JSON request', {
          status: tooLarge ? 413 : request.signal.aborted ? 499 : 400, headers,
        })
      }
      if (!isRecord(envelope) || envelope.type !== 'client-request'
        || typeof envelope.rpcId !== 'string' || envelope.rpcId.length === 0 || envelope.rpcId.length > 256
        || envelope.method !== endpoint) {
        return new Response('Invalid RPC envelope', { status: 400, headers })
      }
      let result: unknown
      try {
        if (!isRecord(envelope.payload) || typeof envelope.payload.sessionId !== 'string'
          || !envelope.payload.sessionId || envelope.payload.sessionId.length > 512) {
          throw Object.assign(new Error('A sessionId is required'), { code: 'pdf/invalid-request' })
        }
        request.signal.throwIfAborted()
        const input = envelope.payload
        const sessionId = input.sessionId as string
        const resolved = await ctx.sessionController.resolveAgent(sessionId)
        if ('error' in resolved) throw resolved.error
        request.signal.throwIfAborted()
        if (resolved.agent.session.id !== sessionId) {
          throw Object.assign(new Error('Session identity mismatch'), { code: 'pdf/session-mismatch' })
        }
        result = { ok: true, value: await dispatch(sessionId, input, resolved.agent, request.signal) }
      } catch (error) {
        result = { ok: false, error: {
          code: request.signal.aborted ? 'pdf/cancelled' : errorCode(error),
          message: error instanceof Error ? error.message : String(error),
          details: {},
        } }
      }
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result }, { headers })
    },
  })
}

class RequestTooLarge extends Error {}

async function readBoundedRequest(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new RequestTooLarge()
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      request.signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maxBytes) throw new RequestTooLarge()
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : 'pdf/internal'
}
