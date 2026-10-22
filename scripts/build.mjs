import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, readdir, mkdir, rm, writeFile, copyFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const dist = join(project, 'dist')
const require = createRequire(import.meta.url)
const packageRoot = (name) => dirname(require.resolve(`${name}/package.json`))
const tesseractRoot = packageRoot('tesseract.js')
const coreRoot = packageRoot('tesseract.js-core')

await mkdir(dist, { recursive: true })
// Declarations are generated artifacts. Remove old paths before rebuilding so
// moved source files cannot leave importable, stale type surfaces in a release.
await rm(join(dist, 'types'), { recursive: true, force: true })

// The extension entries ship a public type surface without pulling Host/UI
// development-only declarations into an external engine plugin.
await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', 'tsconfig.ocr.json'], {
    cwd: project, stdio: 'inherit', windowsHide: true,
  })
  child.once('error', rejectBuild)
  child.once('close', (code) => code === 0 ? resolveBuild() : rejectBuild(new Error(`OCR declaration build exited with status ${code}`)))
})
await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', 'tsconfig.image-host.json'], {
    cwd: project, stdio: 'inherit', windowsHide: true })
  child.once('error', rejectBuild)
  child.once('close', (code) => code === 0 ? resolveBuild() : rejectBuild(new Error(`Image Host declaration build exited with status ${code}`)))
})
await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', 'tsconfig.capabilities.json'], {
    cwd: project, stdio: 'inherit', windowsHide: true })
  child.once('error', rejectBuild)
  child.once('close', (code) => code === 0 ? resolveBuild() : rejectBuild(new Error(`Capability declaration build exited with status ${code}`)))
})

const common = {
  absWorkingDir: project,
  bundle: true,
  minify: false,
  sourcemap: false,
  metafile: true,
  legalComments: 'inline',
  logLevel: 'info',
}
const browser = {
  ...common, platform: 'browser', target: ['chrome120', 'firefox121', 'safari17.4'],
  mainFields: ['browser', 'module', 'main'],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
}

// Host imports belong to the installed Harness profile, not to a second bundled runtime.
const hostBuild = await build({
  ...common, entryPoints: ['src/entrypoints/reader-host.ts'], outfile: 'dist/index.js',
  platform: 'node', target: 'node22', format: 'esm', external: ['@deepseek-ai/*'],
  banner: { js: 'import { createRequire as __pdfCreateRequire } from "node:module";\nconst require = __pdfCreateRequire(import.meta.url);' },
})
const nativeProviderBuild = await build({
  ...common, entryPoints: ['src/entrypoints/native-host.ts'], outfile: 'dist/native-provider.js',
  platform: 'node', target: 'node22', format: 'esm', external: ['@deepseek-ai/*'],
})
const ocrHostBuild = await build({
  ...common, entryPoints: ['src/entrypoints/ocr-host.ts'], outfile: 'dist/ocr-host.js',
  platform: 'node', target: 'node22', format: 'esm', external: ['@deepseek-ai/*'],
})
const imageHostBuild = await build({
  ...common, entryPoints: ['src/entrypoints/image-understanding-host.ts'], outfile: 'dist/image-host.js',
  platform: 'node', target: 'node22', format: 'esm', external: ['@deepseek-ai/*'],
})

// The Harness client loader supplies these shared platform modules. Bundle
// pure DSH utilities such as workspace-path locally: they are not Client
// module rows or entries in the shell's frozen shared-module table.
const clientWrapperStart = 'window.__ModuleLoader__.load({\n  id: "@local/dsh-pdf",\n  factory(require) {\n    const module = { exports: {} };\n    const exports = module.exports;\n'
const clientWrapperEnd = '\n    return module.exports;\n  }\n});\n'
const browserCoverage = process.env.DSH_PDF_BROWSER_COVERAGE === '1'
const clientBuild = await build({
  ...browser, entryPoints: ['src/entrypoints/reader-client.tsx'], outfile: 'dist/client.js',
  write: false, format: 'cjs', external: [
    'react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/cordis',
  ],
  jsx: 'automatic', loader: { '.css': 'text' },
  // In coverage builds, esbuild must know the loader wrapper's line offset.
  ...(browserCoverage ? {
    sourcemap: 'external',
    banner: { js: clientWrapperStart },
    footer: { js: clientWrapperEnd },
  } : {}),
})
const clientCode = clientBuild.outputFiles.find((file) => file.path.endsWith('client.js'))?.text
if (!clientCode) throw new Error('The PDF client build did not produce JavaScript.')
await writeFile(join(dist, 'client.js'), browserCoverage
  ? clientCode
  : `${clientWrapperStart}${clientCode}${clientWrapperEnd}`, 'utf8')
