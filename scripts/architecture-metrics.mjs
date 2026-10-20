import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceRoot = join(root, 'src')
const moduleRoot = join(sourceRoot, 'modules')

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path)
  }
  return files.sort()
}

function functionNode(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
}

function decisionPoints(node) {
  let points = 0
  function visit(child) {
    if (child !== node && functionNode(child)) return
    if (ts.isIfStatement(child) || ts.isForStatement(child) || ts.isForOfStatement(child)
      || ts.isForInStatement(child) || ts.isWhileStatement(child) || ts.isDoStatement(child)
      || ts.isCatchClause(child) || ts.isConditionalExpression(child)) points++
    if (ts.isCaseClause(child)) points++
    if (ts.isBinaryExpression(child) && [ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(child.operatorToken.kind)) points++
    ts.forEachChild(child, visit)
  }
  visit(node)
  return 1 + points
}

function owner(path) {
  const relativePath = relative(moduleRoot, path)
  return relativePath.startsWith('..') || relativePath === '' ? undefined : relativePath.split(sep)[0]
}

const paths = await sourceFiles(sourceRoot)
const pathSet = new Set(paths)
const fileMetrics = []
const functions = []
const edges = new Map()
let hostToClient = 0
let clientToHost = 0
const isHost = path => path.startsWith(join(sourceRoot, 'host') + sep)
  || path.startsWith(join(sourceRoot, 'adapters', 'host') + sep)
  || ['reader-host.ts', 'native-host.ts', 'ocr-host.ts', 'image-understanding-host.ts']
    .some(name => path === join(sourceRoot, 'entrypoints', name))
const isClient = path => path.startsWith(join(sourceRoot, 'client') + sep)
  || path.startsWith(join(sourceRoot, 'adapters', 'client') + sep)
  || path.startsWith(join(sourceRoot, 'modules', 'viewer') + sep)
  || path === join(sourceRoot, 'entrypoints', 'reader-client.tsx')

for (const path of paths) {
  const content = await readFile(path, 'utf8')
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const file = relative(root, path).split(sep).join('/')
  const lines = content.split(/\r?\n/).length
  const imports = []
  const visit = node => {
    if (functionNode(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      const name = node.name?.getText(source) ?? `${ts.SyntaxKind[node.kind]}@${line}`
      functions.push({ file, line, name, complexity: decisionPoints(node) })
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      if (specifier.startsWith('.')) {
        const base = resolve(dirname(path), specifier.replace(/\.js$/, ''))
        const target = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(item => pathSet.has(item))
        if (target) imports.push(target)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const from = owner(path)
  for (const target of imports) {
    if (isHost(path) && isClient(target)) hostToClient++
    if (isClient(path) && isHost(target)) clientToHost++
    const to = owner(target)
    if (from && to && from !== to) {
      const targets = edges.get(from) ?? new Set()
      targets.add(to)
      edges.set(from, targets)
    }
  }
  fileMetrics.push({ file, lines, localImports: imports.length, module: from })
}

functions.sort((a, b) => b.complexity - a.complexity || a.file.localeCompare(b.file) || a.line - b.line)
fileMetrics.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file))
const report = {
  method: 'TypeScript AST decision-point proxy: one per function plus if, loops, catch, non-default case, ternary, &&, ||, ??; nested functions counted separately',
  totals: {
    files: paths.length,
    physicalLines: fileMetrics.reduce((sum, item) => sum + item.lines, 0),
    functions: functions.length,
    functionsOver10: functions.filter(item => item.complexity > 10).length,
    functionsOver20: functions.filter(item => item.complexity > 20).length,
    hostToClientDirectImports: hostToClient,
    clientToHostDirectImports: clientToHost,
  },
  largestFiles: fileMetrics.slice(0, 20),
  complexityHotspots: functions.slice(0, 20),
  moduleDependencies: Object.fromEntries([...edges].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, targets]) => [name, [...targets].sort()])),
}

const output = process.argv[2]
if (output) await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
