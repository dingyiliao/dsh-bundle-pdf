import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PDF_ASSET_PREFIX = '/api/pdf-assets'

interface AssetRecord {
  path: string
  bytes: number
  sha256: string
  contentType: string
}

interface AssetContext {
  connection: {
    fetch: {
      register(route: {
        path: string
        methods: readonly ['GET', 'HEAD']
        requestBody: 'buffered'
        fetch(request: Request): Promise<Response>
      }): () => Promise<void>
    }
  }
}

function loadManifest(root: string): AssetRecord[] {
  const manifest: unknown = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || manifest.version !== 1
    || !('files' in manifest) || !Array.isArray(manifest.files)) throw new Error('Invalid PDF plugin asset manifest.')
  const names = new Set<string>()
  for (const row of manifest.files as AssetRecord[]) {
    if (!row || typeof row.path !== 'string'
      || !/^ocr\/(?:bridge\.js|worker\.min\.js|core\/[a-zA-Z0-9_.-]+\.(?:js|wasm)|lang\/[a-zA-Z0-9_-]+\.traineddata\.gz)$/.test(row.path)
      || row.path.split('/').some((part) => part === '..' || part === '.')
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 64 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(row.sha256)
      || !['text/javascript; charset=utf-8', 'application/wasm', 'application/octet-stream'].includes(row.contentType)
      || names.has(row.path)) throw new Error('Invalid PDF plugin asset record.')
    names.add(row.path)
  }
  return manifest.files as AssetRecord[]
}

/** Connection supplies authentication; only build-listed public dependency assets are exposed. */
export function registerAssets(ctx: AssetContext): () => Promise<void> {
  // After bundling this module lives in dist/index.js, next to dist/assets.
  const root = fileURLToPath(new URL('./assets/', import.meta.url))
  const manifest = loadManifest(root)
  const disposers: (() => Promise<void>)[] = []
  const cached = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()
  const load = (asset: AssetRecord): Promise<Uint8Array<ArrayBuffer>> => {
    const previous = cached.get(asset.path)
    if (previous) return previous
    const pending = readFile(resolve(root, ...asset.path.split('/'))).then((bytes) => {
      if (bytes.byteLength !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
        throw new Error('PDF plugin asset does not match its build manifest.')
      }
      return new Uint8Array(bytes)
    }).catch((error) => { cached.delete(asset.path); throw error })
    cached.set(asset.path, pending)
    return pending
  }
  try {
    for (const asset of manifest) {
      const etag = `"${asset.sha256}"`
      disposers.push(ctx.connection.fetch.register({
        path: `${PDF_ASSET_PREFIX}/${asset.path}`, methods: ['GET', 'HEAD'], requestBody: 'buffered',
        async fetch(request) {
          const headers = {
            'Content-Type': asset.contentType,
            'Cache-Control': 'private, max-age=0, must-revalidate',
            'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'same-origin',
            ETag: etag,
          }
          if (request.signal.aborted) return new Response(null, { status: 499, headers })
          try {
            const bytes = await load(asset)
            if (request.signal.aborted) return new Response(null, { status: 499, headers })
            const matches = request.headers.get('if-none-match')?.split(',').some((candidate) => candidate.trim() === etag || candidate.trim() === '*')
            if (matches) return new Response(null, { status: 304, headers })
            return new Response(request.method === 'HEAD' ? null : bytes, {
              headers: { ...headers, 'Content-Length': String(asset.bytes) },
            })
          } catch {
            return new Response('PDF plugin resource is unavailable. Rebuild or reinstall the plugin.', {
              status: 503, headers: { ...headers, 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
            })
          }
        },
      }))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) void dispose().catch(() => undefined)
    throw error
  }
  return async () => {
    const results = await Promise.allSettled(disposers.splice(0).reverse().map((dispose) => dispose()))
    cached.clear()
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
