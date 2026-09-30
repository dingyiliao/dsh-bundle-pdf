import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

interface EntryReport {
  resolvedEntry: string
  exportNames: string[]
  hasDefaultExport: boolean
  unwrappedSameModule: boolean
  name: string
  inject: string[]
  applyType: string
  configPresent: boolean
}

test('Loader resolves the published PDF Host entry from its built export', { timeout: 45_000 }, async () => {
  let report: EntryReport | undefined
  await runLoaderSmoke({
    label: 'PDF built Host entry',
    tempDirPrefix: 'dsh-pdf-built-entry-',
    binScript: fixture('loader-entry-driver.mjs'),
    libBinScript: fixture('loader-entry-driver.mjs'),
    configPath: fixture('loader-entry.cordis.yml'),
    tsconfigPath: join(root, 'tsconfig.json'),
    mode: 'lib',
    inspect: async (cwd) => {
      report = JSON.parse(await readFile(join(cwd, 'loader-entry-report.json'), 'utf8')) as EntryReport
    },
  })

  assert.ok(report)
  assert.equal(report.resolvedEntry, pathToFileURL(join(root, 'dist', 'index.js')).href)
  assert.equal(report.hasDefaultExport, false)
  assert.ok(report.exportNames.includes('inject'))
  assert.equal(report.unwrappedSameModule, true)
  assert.equal(report.name, 'pdf-reader')
  assert.deepEqual(report.inject, [
    'connection', 'sessionController', 'fs', 'sandboxPolicy', 'storageDomain', 'loader',
  ])
  assert.equal(report.applyType, 'function')
  assert.equal(report.configPresent, true)
})
