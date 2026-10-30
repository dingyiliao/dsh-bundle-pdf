import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/compatibility-manifest.mjs', import.meta.url))
// Captured from this checkout before the V2 refactor, not from an older published binary.
const fixture = new URL('./fixtures/compatibility-v1.json', import.meta.url)

test('current PDF bundle identities match the frozen pre-refactor compatibility manifest', async () => {
  const expected = JSON.parse(await readFile(fixture, 'utf8')) as {
    toolNames: string[]
    rpcMethods: string[]
    storage: { domains: Array<{ name: string }>; keyExpressions: { bookmark?: string } }
    providedServices: string[]
    patch: Array<{ id: string; name: string }>
    package: { exports: Record<string, unknown>; dsh: { client: { inject: string[] } } }
    clientExtensions: { slots: string[] }
  }
  const current = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8' })) as typeof expected
  // Model tools deliberately use a new atomic contract. Durable file/storage,
  // RPC and plugin identities below still compare with the frozen V1 fixture.
  const atomicTools = ['pdf_current', 'pdf_open', 'pdf_close', 'pdf_status', 'pdf_info', 'pdf_save',
    'pdf_page_read', 'pdf_page_render', 'pdf_page_jump', 'pdf_keyword_search', 'pdf_semantic_search',
    'pdf_evidence_read', 'pdf_form_inspect', 'pdf_form_fill', 'pdf_annotation_create',
    'pdf_annotation_list', 'pdf_annotation_update', 'pdf_annotation_delete',
    'pdf_bookmark_list', 'pdf_bookmark_edit', 'ocr_recognize', 'image_understand']
  assert.deepEqual(current, { ...expected,
    // The npm release changes package identity, while preserving every plugin row ID.
    patch: expected.patch.map(row => ({ ...row,
      name: row.name.replace('@local/dsh-pdf', '@dylanl1/dsh-plugin-pdf') })),
    // Personal bookmarks and their domain/RPC were intentionally removed.
    storage: { ...expected.storage,
      domains: expected.storage.domains.filter(domain => !domain.name.startsWith('pdf_bookmarks_')),
      keyExpressions: Object.fromEntries(Object.entries(expected.storage.keyExpressions).filter(([key]) => key !== 'bookmark')) },
    toolNames: atomicTools.sort(),
    // Read-only model choices add a settings endpoint; existing resource methods stay unchanged.
    rpcMethods: [...expected.rpcMethods.filter(method => method !== 'pdf.bookmarks'), 'pdf.engines', 'pdf.evidence', 'pdf.indexing', 'pdf.model-options', 'pdf.navigation', 'pdf.region', 'pdf.retrieval.rebuild', 'pdf.selection', 'pdf.watch'].sort(),
    providedServices: [...expected.providedServices, 'pdfAiSettings', 'pdfCapabilities', 'pdfImageEvidence', 'pdfEmbedding'].sort(),
    package: { ...expected.package, name: '@dylanl1/dsh-plugin-pdf', exports: { ...expected.package.exports,
      './capabilities': { types: './dist/types/modules/capabilities/index.d.ts', import: './dist/capabilities.js' },
      './engines': { types: './dist/types/modules/engines/index.d.ts', import: './dist/engines.js' },
      './embedding': { types: './dist/types/embedding/index.d.ts', import: './dist/embedding.js' },
    }, dsh: { ...expected.package.dsh,
      client: { ...expected.package.dsh.client,
        inject: [...expected.package.dsh.client.inject.slice(0, -1), '@deepseek-ai/dsh-client-ui-tool',
          ...expected.package.dsh.client.inject.slice(-1)] } } },
    clientExtensions: { ...expected.clientExtensions,
      slots: [...expected.clientExtensions.slots, 'tool.call.toolview'].sort() },
  },
    'A public bundle surface changed. Review compatibility before updating compatibility-v1.json.')
})
