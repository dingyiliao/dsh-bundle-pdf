import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode } from '@jridgewell/sourcemap-codec'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const [nodeReport, browserReport, nativeReport, outputPath] = process.argv.slice(2)
if (!nodeReport || !browserReport || !nativeReport) {
  throw new Error('Usage: node scripts/report-project-coverage.mjs <node.lcov> <browser.lcov> <native.lcov> [report.json]')
}

async function projectSources(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await projectSources(path))
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(relative(root, path).split(sep).join('/'))
    }
  }
  return files
}

/** Count source lines that can emit JavaScript, not TS-only types or comments. */
async function emittedSourceLines(path) {
  const source = await readFile(join(root, path), 'utf8')
  const built = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      sourceMap: true,
      removeComments: true,
    },
  })
  if (!built.sourceMapText) throw new Error(`No TypeScript source map for ${path}`)
  const map = JSON.parse(built.sourceMapText)
  const mapped = new Set(decode(map.mappings).flat().filter(segment => segment.length >= 4)
    .map(segment => segment[2] + 1))
  const sourceLines = source.split(/\r?\n/)
  // Static imports are compile-time module linkage in the shipped esbuild
  // bundles, not independently executable Client statements. transpileModule
  // retains ESM imports and maps their source lines, but the actual bundle
  // eliminates that syntax, so no browser V8 range can hit it. Keep this
  // exclusion explicit and auditable instead of treating it as missed code.
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const linkage = new Set()
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const first = tree.getLineAndCharacterOfPosition(statement.getStart(tree)).line + 1
    const last = tree.getLineAndCharacterOfPosition(statement.end).line + 1
    for (let line = first; line <= last; line++) {
      if (mapped.has(line)) linkage.add(line)
    }
  }
  for (const line of linkage) mapped.delete(line)
  // TypeScript also maps a standalone closing brace to the end of a generated
  // block, though V8 may never attribute an execution count to that delimiter.
  // Exclude only that non-executable structural line; retain `} else {`, `};`
  // and every other line where syntax can carry an independent operation.
  const structural = [...mapped].filter(line => /^\s*}\s*$/.test(sourceLines[line - 1] ?? ''))
  for (const line of structural) mapped.delete(line)
  return { lines: mapped, excludedStructuralLines: structural.sort((a, b) => a - b),
    excludedLinkageLines: [...linkage].sort((a, b) => a - b) }
}

function parseLcov(source) {
  const files = new Map()
  let current
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const absolute = resolve(root, line.slice(3))
      const path = relative(root, absolute).split(sep).join('/')
      if (path.startsWith('../') || path === '..') throw new Error(`Coverage source escapes the project: ${line}`)
      current = files.get(path) ?? { path, lines: new Map(), branches: [], functionLines: new Map(), functionHits: new Map(), lineTotal: 0, lineCovered: 0 }
      files.set(path, current)
    } else if (line.startsWith('DA:') && current) {
      const [number, hits] = line.slice(3).split(',').map(Number)
      if (!Number.isSafeInteger(number) || number < 1 || !Number.isFinite(hits) || hits < 0) {
        throw new Error(`Invalid LCOV line: ${line}`)
      }
      current.lines.set(number, Math.max(current.lines.get(number) ?? 0, hits))
    } else if (line.startsWith('BRDA:') && current) {
      current.branches.push(line.slice(5))
    } else if (line.startsWith('FN:') && current) {
      const separator = line.indexOf(',', 3)
      const number = Number(line.slice(3, separator))
      // Node sometimes gives class field initializers an undefined source line.
      if (separator < 0 || line.slice(3, separator) !== 'undefined' && (!Number.isSafeInteger(number) || number < 1)) {
        throw new Error(`Invalid LCOV function: ${line}`)
      }
      const name = line.slice(separator + 1)
      const lines = current.functionLines.get(name) ?? []
      // Keep undefined positions so a later same-named FNDA cannot be
      // mistakenly paired with the only declaration that has a known line.
      lines.push(Number.isSafeInteger(number) && number >= 1 ? number : undefined)
      current.functionLines.set(name, lines)
    } else if (line.startsWith('FNDA:') && current) {
      const separator = line.indexOf(',', 5)
      const hits = Number(line.slice(5, separator))
      if (separator < 0 || !Number.isFinite(hits) || hits < 0) throw new Error(`Invalid LCOV function count: ${line}`)
      const name = line.slice(separator + 1)
      const counts = current.functionHits.get(name) ?? []
      counts.push(hits)
      current.functionHits.set(name, counts)
    } else if (line.startsWith('LF:') && current) {
      current.lineTotal = Math.max(current.lineTotal, Number(line.slice(3)))
    } else if (line.startsWith('LH:') && current) {
      current.lineCovered = Math.max(current.lineCovered, Number(line.slice(3)))
    } else if (line === 'end_of_record') {
      current = undefined
    }
  }
  return files
}

const lanes = [
  { name: 'Node/Host', path: nodeReport },
  { name: 'Browser/Client', path: browserReport },
  { name: 'Native/C++', path: nativeReport },
]
for (const lane of lanes) lane.files = parseLcov(await readFile(resolve(lane.path), 'utf8'))

const expected = [...await projectSources(join(root, 'src')), 'native/pdfium-worker.cpp'].sort()
const unexpected = lanes.flatMap(lane => [...lane.files.keys()].filter(path => !path.endsWith('.d.ts') && !expected.includes(path)))
if (unexpected.length) throw new Error(`Unexpected coverage sources: ${[...new Set(unexpected)].join(', ')}`)
const nativeSource = lanes[2].files.get('native/pdfium-worker.cpp')
if (!nativeSource || nativeSource.lineTotal < 1 || nativeSource.lines.size === 0) {
  throw new Error('Native LCOV must contain measured lines for native/pdfium-worker.cpp; an empty native lane cannot establish project-wide coverage.')
}

