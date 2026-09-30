/** Loopback-only synthetic fixture adapter; intentionally does not model DSH authorization/durable I/O. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createWorkspaces } from '../src/host/workspaces.ts'
import { observePdfPerformance, type PdfPerformanceEvent } from '../src/shared/performance.ts'
import type { DraftRecord } from '../src/host/validation.ts'
import { sha256 } from './metadata.ts'
import { createPdfService } from '../src/host/pdf-service.ts'
import { registerPdfTransport } from '../src/host/transport.ts'
import { resolve } from 'node:path'

export async function startServer(bundle: Uint8Array, initial: Uint8Array, pages: number, annotations: number, engine: 'pdfjs' | 'native' = 'pdfjs') {
  const sessionId = `bench-${randomUUID()}`, token = randomUUID(), path = '/bench/fixture.pdf'
  let bytes = initial.slice(), version = `sha256:${sha256(bytes)}`, fsRevision = 1
  const records = new Map<string, DraftRecord>(), owner = new AbortController(), stages: PdfPerformanceEvent[] = []
  const stop = observePdfPerformance(event => stages.push(event))
  const files: Parameters<typeof createWorkspaces>[0] = {
    async resolvePath(_agent, requested) { if (requested !== path) throw new Error('Only the synthetic fixture is available'); return path },
    async read(_agent, requested) {
      if (requested !== path) throw new Error('Unknown test path')
      return { path, bytes: bytes.slice(), version, fsVersion: `fs-${fsRevision}`, size: bytes.byteLength }
    },
    async save(_agent, requested, value, expected) {
      if (requested !== path || expected !== version) throw new Error('Unexpected test save')
      bytes = value.slice(); version = `sha256:${sha256(bytes)}`; fsRevision++
      return { path, version, fsVersion: `fs-${fsRevision}`, size: bytes.byteLength }
    },
  }
  const workspaces = createWorkspaces(files, { get: key => records.get(key),
    async put(key, value) { records.set(key, structuredClone(value)) }, async delete(key) { records.delete(key) } })
  const service = createPdfService(workspaces, { executable: process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`), engine: () => engine === 'native' ? 'native' : 'pdfjs' })
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const context: Parameters<typeof registerPdfTransport>[0] = { connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => { routes.delete(route.path) } } } },
    sessionController: { async resolveAgent(id) { return id === sessionId ? { agent: { session: { id, header: { cwd: '/bench' } } } } : { error: new Error('Unknown fixture session') } } } }
  registerPdfTransport(context, service.dispatch)
  registerPdfTransport(context, service.native, { endpoint: 'pdf.native', maxRequestBytes: 64 * 1024 })
  const traffic = { requests: 0, requestBytes: 0, responseBytes: 0 }
  const configuration = JSON.stringify({ sessionId, token, pages, annotations, engine })
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>PDF M0 component benchmark</title>
    <style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}html{
    --dsw-alias-bg-base:#f4f5f7;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#eee;
    --dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#666;--dsw-alias-border-l2:#ddd;--dsw-alias-link:#1765c0;
    --dsw-alias-bg-document-preview:#e9ebee;--dsw-alias-label-document-preview:#555;--dsw-elevation-prominent:0 2px 6px #0002}</style>
    <body><div id="root"></div><script>window.__PDF_BENCH_CONFIG__=${configuration}</script><script src="/app.js"></script></body></html>`
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    try {
      if (request.method === 'GET' && request.url === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return }
      if (request.method === 'GET' && request.url === '/app.js') { response.setHeader('content-type', 'text/javascript; charset=utf-8'); response.end(bundle); return }
      if (request.method === 'GET' && request.url === '/favicon.ico') { response.writeHead(204); response.end(); return }
      if (request.method !== 'POST' || request.url !== '/rpc' || request.headers['x-bench-token'] !== token) { response.writeHead(404); response.end(); return }
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Test request too large'); chunks.push(chunk) }
      const input = Buffer.concat(chunks), envelope = JSON.parse(input.toString('utf8'))
      const route = routes.get(`/api/${envelope.method}`)
      if (!route) throw new Error('Unknown benchmark RPC')
      const abort = new AbortController()
      const stopRequest = () => { if (!response.writableEnded) abort.abort() }
      response.on('close', stopRequest)
      const result = await route(new Request(`http://fixture/api/${envelope.method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: input, signal: abort.signal }))
      const output = new Uint8Array(await result.arrayBuffer())
      traffic.requests++; traffic.requestBytes += input.length; traffic.responseBytes += output.length
      response.setHeader('content-type', result.headers.get('content-type')!); response.statusCode = result.status; response.end(output)
    } catch (error) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: false, error: { code: 'bench/failure', message: error instanceof Error ? error.message : 'test adapter failure' } }))
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No benchmark server port')
  return { url: `http://127.0.0.1:${address.port}/`, stages, traffic, diagnostics: service.diagnostics, currentBytes: () => bytes, async close() {
    owner.abort(); stop(); server.closeAllConnections()
    service.dispose()
    await Promise.all([workspaces.dispose(), new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))])
  } }
}
