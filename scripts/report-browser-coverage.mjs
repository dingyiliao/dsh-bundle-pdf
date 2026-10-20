/** Convert the opt-in Playwright/V8 PDF Client artifacts to source-level line LCOV. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode } from '@jridgewell/sourcemap-codec'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const artifactDirectory = process.env.DSH_PDF_BROWSER_COVERAGE_DIR
const output = process.env.DSH_PDF_BROWSER_COVERAGE_OUTPUT
if (!artifactDirectory || !output) {
  throw new Error('Set DSH_PDF_BROWSER_COVERAGE_DIR and DSH_PDF_BROWSER_COVERAGE_OUTPUT to absolute paths.')
}
if (!isAbsolute(artifactDirectory) || !isAbsolute(output)) {
  throw new Error('PDF browser coverage paths must be absolute.')
}

/** A map segment's source path is relocated by DSH from ../src to /plugins/@local/src. */
function localSource(source) {
  const prefix = '/plugins/@local/src/'
  if (!source.startsWith(prefix)) return undefined
  const path = resolve(root, 'src', source.slice(prefix.length))
  const sourceRoot = resolve(root, 'src')
  const relativePath = relative(sourceRoot, path)
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath) && /\.tsx?$/.test(path) && !path.endsWith('.d.ts')
    ? path : undefined
}

function lineStarts(source) {
  const starts = [0]
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') starts.push(index + 1)
  return starts
}

/** The shortest containing V8 range wins; an unexecuted inner branch overrides an executed outer function. */
function coveredPrefix(sourceLength, functions) {
  const mask = new Uint8Array(sourceLength)
  const ranges = functions.flatMap(fn => fn.ranges)
    .sort((left, right) => (right.endOffset - right.startOffset) - (left.endOffset - left.startOffset)
      || right.count - left.count)
  for (const range of ranges) {
    mask.fill(range.count > 0 ? 1 : 0,
      Math.max(0, range.startOffset), Math.min(sourceLength, range.endOffset))
  }
  const prefix = new Uint32Array(sourceLength + 1)
  for (let index = 0; index < sourceLength; index++) prefix[index + 1] = prefix[index] + mask[index]
  return prefix
}

const linesByFile = new Map()
// Cache the validated contents, not just the path: several script sections may
// map to the same source file, and each must describe the same source snapshot.
const verifiedSource = new Map()
function addLine(path, line, hit) {
  let lines = linesByFile.get(path)
  if (!lines) linesByFile.set(path, lines = new Map())
  lines.set(line, Math.max(lines.get(line) ?? 0, hit ? 1 : 0))
}

const artifacts = (await readdir(artifactDirectory)).filter(name => /^browser-.*\.json$/.test(name)).sort()
if (!artifacts.length) throw new Error(`No PDF browser coverage artifacts found in ${artifactDirectory}; did the Web E2E run?`)
let processed = 0
for (const artifact of artifacts) {
  const parsed = JSON.parse(await readFile(join(artifactDirectory, artifact), 'utf8'))
  if (parsed.version !== 1 || parsed.packageId !== '@local/dsh-pdf' || !Array.isArray(parsed.entries)) {
    throw new Error(`Malformed browser coverage artifact: ${artifact}`)
  }
  for (const entry of parsed.entries) {
    const { generatedSource, sourceMap, functions } = entry
    if (typeof generatedSource !== 'string' || typeof sourceMap?.mappings !== 'string' || !Array.isArray(functions)) {
      throw new Error(`Malformed PDF source coverage entry: ${artifact}`)
    }
    for (const [index, source] of (sourceMap.sources ?? []).entries()) {
      const path = localSource(source)
      if (!path) continue
      const authored = sourceMap.sourcesContent?.[index]
      const expected = verifiedSource.has(path)
        ? verifiedSource.get(path) : await readFile(path, 'utf8')
      if (typeof authored !== 'string' || authored !== expected) {
        throw new Error(`Stale or incomplete browser source map for ${path}; rebuild with DSH_PDF_BROWSER_COVERAGE=1 before running Web E2E.`)
      }
      verifiedSource.set(path, authored)
    }
    const starts = lineStarts(generatedSource)
    const covered = coveredPrefix(generatedSource.length, functions)
    const decoded = decode(sourceMap.mappings)
    for (let generatedLine = 0; generatedLine < decoded.length; generatedLine++) {
      const segments = decoded[generatedLine]
      const startOfLine = starts[generatedLine]
      if (startOfLine === undefined) continue
      const endOfLine = starts[generatedLine + 1] ?? generatedSource.length
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index]
        if (segment.length < 4) continue
        const path = localSource(sourceMap.sources?.[segment[1]] ?? '')
        if (!path) continue
        const from = Math.min(endOfLine, startOfLine + segment[0])
        const to = Math.min(endOfLine, startOfLine + (segments[index + 1]?.[0] ?? endOfLine - startOfLine))
        addLine(path, segment[2] + 1, to > from && covered[to] > covered[from])
      }
    }
    processed++
  }
}

const runtimeKinds = new Set([
  ts.SyntaxKind.ExpressionStatement, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement, ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement, ts.SyntaxKind.SwitchStatement, ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.BreakStatement, ts.SyntaxKind.ContinueStatement, ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor, ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ExportAssignment,
])

async function seedClientSource(path) {
  const content = await readFile(path, 'utf8')
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  function visit(node) {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
      || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (runtimeKinds.has(node.kind) || ts.isPropertyDeclaration(node) && node.initializer) {
      addLine(path, sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, false)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

async function walkClient(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) await walkClient(path)
    else if (item.isFile() && /\.tsx?$/.test(item.name) && !item.name.endsWith('.d.ts')) {
      await seedClientSource(path)
    }
  }
}

// Keep the Browser lane scoped to Client-owned code after the V2 move. The
// project-wide report independently counts every emitted source line in src/.
for (const directory of ['src/client', 'src/modules/viewer', 'src/adapters/client']) {
  await walkClient(join(root, directory))
}
await seedClientSource(join(root, 'src/entrypoints/reader-client.tsx'))

const report = []
let found = 0
let hit = 0
for (const [path, lines] of [...linesByFile].sort(([a], [b]) => a.localeCompare(b))) {
  if (!lines.size) continue
  const sorted = [...lines].sort(([a], [b]) => a - b)
  const lineHit = sorted.filter(([, count]) => count > 0).length
  report.push('TN:browser', `SF:${path}`,
    ...sorted.map(([line, count]) => `DA:${line},${count}`),
    `LF:${sorted.length}`, `LH:${lineHit}`, 'end_of_record')
  found += sorted.length
  hit += lineHit
}
if (!found) throw new Error('PDF browser coverage contained no project-owned source lines.')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${report.join('\n')}\n`, 'utf8')
console.log(`Browser PDF Client line coverage: ${hit}/${found} (${(100 * hit / found).toFixed(2)}%), ${linesByFile.size} files from ${artifacts.length} artifacts / ${processed} script sections.`)
console.log(`LCOV: ${output}`)
