import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceRoot = join(root, 'src')
const failures = []

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path)
  }
  return files
}

const output = join(tmpdir(), `pdf-architecture-${process.pid}.json`)
execFileSync(process.execPath, [join(root, 'scripts', 'architecture-metrics.mjs'), output], { cwd: root, stdio: 'ignore' })
const report = JSON.parse(await readFile(output, 'utf8'))
const totals = report.totals
if (totals.hostToClientDirectImports !== 0) failures.push(`Host imports Client: ${totals.hostToClientDirectImports}`)
if (totals.clientToHostDirectImports !== 0) failures.push(`Client imports Host: ${totals.clientToHostDirectImports}`)

// Feature modules may not depend on each other cyclically.
const graph = new Map(Object.entries(report.moduleDependencies).map(([name, targets]) => [name, new Set(targets)]))
const seen = new Set()
const visiting = []
function visit(name) {
  const at = visiting.indexOf(name)
  if (at !== -1) { failures.push(`Feature-module cycle: ${[...visiting.slice(at), name].join(' -> ')}`); return }
  if (seen.has(name)) return
  visiting.push(name)
  for (const target of graph.get(name) ?? []) visit(target)
  visiting.pop()
  seen.add(name)
}
for (const name of graph.keys()) visit(name)

// The UI layer lives in client/; domain modules stay environment-neutral.
try { await stat(join(sourceRoot, 'modules', 'viewer')) ; failures.push('src/modules/viewer returned') } catch { /* expected */ }
try { await stat(join(sourceRoot, 'client', 'viewer', 'index.ts')) } catch { failures.push('src/client/viewer/index.ts is missing') }
const moduleFiles = await walk(join(sourceRoot, 'modules'))
for (const file of moduleFiles) {
  const text = await readFile(file, 'utf8')
  if (/(?:from|import)\s*\(?\s*['"]react(?:-dom)?(?:['"/])/.test(text)) {
    failures.push(`Domain module imports React: ${file.slice(root.length + 1)}`)
  }
}

// Ratchet: the Client surface may shrink, not grow.
const viewerFiles = (await walk(join(sourceRoot, 'client', 'viewer'))).length
const viewerLines = (await Promise.all((await walk(join(sourceRoot, 'client', 'viewer'))).map(async file =>
  (await readFile(file, 'utf8')).split(/\r?\n/).length))).reduce((sum, lines) => sum + lines, 0)
const reader = report.complexityHotspots.find(item => item.file === 'src/client/Reader.tsx')
if (viewerFiles > 110) failures.push(`viewer file budget exceeded: ${viewerFiles} > 110`)
if (viewerLines > 14000) failures.push(`viewer line budget exceeded: ${viewerLines} > 14000`)
if (reader && reader.complexity > 80) failures.push(`Reader complexity grew: ${reader.complexity} > 80`)

if (failures.length) {
  for (const failure of failures) console.error(`architecture: ${failure}`)
  process.exit(1)
}
console.log(`architecture: ok (${totals.files} files, ${totals.physicalLines} lines, ${viewerFiles} viewer files, `
  + `${viewerLines} viewer lines, no Host/Client inversion, no feature-module cycle)`)