const files = []
for (const path of expected) {
  const measurements = lanes.filter(lane => lane.files.has(path))
  const merged = new Map()
  for (const lane of measurements) {
    const record = lane.files.get(path)
    for (const [line, hits] of record.lines) {
      merged.set(line, Math.max(merged.get(line) ?? 0, hits))
    }
    // V8 can report an invocation while attributing zero DA hits to its
    // declaration header. LCOV pairs FN and FNDA by *name*, not a stable ID;
    // many React callbacks share names such as "onClick". For an ambiguous
    // name, a mixed hit/miss group cannot identify which declaration ran, so
    // do not invent a hit for either header. If every occurrence was invoked,
    // all corresponding declaration lines are unambiguously covered.
    for (const [name, counts] of record.functionHits) {
      const lines = record.functionLines.get(name) ?? []
      if (lines.length === 0 || lines.length !== counts.length || lines.some(line => line === undefined)) continue
      if (lines.length === 1) {
        if (counts[0] > 0) merged.set(lines[0], Math.max(merged.get(lines[0]) ?? 0, counts[0]))
      } else if (lines.every(line => line === lines[0]) && counts.some(hits => hits > 0)) {
        // Multiple closures can start on one source line. Their identities
        // are ambiguous, but any invocation proves that shared line ran.
        merged.set(lines[0], Math.max(merged.get(lines[0]) ?? 0, 1))
      } else if (counts.every(hits => hits > 0)) {
        for (const line of lines) merged.set(line, Math.max(merged.get(line) ?? 0, 1))
      }
    }
  }
  const emitted = path === 'native/pdfium-worker.cpp' ? undefined : await emittedSourceLines(path)
  const measuredLines = emitted
    ? emitted.lines.size : measurements[0]?.files.get(path).lineTotal ?? merged.size
  const measuredCovered = emitted
    ? [...emitted.lines].filter(line => (merged.get(line) ?? 0) > 0).length
    : measurements[0]?.files.get(path).lineCovered ?? [...merged.values()].filter(hits => hits > 0).length
  files.push({ path, lanes: measurements.map(lane => lane.name),
    lines: measuredLines, covered: measuredCovered,
    // No emitted JavaScript is expected from a type-only source file.
    missingInstrumentation: measurements.length === 0 && measuredLines > 0,
    excludedStructuralLines: emitted?.excludedStructuralLines ?? [],
    excludedLinkageLines: emitted?.excludedLinkageLines ?? [],
    ignoredMappedHits: emitted ? [...merged].filter(([line, hits]) => hits > 0 && !emitted.lines.has(line)).length : 0,
    uncoveredLines: emitted ? [...emitted.lines].filter(line => !(merged.get(line) > 0)).sort((a, b) => a - b) : undefined,
  })
}

const totals = { files: expected.length, instrumentedFiles: files.filter(file => !file.missingInstrumentation).length,
  lines: files.reduce((sum, file) => sum + file.lines, 0),
  covered: files.reduce((sum, file) => sum + file.covered, 0),
  excludedStructuralLines: files.reduce((sum, file) => sum + file.excludedStructuralLines.length, 0),
  excludedLinkageLines: files.reduce((sum, file) => sum + file.excludedLinkageLines.length, 0),
  missingInstrumentation: files.filter(file => file.missingInstrumentation).map(file => file.path),
}
const percent = (covered, total) => total ? `${(covered / total * 100).toFixed(2)}%` : 'n/a'
console.log(`Project source files instrumented: ${totals.instrumentedFiles}/${totals.files}`)
console.log(`Project source lines covered: ${totals.covered}/${totals.lines} (${percent(totals.covered, totals.lines)})`)
console.log(`Standalone closing braces excluded from executable-line denominator: ${totals.excludedStructuralLines}`)
console.log(`Static import linkage lines excluded from executable-line denominator: ${totals.excludedLinkageLines}`)
for (const lane of lanes) {
  const records = [...lane.files.values()]
  const total = records.reduce((sum, file) => sum + (file.lineTotal || file.lines.size), 0)
  const hit = records.reduce((sum, file) => sum + (file.lineCovered || [...file.lines.values()].filter(count => count > 0).length), 0)
  console.log(`${lane.name}: ${hit}/${total} lines (${percent(hit, total)}), ${records.length} source files`)
}
if (totals.missingInstrumentation.length) {
  console.log(`Uninstrumented production files (${totals.missingInstrumentation.length}):`)
  for (const path of totals.missingInstrumentation) console.log(`  ${path}`)
}
const partial = files.filter(file => !file.missingInstrumentation && file.covered < file.lines)
  .sort((a, b) => (b.lines - b.covered) - (a.lines - a.covered)).slice(0, 20)
if (partial.length) {
  console.log('Largest uncovered source files:')
  for (const file of partial) console.log(`  ${file.path}: ${file.covered}/${file.lines}`)
}
const report = { scope: 'TypeScript source lines mapped to emitted JavaScript under src/, plus LLVM source lines in native/pdfium-worker.cpp; excludes generated bundles, tests, build tooling and third-party PDFium',
  totals, files, lanes: lanes.map(lane => ({ name: lane.name, path: lane.path })),
  lineCoverageComplete: totals.missingInstrumentation.length === 0 && totals.lines > 0 && totals.covered === totals.lines,
}
if (outputPath) await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`)
if (!report.lineCoverageComplete) process.exitCode = 1
