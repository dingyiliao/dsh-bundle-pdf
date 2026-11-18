import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const sourceRoot = join(projectRoot, 'src')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

const allSourceFiles = () => new Set(sourceFiles(sourceRoot))

test('PDF engine source has one TypeScript boundary and one native boundary', () => {
  assert.equal(existsSync(join(projectRoot, 'pdf-engine')), false, 'legacy top-level pdf-engine must not return')
  for (const path of [
    'src/native-boundary/client', 'src/native-boundary/host', 'src/native-boundary/protocol',
    'src/capabilities/pdfium/document-port.ts',
    'native/worker/worker-runtime.cpp', 'native/backend/pdf-backend.h',
    'native/backend/pdfium/pdfium-worker.cpp', 'native/pdfium',
  ]) assert.equal(existsSync(join(projectRoot, path)), true, `missing canonical engine path: ${path}`)
  assert.equal(existsSync(join(projectRoot, 'src/native-boundary/host/document-worker.ts')), false,
    'PDFium document adaptation must not return to the low-level engine host')
})

function localTarget(file: string, specifier: string, files: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return
  const base = resolve(dirname(file), specifier.replace(/\.js$/, ''))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (files.has(candidate)) return candidate
  }
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  const named = clause?.namedBindings
  return !!(clause?.isTypeOnly || (named && ts.isNamedImports(named)
    && !clause.name && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly)))
}

function imports(file: string, files: ReadonlySet<string>, includeTypes = false): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const targets: string[] = []
  const add = (specifier: ts.Expression | undefined) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return
    const target = localTarget(file, specifier.text, files)
    if (target) targets.push(target)
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (includeTypes || !isTypeOnlyImport(node)) add(node.moduleSpecifier)
    }
    if (ts.isExportDeclaration(node) && (includeTypes || !node.isTypeOnly)) add(node.moduleSpecifier)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(source)
  return targets
}

function display(path: string): string { return relative(projectRoot, path).split(sep).join('/') }

function assertRuntimeBoundary(from: readonly string[], forbidden: readonly string[]): void {
  const files = allSourceFiles()
  const graph = new Map([...files].map(file => [file, imports(file, files)]))
  const matches = (file: string, roots: readonly string[]) => roots.some(root =>
    file === join(projectRoot, root) || file.startsWith(join(projectRoot, root) + sep))
  for (const origin of files) {
    if (!matches(origin, from)) continue
    const queue: string[][] = [[origin]]
    const seen = new Set<string>([origin])
    while (queue.length) {
      const chain = queue.shift()!
      for (const target of graph.get(chain.at(-1)!) ?? []) {
        if (matches(target, forbidden)) {
          assert.fail(`Cross-process implementation import: ${[...chain, target].map(display).join(' → ')}`)
        }
        if (!seen.has(target)) { seen.add(target); queue.push([...chain, target]) }
      }
    }
  }
}

const hostRoots = ['src/surfaces/host', 'src/capabilities/pdfium', 'src/native-boundary/host',
  'src/plugins/reader/host.ts', 'src/plugins/native.ts', 'src/plugins/ocr.ts', 'src/plugins/image-understanding.ts']
const clientRoots = ['src/surfaces/client', 'src/plugins/client.tsx', 'src/native-boundary/client']

test('Host runtime imports cannot reach Client implementation, directly or transitively', () => {
  assertRuntimeBoundary(hostRoots, clientRoots)
})

test('Client runtime imports cannot reach Host implementation, directly or transitively', () => {
  assertRuntimeBoundary(clientRoots, hostRoots)
})

test('native protocol types and validators have no application implementation dependencies', () => {
  assertRuntimeBoundary(['src/native-boundary/protocol'], [
    'src/surfaces', 'src/plugins', 'src/layers', 'src/engines', 'src/capabilities',
    'src/contracts', 'src/shared', 'src/native-boundary/client', 'src/native-boundary/host',
  ])
})

test('native engine host stays below PDFium adapters and feature modules', () => {
  assertRuntimeBoundary(['src/native-boundary/host'], [
    'src/surfaces', 'src/plugins', 'src/layers', 'src/engines', 'src/capabilities',
    'src/contracts', 'src/shared', 'src/native-boundary/client',
  ])
})

test('Viewer imports no Client implementation outside its own root, including type-only imports', () => {
  const files = allSourceFiles()
  const viewerRoot = join(sourceRoot, 'surfaces', 'client', 'viewer') + sep
  const clientRoot = join(sourceRoot, 'surfaces', 'client') + sep
  for (const file of files) {
    if (!file.startsWith(viewerRoot)) continue
    for (const target of imports(file, files, true)) {
      assert.ok(!target.startsWith(clientRoot) || target.startsWith(viewerRoot),
        `${display(file)} depends on Client implementation ${display(target)}`)
    }
  }
})

test('engine and capability modules expose public indexes', () => {
  const files = allSourceFiles()
  const moduleRoots = [...files].filter(file => file.endsWith(`${sep}index.ts`)
    && ['engines', 'capabilities'].some(root => file.startsWith(join(sourceRoot, root) + sep)))
    .map(dirname).sort((a, b) => b.length - a.length)
  const owner = (file: string): string | undefined => moduleRoots.find(root => file === root || file.startsWith(root + sep))
  for (const file of files) {
    for (const target of imports(file, files, true)) {
      const targetModule = owner(target)
      if (!targetModule) continue
      const sameModule = owner(file) === targetModule
      assert.ok(sameModule || target === join(targetModule, 'index.ts'),
        `${display(file)} deep-imports ${display(target)} instead of the module's public index`)
    }
  }
})

test('document, derived and facade layers form a directed acyclic graph', () => {
  const files = allSourceFiles()
  const layersRoot = join(sourceRoot, 'layers') + sep
  const owner = (file: string): string | undefined => file.startsWith(layersRoot)
    ? relative(layersRoot, file).split(sep)[0] : undefined
  const graph = new Map<string, Set<string>>()
  for (const file of files) {
    const from = owner(file)
    if (!from) continue
    const dependencies = graph.get(from) ?? new Set<string>()
    graph.set(from, dependencies)
    for (const target of imports(file, files, true)) {
      const to = owner(target)
      if (to && to !== from) dependencies.add(to)
    }
  }
  const finished = new Set<string>()
  const visiting: string[] = []
  const walk = (name: string): void => {
    const cycleAt = visiting.indexOf(name)
    if (cycleAt !== -1) assert.fail(`Layer dependency cycle: ${[...visiting.slice(cycleAt), name].join(' → ')}`)
    if (finished.has(name)) return
    visiting.push(name)
    for (const dependency of graph.get(name) ?? []) walk(dependency)
    visiting.pop()
    finished.add(name)
  }
  for (const name of graph.keys()) walk(name)
})

test('domain and facade layers use ports instead of importing Cordis or DSH at runtime', () => {
  for (const file of sourceFiles(join(sourceRoot, 'layers'))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
      extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const inspect = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
        && !isTypeOnlyImport(node) && /^@deepseek-ai\/(?:cordis|dsh-)/.test(node.moduleSpecifier.text)) {
        assert.fail(`${display(file)} imports ${node.moduleSpecifier.text} at runtime; inject an adapter port`)
      }
      ts.forEachChild(node, inspect)
    }
    inspect(source)
  }
})
