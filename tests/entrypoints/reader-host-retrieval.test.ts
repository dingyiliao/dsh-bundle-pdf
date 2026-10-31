import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { PDFDocument } from 'pdf-lib'
import { apply } from '../../src/entrypoints/reader-host.ts'
import { Config, type HostConfig } from '../../src/entrypoints/reader-host-config.ts'
import { evidenceSha256 } from '../../src/modules/evidence/index.ts'
import type { EmbeddingRegistry } from '../../src/embedding/index.ts'
import { FrameDecoder, encodeFrame } from '../../src/engine/framing.ts'
import type { NativeProcessRuntime } from '../../src/adapters/host/pdfium/native-worker.ts'

type Tool = { name: string; execute(input: unknown, execution: unknown): Promise<unknown> }

test('Host retrieval reauthorizes cached jobs and preserves full-document index capacity', async t => {
  for (const resolution of ['matching', 'missing', 'foreign', 'large-index'] as const) {
    await t.test(resolution, async t => {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'pdf-host-retrieval-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, files: [] }))
      const document = await PDFDocument.create()
      const large = resolution === 'large-index', dimensions = large ? 1024 : 2, expectedChunks = large ? 5000 : 1
      const text = large ? Array.from({ length: expectedChunks }, (_, index) =>
        `A cached document remains readable. Unique evidence paragraph ${index}.`).join('\n\n')
        : 'A cached document remains readable.'
      document.addPage([200, 200]).drawText(text, { x: 10, y: 160, size: 10 })
      const bytes = await document.save(), path = join(root, 'cached-page.pdf')
      await writeFile(path, bytes)
      const sessionId = 'retrieval-owner', agent = { session: { id: sessionId, header: {} } }
      const tools = new Map<string, Tool>(), services = new Map<string, unknown>()
      const domains = new Map<string, Map<string, unknown>>()
      const effects: Array<() => void | Promise<void>> = []
      const resolvedAgents: string[] = [], commands: string[] = []
      let currentResolution: 'matching' | 'missing' | 'foreign' = 'matching', documentEncodings = 0
      const subprocess: NativeProcessRuntime = {
        async resolveExecutable(command) { return command },
        spawn(): SubprocessHandle {
          const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
          let finish!: (value: { exitCode: number; signal: null }) => void
          const done = new Promise<{ exitCode: number; signal: null }>(resolve => { finish = resolve })
          const decoder = new FrameDecoder(frame => {
            const request = frame.metadata as { command: string; requestId: string }
            commands.push(request.command)
            let value: unknown
            if (request.command === 'hello') value = { protocolVersion: 1, build: '156.0.8076.0' }
            else if (request.command === 'open') value = { pageCount: 1, formType: 0, signatureCount: 0 }
            else if (request.command === 'close') value = {}
            else {
              assert.equal(request.command, 'text')
              value = { items: [{ str: text, transform: [10, 0, 0, 10, 10, 160], width: text.length * 5,
                height: 10, dir: 'ltr', fontName: 'fixture', hasEOL: false,
                ...(large ? {} : { glyphs: [...text].map((_character, index) => [10 + index * 5, 160, 5]) }) }],
              styles: { fixture: { fontFamily: 'fixture', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null }
            }
            for (const part of encodeFrame({ requestId: request.requestId, ok: true, value })) stdout.write(part)
          })
          stdin.on('data', chunk => decoder.feed(chunk))
          return { stdin, stdout, stderr, control: undefined, collected: {}, done,
            terminate() { finish({ exitCode: 0, signal: null }); stdin.destroy(); stdout.destroy(); stderr.destroy() },
            async waitForExit() { return true } }
        },
      }
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
        pdfNative: { executable: '/fixture/pdfium-worker' }, subprocess,
        sessionController: { async resolveAgent(requested: string) {
          resolvedAgents.push(requested)
          assert.equal(requested, sessionId)
          if (currentResolution === 'missing') return { error: new Error('Session was retired') }
          return { agent: currentResolution === 'foreign' ? { session: { id: 'another-session', header: {} } } : agent }
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
      // Each document captures the defaults at first open. Later global edits
      // must not change an existing document's active indexing plan.
      const parseConfig = Config as unknown as (input: Record<string, unknown>) => HostConfig
      const config = parseConfig({ embeddingEngine: 'none' })
      await apply(ctx as unknown as Parameters<typeof apply>[0], config, root)
      ;(services.get('pdfEmbedding') as EmbeddingRegistry).register({
        descriptor: { id: 'fixture', name: 'Fixture', execution: 'local', version: '1' },
        describe: () => ({ engineId:'fixture',engineVersion:'1',model:'fixture',modelRevision:'1',dimensions,maxBatchSize:16,maxInputCharacters:16000,encoding:'fixture',fingerprint:'fixture-v1' }),
        async embed(request) { if (request.purpose === 'document') documentEncodings += request.texts.length; return request.texts.map(() => Array.from({ length: dimensions }, (_value, index) => index === 0 ? 1 : 0)) },
      })
      try {
        const execution = { agent, signal: new AbortController().signal }
        updateVolatile(config.embeddingEngine, parseConfig({ embeddingEngine: 'fixture' }).embeddingEngine)
        const opened = await tools.get('pdf_open')!.execute({ path }, execution) as { documentId: string }
        await new Promise<void>(resolve => setImmediate(resolve))
        type SearchResult = { status: string; candidates: unknown[]; searchId: string; hasMore: boolean;
          coverage: { indexedPages: number; embeddedChunks: number; totalChunks: number } }
        let warm = await tools.get('pdf_semantic_search')!.execute({ documentId: opened.documentId,
          query: 'cached document', topK: 1 }, execution) as SearchResult
        for (let step = 0; warm.hasMore && step < 200; step++) {
          warm = await tools.get('pdf_semantic_search')!.execute({ searchId: warm.searchId }, execution) as SearchResult
        }
        assert.equal(warm.status, 'complete')
        assert.equal(warm.candidates.length, 1)
        assert.equal(documentEncodings, expectedChunks)
        if (large) {
          assert.equal(warm.hasMore, false)
          assert.equal(warm.coverage.embeddedChunks, expectedChunks)
          assert.equal(warm.coverage.totalChunks, expectedChunks)
          const vectorBytes = warm.coverage.embeddedChunks * dimensions * Float32Array.BYTES_PER_ELEMENT
          assert.ok(vectorBytes > 16 * 1024 * 1024 && vectorBytes < 64 * 1024 * 1024,
            'complete unique document vectors alone must exceed the regressed 16 MiB limit')
        }
        const textReads = commands.filter(command => command === 'text').length
        resolvedAgents.length = 0
        currentResolution = resolution === 'large-index' ? 'matching' : resolution
        const search = tools.get('pdf_semantic_search')!.execute({ documentId: opened.documentId,
          query: 'cached document', topK: 1 }, execution)
        if (resolution === 'matching' || large) {
          const result = await search as { status: string; candidates: unknown[]; coverage: { indexedPages: number } }
          assert.equal(result.status, 'complete')
          assert.equal(result.candidates.length, 1)
          assert.equal(result.coverage.indexedPages, 1)
        } else {
          await assert.rejects(search, resolution === 'missing' ? /Session was retired/ : /session identity mismatch/)
        }
        assert.ok(resolvedAgents.length > 0, 'a warm index still resolves the current caller Session')
        assert.ok(resolvedAgents.every(requested => requested === sessionId))
        assert.equal(documentEncodings, expectedChunks, 'reauthorization must retain the already-built document vectors')
        assert.equal(commands.filter(command => command === 'text').length, textReads + (resolution === 'matching' || large ? 1 : 0),
          'only an authorized caller can re-attest the candidate native text; cached extraction is not rerun')
      } finally {
        for (const dispose of effects.reverse()) await dispose()
      }
    })
  }
})
