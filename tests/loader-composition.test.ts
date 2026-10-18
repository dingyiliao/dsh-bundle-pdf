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
  nativeResolvedEntry: string
  ocrResolvedEntry: string
  imageResolvedEntry: string
  exportNames: string[]
  nativeExportNames: string[]
  ocrExportNames: string[]
  imageExportNames: string[]
  hasDefaultExport: boolean
  unwrappedSameModule: boolean
  name: string
  inject: string[]
  applyType: string
  configPresent: boolean
  nativeName: string
  nativeProvide: string
  nativeApplyType: string
  ocrName: string
  ocrProvide: string
  ocrInject: string[]
  ocrApplyType: string
  imageName: string
  imageProvide: string
  imageInject: string[]
  imageApplyType: string
  imageConfig: { backend: string }
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
  assert.equal(report.nativeResolvedEntry, pathToFileURL(join(root, 'dist', 'native-provider.js')).href)
  assert.equal(report.ocrResolvedEntry, pathToFileURL(join(root, 'dist', 'ocr-host.js')).href)
  assert.equal(report.imageResolvedEntry, pathToFileURL(join(root, 'dist', 'image-host.js')).href)
  assert.equal(report.hasDefaultExport, false)
  assert.ok(report.exportNames.includes('inject'))
  assert.ok(report.nativeExportNames.includes('provide'))
  assert.ok(report.ocrExportNames.includes('provide'))
  assert.ok(report.imageExportNames.includes('provide'))
  assert.equal(report.unwrappedSameModule, true)
  assert.equal(report.name, 'pdf-reader')
  assert.deepEqual(report.inject, [
    'connection', 'sessionController', 'fs', 'sandboxPolicy', 'storageDomain', 'loader', 'tools', 'pdfNative', 'subprocess',
  ])
  assert.equal(report.applyType, 'function')
  assert.equal(report.configPresent, true)
  assert.equal(report.nativeName, 'pdf-native')
  assert.equal(report.nativeProvide, 'pdfNative')
  assert.equal(report.nativeApplyType, 'function')
  assert.equal(report.ocrName, 'image-ocr')
  assert.equal(report.ocrProvide, 'ocr')
  assert.deepEqual(report.ocrInject, ['tools'])
  assert.equal(report.ocrApplyType, 'function')
  assert.equal(report.imageName, 'image-understanding')
  assert.equal(report.imageProvide, 'imageUnderstanding')
  assert.deepEqual(report.imageInject, ['connection', 'sessionController'])
  assert.equal(report.imageApplyType, 'function')
  assert.deepEqual(report.imageConfig, { backend: 'session-vision' })
})
