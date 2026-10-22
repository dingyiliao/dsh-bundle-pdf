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
    package: { exports: Record<string, unknown>; dsh: { client: { inject: string[] } } }
    clientExtensions: { slots: string[] }
  }
  const current = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8' })) as typeof expected
  // V2 adds bounded evidence reads, direct draft edits and approved saves;
  // existing read-tool names remain; intentional surface removals are listed below.
  const addedTools = ['pdf_annotate', 'pdf_annotation_update', 'pdf_annotation_delete',
    'pdf_context', 'pdf_find_related', 'pdf_image_context', 'pdf_locate', 'pdf_navigate', 'pdf_outline_edit', 'pdf_save', 'pdf_status',
    'pdf_form_inspect_page', 'pdf_fill_form']
  assert.deepEqual(current, { ...expected,
    // Personal bookmarks and their domain/RPC were intentionally removed.
    storage: { ...expected.storage,
      domains: expected.storage.domains.filter(domain => !domain.name.startsWith('pdf_bookmarks_')),
      keyExpressions: Object.fromEntries(Object.entries(expected.storage.keyExpressions).filter(([key]) => key !== 'bookmark')) },
    toolNames: [...expected.toolNames, ...addedTools].sort(),
    rpcMethods: [...expected.rpcMethods.filter(method => method !== 'pdf.bookmarks'), 'pdf.evidence', 'pdf.navigation', 'pdf.region', 'pdf.selection', 'pdf.watch'].sort(),
    providedServices: [...expected.providedServices, 'pdfCapabilities', 'pdfImageEvidence'].sort(),
    package: { ...expected.package, exports: { ...expected.package.exports,
      './capabilities': { types: './dist/types/modules/capabilities/index.d.ts', import: './dist/capabilities.js' },
    }, dsh: { ...expected.package.dsh,
      client: { ...expected.package.dsh.client,
        inject: [...expected.package.dsh.client.inject.slice(0, -1), '@deepseek-ai/dsh-client-ui-tool',
          ...expected.package.dsh.client.inject.slice(-1)] } } },
    clientExtensions: { ...expected.clientExtensions,
      slots: [...expected.clientExtensions.slots, 'tool.call.toolview'].sort() },
  },
    'A public bundle surface changed. Review compatibility before updating compatibility-v1.json.')
})
