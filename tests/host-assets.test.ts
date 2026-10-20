import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PDF_ASSET_PREFIX, registerAssets } from '../src/adapters/host/dsh/assets.ts'

type AssetRoute = Parameters<Parameters<typeof registerAssets>[0]['connection']['fetch']['register']>[0]

const bridgePath = 'ocr/bridge.js'
const bridgeBytes = Buffer.from('export const ready = true\n')

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-host-assets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'ocr'))
  await writeFile(join(root, bridgePath), bridgeBytes)
  const record = {
    path: bridgePath,
    bytes: bridgeBytes.byteLength,
    sha256: createHash('sha256').update(bridgeBytes).digest('hex'),
    contentType: 'text/javascript; charset=utf-8',
  }
  const writeManifest = (files: unknown, version = 1) =>
    writeFile(join(root, 'manifest.json'), JSON.stringify({ version, files }))
  await writeManifest([record])
  return { root, record, writeManifest }
}

function registry(options: { rejectDispose?: string; rejectRegistration?: string } = {}) {
  const routes = new Map<string, AssetRoute>()
  const disposed: string[] = []
  const ctx = {
    connection: {
      fetch: {
        register(route: AssetRoute) {
          if (route.path === options.rejectRegistration) throw new Error('Registration failed')
          routes.set(route.path, route)
          return async () => {
            disposed.push(route.path)
            routes.delete(route.path)
            if (route.path === options.rejectDispose) throw new Error('Disposal failed')
          }
        },
      },
    },
  }
  return { ctx, routes, disposed }
}

test('asset route serves only manifest-listed bytes with authentication supplied by its connection', async (t) => {
  const { root, record } = await fixture(t)
  const { ctx, routes } = registry()
  const dispose = registerAssets(ctx, root)
  const route = routes.get(`${PDF_ASSET_PREFIX}/${bridgePath}`)
  assert.ok(route)
  assert.deepEqual(route.methods, ['GET', 'HEAD'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(routes.size, 1)

  const get = await route.fetch(new Request('https://example.test/api/pdf-assets/ocr/bridge.js'))
  assert.equal(get.status, 200)
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bridgeBytes)
  assert.equal(get.headers.get('content-type'), record.contentType)
  assert.equal(get.headers.get('content-length'), String(record.bytes))
  assert.equal(get.headers.get('etag'), `"${record.sha256}"`)
  assert.equal(get.headers.get('cache-control'), 'private, max-age=0, must-revalidate')
  assert.equal(get.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(get.headers.get('cross-origin-resource-policy'), 'same-origin')

  const head = await route.fetch(new Request('https://example.test/api/pdf-assets/ocr/bridge.js', { method: 'HEAD' }))
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
  assert.equal(head.headers.get('content-length'), String(record.bytes))

  // Already verified resources stay available from the in-memory cache while this plugin is loaded.
  await rm(join(root, bridgePath))
  const cached = await route.fetch(new Request('https://example.test/api/pdf-assets/ocr/bridge.js'))
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), bridgeBytes)
  await dispose()
  assert.equal(routes.size, 0)
})

test('asset route handles conditional requests and a cancelled request without a body', async (t) => {
  const { root, record } = await fixture(t)
  const { ctx, routes } = registry()
  const dispose = registerAssets(ctx, root)
  const route = routes.get(`${PDF_ASSET_PREFIX}/${bridgePath}`)!
  const etag = `"${record.sha256}"`
  try {
    for (const value of [`"other", ${etag}`, '*']) {
      const response = await route.fetch(new Request('https://example.test', { headers: { 'if-none-match': value } }))
      assert.equal(response.status, 304)
      assert.equal(response.body, null)
      assert.equal(response.headers.get('etag'), etag)
      assert.equal(response.headers.get('content-length'), null)
    }
    const miss = await route.fetch(new Request('https://example.test', { headers: { 'if-none-match': '"other"' } }))
    assert.equal(miss.status, 200)
    const controller = new AbortController()
    const request = new Request('https://example.test', { signal: controller.signal })
    controller.abort()
    const cancelled = await route.fetch(request)
    assert.equal(cancelled.status, 499)
    assert.equal(cancelled.body, null)

    const midFlight = new AbortController()
    const pending = route.fetch(new Request('https://example.test', { signal: midFlight.signal }))
    midFlight.abort()
    const cancelledAfterLoad = await pending
    assert.equal(cancelledAfterLoad.status, 499)
    assert.equal(cancelledAfterLoad.body, null)
  } finally { await dispose() }
})

