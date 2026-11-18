import { requestEnvelopeSchema } from '../../../contracts/rpc/index.js'

class InfoRequestTooLarge extends Error {}

/** The settings bootstrap is connection-authenticated, but has no resource session. */
export function createPdfInfoRoute(read: (payload: unknown, signal: AbortSignal) => unknown | Promise<unknown>, method = 'pdf.info',
  failure = { code: 'pdf/catalog-unavailable', message: 'Engine catalog request failed.' }) {
  return {
    path: `/api/${method}`, methods: ['POST'] as const, requestBody: 'streaming' as const,
    async fetch(request: Request): Promise<Response> {
      const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
      const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (type !== 'application/json') return new Response('JSON required', { status: 415, headers })
      let input: unknown
      try { input = JSON.parse(await readInfoRequest(request)) } catch (error) {
        return new Response(error instanceof InfoRequestTooLarge ? 'Request too large' : 'Invalid JSON', {
          status: error instanceof InfoRequestTooLarge ? 413 : request.signal.aborted ? 499 : 400, headers,
        })
      }
      // The V1 bootstrap request intentionally has no payload, unlike resource RPCs.
      const parsed = requestEnvelopeSchema.partial({ payload: true }).safeParse(input)
      if (!parsed.success || parsed.data.method !== method) {
        return new Response('Invalid RPC', { status: 400, headers })
      }
      try {
        return Response.json({ type: 'server-response', rpcId: parsed.data.rpcId,
          result: { ok: true, value: await read(parsed.data.payload, request.signal) },
        }, { headers })
      } catch {
        return Response.json({ type: 'server-response', rpcId: parsed.data.rpcId,
          result: { ok: false, error: failure },
        }, { headers, status: request.signal.aborted ? 499 : 200 })
      }
    },
  }
}

/** Stop at the byte limit rather than buffering an unbounded request.text(). */
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
