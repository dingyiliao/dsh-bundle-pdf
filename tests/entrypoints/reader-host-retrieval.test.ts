import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { apply } from '../../src/entrypoints/reader-host.ts'
import { Config, type HostConfig } from '../../src/entrypoints/reader-host-config.ts'
import { evidenceSha256 } from '../../src/modules/evidence/index.ts'
import { pageCacheKey } from '../../src/modules/retrieval/cache.ts'
import { nativeTestSubprocess } from '../native-test-subprocess.ts'

type Tool = { name: string; execute(input: unknown, execution: unknown): Promise<unknown> }

test('Host retrieval reauthorizes a cached indexing job against the current Session agent', async t => {
  for (const resolution of ['matching', 'missing', 'foreign'] as const) {
    await t.test(resolution, async t => {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'pdf-host-retrieval-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, files: [] }))
      const document = await PDFDocument.create()
      document.addPage([200, 200])
      const bytes = await document.save(), path = join(root, 'cached-page.pdf')
      await writeFile(path, bytes)
      const sessionId = 'retrieval-owner', agent = { session: { id: sessionId, header: {} } }
      const tools = new Map<string, Tool>(), services = new Map<string, unknown>()
      const domains = new Map<string, Map<string, unknown>>()
      const effects: Array<() => void | Promise<void>> = []
      let resolvedAgents = 0
      const ctx = {
        loader: { locate: () => 'fixture/pdf', resolve: () => ({ options: { id: 'fixture/pdf' } }) },
        fs: {
          async resolve(input: string, options?: { cwd?: string }) {
            const absolute = resolve(options?.cwd ?? root, input)
            assert.equal(absolute, path)
            return { targetKey: absolute, displayPath: absolute }
          },
          processPath: (target: { targetKey: unknown }) => String(target.targetKey),
          processPathFromHostPath: (input: string) => input,
          contains: () => false,
          async stat(target: { targetKey: unknown }) {
            const content = await readFile(String(target.targetKey))
            return { type: 'file', version: evidenceSha256(content), size: content.length }
          },
          async readBytes(target: { targetKey: unknown }, signal?: AbortSignal) {
            return readFile(String(target.targetKey), { signal })
          },
        },
        sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) },
        pdfNative: { executable: '/unused/pdfium-worker' }, subprocess: nativeTestSubprocess,
        sessionController: { async resolveAgent(requested: string) {
          resolvedAgents++
          assert.equal(requested, sessionId)
          if (resolution === 'missing') return { error: new Error('Session was retired') }
          return { agent: resolution === 'foreign' ? { session: { id: 'another-session', header: {} } } : agent }
        } },
        get: (key: string) => services.get(key),
        storageDomain: { async open(definition: { name: string }) {
          const values = new Map<string, unknown>()
          domains.set(definition.name, values)
          return { table: () => ({ get: (key: string) => values.get(key),
            put: async (key: string, value: unknown) => { values.set(key, value) },
            delete: async (key: string) => { values.delete(key) }, entries: () => values.entries() }),
          async close() {} }
        } },
        connection: { fetch: { register: () => async () => {} } },
        tools: { register(tool: Tool) { tools.set(tool.name, tool) } },
        reflect: { provide(key: string, value: unknown) { services.set(key, value); return () => {} } },
        inject: () => ({ async dispose() {} }),
        effect(callback: () => void | (() => void | Promise<void>)) {
          const dispose = callback()
          if (dispose) effects.push(dispose)
        },
      }
      const config = (Config as unknown as (input: Record<string, unknown>) => HostConfig)({})
      await apply(ctx as unknown as Parameters<typeof apply>[0], config, root)
      try {
        const execution = { agent, signal: new AbortController().signal }
        const opened = await tools.get('pdf_open')!.execute({ path }, execution) as { documentId: string }
        const cache = [...domains].find(([name]) => name.startsWith('pdf_retrieval_'))![1]
        cache.set(pageCacheKey(path, evidenceSha256(bytes), 1), {
          createdAt: Date.now(), payload: { version: 1, text: '', source: 'pdf-text' },
        })
        const search = tools.get('pdf_find_related')!.execute({ documentId: opened.documentId,
          query: 'cached document', mode: 'lexical' }, execution)
        if (resolution === 'matching') {
          const result = await search as { status: string; candidates: unknown[]; coverage: { indexedPages: number } }
          assert.equal(result.status, 'complete')
          assert.deepEqual(result.candidates, [])
          assert.equal(result.coverage.indexedPages, 1)
        } else {
          await assert.rejects(search, resolution === 'missing' ? /Session was retired/ : /session identity mismatch/)
        }
        assert.equal(resolvedAgents, 1, 'cached text must still acquire a fresh, matching Session lease')
      } finally {
        for (const dispose of effects.reverse()) await dispose()
      }
    })
  }
})