test('a missing or changed asset fails closed and can be retried once restored', async (t) => {
  const { root } = await fixture(t)
  const { ctx, routes } = registry()
  const dispose = registerAssets(ctx, root)
  const route = routes.get(`${PDF_ASSET_PREFIX}/${bridgePath}`)!
  try {
    await writeFile(join(root, bridgePath), 'corrupted asset content\n')
    for (const expected of ['corrupted', 'missing']) {
      if (expected === 'missing') await rm(join(root, bridgePath))
      const response = await route.fetch(new Request('https://example.test'))
      assert.equal(response.status, 503, expected)
      assert.match(await response.text(), /resource is unavailable/)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
    }
    await writeFile(join(root, bridgePath), bridgeBytes)
    const recovered = await route.fetch(new Request('https://example.test'))
    assert.equal(recovered.status, 200)
    assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), bridgeBytes)
  } finally { await dispose() }
})

test('manifest rejects malformed metadata, unsafe paths and duplicate assets before registering routes', async (t) => {
  const { root, record, writeManifest } = await fixture(t)
  const { ctx, routes } = registry()
  await writeFile(join(root, 'manifest.json'), 'null')
  assert.throws(() => registerAssets(ctx, root), /Invalid PDF plugin asset manifest/)
  await writeManifest([], 2)
  assert.throws(() => registerAssets(ctx, root), /Invalid PDF plugin asset manifest/)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, files: {} }))
  assert.throws(() => registerAssets(ctx, root), /Invalid PDF plugin asset manifest/)

  const invalid = [
    null,
    { ...record, path: '../secrets' },
    { ...record, path: 'ocr/core/../bridge.js' },
    { ...record, path: 'ocr/extra.js' },
    { ...record, bytes: -1 },
    { ...record, bytes: 64 * 1024 * 1024 + 1 },
    { ...record, sha256: 'not-a-sha256' },
    { ...record, contentType: 'text/html' },
  ]
  for (const row of invalid) {
    await writeManifest([row])
    assert.throws(() => registerAssets(ctx, root), /Invalid PDF plugin asset record/)
  }
  await writeManifest([record, record])
  assert.throws(() => registerAssets(ctx, root), /Invalid PDF plugin asset record/)
  assert.equal(routes.size, 0)
})

test('asset registration rolls back earlier routes when a later route fails', async (t) => {
  const { root, record, writeManifest } = await fixture(t)
  await writeManifest([record, { ...record, path: 'ocr/worker.min.js' }])
  const { ctx, routes, disposed } = registry({ rejectRegistration: `${PDF_ASSET_PREFIX}/ocr/worker.min.js` })
  assert.throws(() => registerAssets(ctx, root), /Registration failed/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(routes.size, 0)
  assert.deepEqual(disposed, [`${PDF_ASSET_PREFIX}/${bridgePath}`])
})

test('registration retains the original failure when rollback itself also rejects', async (t) => {
  const { root, record, writeManifest } = await fixture(t)
  await writeManifest([record, { ...record, path: 'ocr/worker.min.js' }])
  const { ctx, routes, disposed } = registry({
    rejectRegistration: `${PDF_ASSET_PREFIX}/ocr/worker.min.js`,
    rejectDispose: `${PDF_ASSET_PREFIX}/${bridgePath}`,
  })
  assert.throws(() => registerAssets(ctx, root), /Registration failed/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(routes.size, 0)
  assert.deepEqual(disposed, [`${PDF_ASSET_PREFIX}/${bridgePath}`])
})

test('asset disposal releases all routes in reverse order even if one disposal fails', async (t) => {
  const { root, record, writeManifest } = await fixture(t)
  await writeManifest([record, { ...record, path: 'ocr/worker.min.js' }])
  const first = `${PDF_ASSET_PREFIX}/${bridgePath}`
  const second = `${PDF_ASSET_PREFIX}/ocr/worker.min.js`
  const { ctx, routes, disposed } = registry({ rejectDispose: second })
  const dispose = registerAssets(ctx, root)
  await assert.rejects(dispose(), /Disposal failed/)
  assert.deepEqual(disposed, [second, first])
  assert.equal(routes.size, 0)
  await dispose()
  assert.deepEqual(disposed, [second, first])
})