if (browserCoverage) {
  const clientMap = clientBuild.outputFiles.find((file) => file.path.endsWith('client.js.map'))?.text
  if (!clientMap) throw new Error('The PDF client coverage build did not produce a source map.')
  await writeFile(join(dist, 'client.js.map'), clientMap, 'utf8')
} else {
  // A later normal build must not leave a stale opt-in coverage map beside it.
  await unlink(join(dist, 'client.js.map')).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
}

const ocrBuild = await build({
  ...browser, entryPoints: ['src/ocr/index.ts'], outfile: 'dist/ocr.js', format: 'esm',
})
const translationBuild = await build({
  ...browser, entryPoints: ['src/translation/index.ts'], outfile: 'dist/translation.js', format: 'esm',
})
const capabilityBuild = await build({
  ...common, entryPoints: ['src/modules/capabilities/index.ts'], outfile: 'dist/capabilities.js',
  platform: 'node', target: 'node22', format: 'esm', external: ['@deepseek-ai/*'],
})
const bridgeBuild = await build({
  ...browser, entryPoints: ['src/ocr/local-worker.ts'], outfile: 'dist/assets/ocr/bridge.js', format: 'esm',
})

const assetFiles = ['ocr/bridge.js']
async function copyAsset(source, destination, publish = true) {
  const target = join(dist, 'assets', ...destination.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  if (publish) assetFiles.push(destination)
}
await copyAsset(join(tesseractRoot, 'dist/worker.min.js'), 'ocr/worker.min.js')
for (const file of (await readdir(coreRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && /^tesseract-core.*\.(?:js|wasm)$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
  await copyAsset(join(coreRoot, file.name), `ocr/core/${file.name}`)
}
for (const language of ['eng', 'chi_sim']) {
  await copyAsset(join(packageRoot(`@tesseract.js-data/${language}`), '4.0.0_best_int', `${language}.traineddata.gz`), `ocr/lang/${language}.traineddata.gz`)
}
// The form font is read by the Host writer only. Do not expose its 16 MB bytes
// through the browser asset route or expand that route's MIME allowlist.
await copyAsset(join(project, 'assets/fonts/NotoSansCJKsc-Regular.otf'), 'forms/NotoSansCJKsc-Regular.otf', false)
await copyAsset(join(project, 'assets/fonts/OFL.txt'), 'forms/OFL.txt', false)
const manifestFiles = await Promise.all(assetFiles.sort().map(async (path) => {
  const bytes = await readFile(join(dist, 'assets', ...path.split('/')))
  const contentType = extname(path) === '.js' ? 'text/javascript; charset=utf-8'
    : extname(path) === '.wasm' ? 'application/wasm'
      : extname(path) === '.otf' ? 'font/otf'
        : extname(path) === '.txt' ? 'text/plain; charset=utf-8' : 'application/octet-stream'
  return { path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), contentType }
}))
await writeFile(join(dist, 'assets/manifest.json'), `${JSON.stringify({ version: 1, files: manifestFiles }, null, 2)}\n`, 'utf8')

// Keep bundled dependency notices with the distributable, including OCR assets.
const roots = new Set([tesseractRoot, coreRoot, packageRoot('@tesseract.js-data/eng'), packageRoot('@tesseract.js-data/chi_sim')])
for (const result of [hostBuild, nativeProviderBuild, ocrHostBuild, imageHostBuild, clientBuild, ocrBuild, translationBuild, capabilityBuild, bridgeBuild]) {
  for (const input of Object.keys(result.metafile.inputs)) {
    const normalized = input.replaceAll('\\', '/')
    const match = normalized.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/)
    if (match) roots.add(resolve(project, 'node_modules', ...match[1].split('/')))
  }
}
const notices = ['# Third-party software notices', '', 'This plugin includes the following dependencies and local runtime assets.', '']
for (const root of [...roots].sort()) {
  let metadata
  try { metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) } catch { continue }
  notices.push(`## ${metadata.name} ${metadata.version}`, '', `License: ${typeof metadata.license === 'string' ? metadata.license : JSON.stringify(metadata.license ?? 'See dependency source')}`, '')
  let included = false
  for (const directory of ['']) {
    const location = join(root, directory)
    const files = (await readdir(location, { withFileTypes: true })).filter((file) => file.isFile() && /^(?:licen[cs]e|notice|copying)(?:$|[._-])/i.test(file.name)).sort((a, b) => a.name.localeCompare(b.name))
    for (const file of files) {
      notices.push(`### ${relative(root, join(location, file.name)).replaceAll('\\', '/')}`, '', await readFile(join(location, file.name), 'utf8'), '')
      included = true
    }
  }
  if (!included && metadata.repository) notices.push(`Source: ${typeof metadata.repository === 'string' ? metadata.repository : metadata.repository.url}`, '')
}
await writeFile(join(dist, 'THIRD_PARTY_NOTICES.md'), `${notices.join('\n')}\n`, 'utf8')
console.log(`Built @local/dsh-pdf: Host, OCR/Image Host plugins, Harness Client, OCR/translation/capability SDKs, and ${manifestFiles.length} local OCR resources.`)
