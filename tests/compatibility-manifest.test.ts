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
    providedServices: string[]
    package: { dsh: { client: { inject: string[] } } }
    clientExtensions: { slots: string[] }
  }
  const current = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8' })) as typeof expected
  // V2 adds bounded evidence reads and separately approved model writes;
  // the ten tools already available to existing agent sessions stay stable.
  const addedTools = ['pdf_annotate', 'pdf_context', 'pdf_image_context', 'pdf_locate', 'pdf_save', 'pdf_status']
  assert.deepEqual(current, { ...expected,
    toolNames: [...expected.toolNames, ...addedTools].sort(),
    rpcMethods: [...expected.rpcMethods, 'pdf.evidence', 'pdf.region', 'pdf.selection'].sort(),
    providedServices: [...expected.providedServices, 'pdfImageEvidence'].sort(),
    package: { ...expected.package, dsh: { ...expected.package.dsh,
      client: { ...expected.package.dsh.client,
        inject: [...expected.package.dsh.client.inject.slice(0, -1), '@deepseek-ai/dsh-client-ui-tool',
          ...expected.package.dsh.client.inject.slice(-1)] } } },
    clientExtensions: { ...expected.clientExtensions,
      slots: [...expected.clientExtensions.slots, 'tool.call.toolview'].sort() },
  },
    'A public bundle surface changed. Review compatibility before updating compatibility-v1.json.')
})
