import { writeFile } from 'node:fs/promises'
import { boot } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
if (!configPath) throw new Error('The PDF Loader smoke needs a config path')

const ctx = await boot('pdf-built-entry-smoke', configPath)
try {
  // Use Loader's module importer and the package's published export. A direct
  // source import would miss export-map and build failures.
  const mod = await ctx.loader.import('@local/dsh-pdf')
  const plugin = ctx.loader.unwrapExports(mod)
  const nativeMod = await ctx.loader.import('@local/dsh-pdf/native')
  const nativePlugin = ctx.loader.unwrapExports(nativeMod)
  await writeFile('loader-entry-report.json', JSON.stringify({
    resolvedEntry: import.meta.resolve('@local/dsh-pdf'),
    nativeResolvedEntry: import.meta.resolve('@local/dsh-pdf/native'),
    exportNames: Object.keys(mod).sort(),
    nativeExportNames: Object.keys(nativeMod).sort(),
    hasDefaultExport: 'default' in mod,
    unwrappedSameModule: plugin === mod,
    name: plugin.name,
    inject: plugin.inject,
    applyType: typeof plugin.apply,
    configPresent: plugin.Config !== undefined,
    nativeName: nativePlugin.name,
    nativeProvide: nativePlugin.provide,
    nativeApplyType: typeof nativePlugin.apply,
  }))
} finally {
  await ctx.fiber.dispose()
}
