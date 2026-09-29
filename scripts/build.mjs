import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, readdir, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const dist = join(project, 'dist')
const require = createRequire(import.meta.url)
const packageRoot = (name) => dirname(require.resolve(`${name}/package.json`))
const pdfRoot = packageRoot('pdfjs-dist')
const tesseractRoot = packageRoot('tesseract.js')
const coreRoot = packageRoot('tesseract.js-core')

await mkdir(dist, { recursive: true })

// The extension entries ship a public type surface without pulling Host/UI
// development-only declarations into an external engine plugin.
await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', 'tsconfig.ocr.json'], {
    cwd: project, stdio: 'inherit', windowsHide: true,
  })
  child.once('error', rejectBuild)
  child.once('close', (code) => code === 0 ? resolveBuild() : rejectBuild(new Error(`OCR declaration build exited with status ${code}`)))
})

const binaryAssets = {}
for (const [kind, directory] of [['cMapUrl', 'cmaps'], ['standardFontDataUrl', 'standard_fonts'], ['wasmUrl', 'wasm']]) {
  const source = join(pdfRoot, directory)
  const files = (await readdir(source, { withFileTypes: true })).filter((file) => file.isFile() && !file.name.startsWith('LICENSE')).sort((a, b) => a.name.localeCompare(b.name))
  binaryAssets[kind] = Object.fromEntries(await Promise.all(files.map(async (file) => [file.name, (await readFile(join(source, file.name))).toString('base64')])))
}
const workerSource = await readFile(join(pdfRoot, 'build/pdf.worker.min.mjs'), 'utf8')

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
  ...common, entryPoints: ['src/host/index.ts'], outfile: 'dist/index.js',
  platform: 'node', target: 'node22', format: 'esm', external: ['@deepseek-ai/*', 'pdfjs-dist/*'],
  banner: { js: 'import { createRequire as __pdfCreateRequire } from "node:module";\nconst require = __pdfCreateRequire(import.meta.url);' },
})

// The Harness client loader supplies the shared React and Cordis module instances.
const clientBuild = await build({
  ...browser, entryPoints: ['src/client/index.tsx'], outfile: 'dist/client.js',
  write: false, format: 'cjs', external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
  jsx: 'automatic', loader: { '.css': 'text' },
  define: {
    ...browser.define,
    __PDF_PLUGIN_WORKER_SOURCE__: JSON.stringify(workerSource),
    __PDF_PLUGIN_BINARY_ASSETS__: JSON.stringify(binaryAssets),
  },
  // PDF.js contains import.meta.url only in its unused Node/fake-worker branches.
  logOverride: { 'empty-import-meta': 'silent' },
})
const clientCode = clientBuild.outputFiles.find((file) => file.path.endsWith('client.js'))?.text
if (!clientCode) throw new Error('The PDF client build did not produce JavaScript.')
await writeFile(join(dist, 'client.js'), `window.__ModuleLoader__.load({\n  id: "@local/dsh-pdf",\n  factory(require) {\n    const module = { exports: {} };\n    const exports = module.exports;\n${clientCode}\n    return module.exports;\n  }\n});\n`, 'utf8')

const ocrBuild = await build({
  ...browser, entryPoints: ['src/ocr/index.ts'], outfile: 'dist/ocr.js', format: 'esm',
})
const translationBuild = await build({
  ...browser, entryPoints: ['src/translation/index.ts'], outfile: 'dist/translation.js', format: 'esm',
})
const dictionaryBuild = await build({
  ...browser, entryPoints: ['src/client/native-dictionary.ts'], outfile: 'dist/native-dictionary.js', format: 'esm',
})
const bridgeBuild = await build({
  ...browser, entryPoints: ['src/ocr/local-worker.ts'], outfile: 'dist/assets/ocr/bridge.js', format: 'esm',
})

const assetFiles = ['ocr/bridge.js']
async function copyAsset(source, destination) {
  const target = join(dist, 'assets', ...destination.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  assetFiles.push(destination)
}
await copyAsset(join(tesseractRoot, 'dist/worker.min.js'), 'ocr/worker.min.js')
for (const file of (await readdir(coreRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && /^tesseract-core.*\.(?:js|wasm)$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
  await copyAsset(join(coreRoot, file.name), `ocr/core/${file.name}`)
}
for (const language of ['eng', 'chi_sim']) {
  await copyAsset(join(packageRoot(`@tesseract.js-data/${language}`), '4.0.0_best_int', `${language}.traineddata.gz`), `ocr/lang/${language}.traineddata.gz`)
}
const manifestFiles = await Promise.all(assetFiles.sort().map(async (path) => {
  const bytes = await readFile(join(dist, 'assets', ...path.split('/')))
  const contentType = extname(path) === '.js' ? 'text/javascript; charset=utf-8'
    : extname(path) === '.wasm' ? 'application/wasm' : 'application/octet-stream'
  return { path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), contentType }
}))
await writeFile(join(dist, 'assets/manifest.json'), `${JSON.stringify({ version: 1, files: manifestFiles }, null, 2)}\n`, 'utf8')

// Keep bundled dependency notices with the distributable, including embedded font/WASM assets.
const roots = new Set([pdfRoot, tesseractRoot, coreRoot, packageRoot('@tesseract.js-data/eng'), packageRoot('@tesseract.js-data/chi_sim')])
for (const result of [hostBuild, clientBuild, ocrBuild, translationBuild, dictionaryBuild, bridgeBuild]) {
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
  const directories = root === pdfRoot ? ['', 'cmaps', 'standard_fonts', 'wasm'] : ['']
  let included = false
  for (const directory of directories) {
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
console.log(`Built @local/dsh-pdf: Host, Harness Client, OCR/translation/dictionary SDKs, and ${manifestFiles.length} local OCR resources.`)
