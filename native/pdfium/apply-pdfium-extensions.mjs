import { execFileSync } from 'node:child_process'
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { applyFormIdentityPatch } from './apply-form-identity-patch.mjs'
import { applyFormFontPatch } from './apply-form-font-patch.mjs'
import { applyObjectGenerationPatch } from './apply-object-generation-patch.mjs'

if (!process.argv[2]) throw new Error('Pass the path to the pinned PDFium checkout')
const checkout = resolve(process.argv[2])
const lock = JSON.parse(await readFile(new URL('../../native/dependencies.json', import.meta.url)))
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim()
if (revision !== lock.pdfium.sourceRevision) {
  throw new Error('Pass a PDFium checkout at the revision pinned in native/dependencies.json')
}

const extensions = new URL('./pdfium-extension/', import.meta.url)
const names = (await readdir(extensions)).filter(name => /^dsh_[a-z_]+\.(cc|h)$/.test(name)).sort()
if (!names.length || names.some(name => !names.includes(name.replace(/\.(cc|h)$/, name.endsWith('.cc') ? '.h' : '.cc')))) {
  throw new Error('Every PDFium extension must have a source and a public header')
}

async function register(file, anchor, entries) {
  const path = join(checkout, file)
  const source = await readFile(path, 'utf8')
  const lines = entries.filter(entry => !source.includes(entry))
  if (!lines.length) return
  if (source.split(anchor).length !== 2) throw new Error(`Unexpected PDFium GN anchor in ${file}`)
  await writeFile(path, source.replace(anchor, [anchor, ...lines].join('\n')))
}

async function replaceOnce(file, before, after) {
  const path = join(checkout, file)
  const source = await readFile(path, 'utf8')
  if (source.includes(after)) return
  if (source.split(before).length !== 2) throw new Error(`Unexpected PDFium source in ${file}`)
  await writeFile(path, source.replace(before, after))
}

// The standalone target needs C exports even with Chromium component builds
// off. Keeping component builds off lets the SDK ship one shared library.
await replaceOnce('BUILD.gn', 'component("pdfium") {', 'shared_library("pdfium") {')
await replaceOnce('public/fpdfview.h', '#if defined(COMPONENT_BUILD)\n// FPDF_EXPORT',
  '#if 1  // DSH standalone shared SDK\n// FPDF_EXPORT')
await applyFormIdentityPatch(replaceOnce)
await applyFormFontPatch(checkout, replaceOnce, register)
await applyObjectGenerationPatch(replaceOnce)

for (const name of names) {
  await copyFile(new URL(name, extensions), join(checkout, name.endsWith('.h') ? 'public' : 'fpdfsdk', name))
}
await register('fpdfsdk/BUILD.gn', '    "fpdf_annot.cpp",',
  names.filter(name => name.endsWith('.cc')).map(name => `    "${name}",`))
await register('BUILD.gn', '    "public/fpdf_annot.h",',
  names.filter(name => name.endsWith('.h')).map(name => `    "public/${name}",`))
if (names.includes('dsh_metadata.cc')) {
  await register('fpdfsdk/BUILD.gn', '    "../core/fdrm",', ['    "../third_party:zlib",'])
}
