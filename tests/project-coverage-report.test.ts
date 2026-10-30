import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decode } from '@jridgewell/sourcemap-codec'
import ts from 'typescript'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

async function sourceFixture(path: string) {
  const source = await readFile(join(root, path), 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const built = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX, sourceMap: true, removeComments: true },
  })
  assert.ok(built.sourceMapText)
  const map = JSON.parse(built.sourceMapText) as { mappings: string }
  const mapped = new Set(decode(map.mappings).flat()
    .filter(segment => segment.length >= 4).map(segment => segment[2]! + 1))
  const lines = source.split(/\r?\n/)
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  const nodes = <T extends ts.Node>(select: (node: ts.Node) => node is T): T[] => {
    const result: T[] = []
    function visit(node: ts.Node): void {
      if (select(node)) result.push(node)
      ts.forEachChild(node, visit)
    }
    visit(file)
    return result
  }
  return { file, lines, mapped, lineOf, nodes }
}

test('project source-line report excludes non-executable braces and static bundle linkage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pdf-coverage-report-'))
  try {
    const lifecyclePath = 'src/client/pdf-session-lifecycle.ts'
    const lifecycleSource = await sourceFixture(lifecyclePath)
    const structural = [...new Set(lifecycleSource.nodes(ts.isBlock)
      .map(block => lifecycleSource.file.getLineAndCharacterOfPosition(block.end - 1).line + 1))]
      .filter(line => lifecycleSource.mapped.has(line) && /^\s*}\s*$/.test(lifecycleSource.lines[line - 1] ?? ''))
      .slice(0, 3)
    assert.equal(structural.length, 3, 'the lifecycle fixture has three mapped standalone block closings')
    const executable = lifecycleSource.nodes(ts.isExpressionStatement).map(lifecycleSource.lineOf)
      .find(line => lifecycleSource.mapped.has(line) && !structural.includes(line))
    assert.ok(executable, 'the lifecycle fixture has a mapped executable statement')

    const ocrPath = 'src/adapters/host/dsh/ocr-tool.ts'
    const ocrSource = await sourceFixture(ocrPath)
    const ocrDeclaration = ocrSource.nodes(ts.isFunctionDeclaration)
      .find(node => node.name?.text === 'registerOcrAgentTool')
    assert.ok(ocrDeclaration)
    const ocrLine = ocrSource.lineOf(ocrDeclaration)

    const colorPath = 'src/modules/viewer/components/AnnotationColorBar.tsx'
    const colorSource = await sourceFixture(colorPath)
    const eventLines = (event: string) => [...new Set(colorSource.nodes(ts.isJsxAttribute)
      .filter(node => node.name.getText(colorSource.file) === event).map(colorSource.lineOf))]
      .filter(line => colorSource.mapped.has(line))
    const mixed = eventLines('onClick').slice(0, 3)
    const all = eventLines('onChange').slice(0, 2)
    assert.equal(mixed.length, 3, 'the TSX fixture has three mapped click handlers')
    assert.equal(all.length, 2, 'the TSX fixture has two mapped change handlers')
    const importLines = new Set(colorSource.nodes(ts.isImportDeclaration)
      .flatMap(node => Array.from({ length: colorSource.file.getLineAndCharacterOfPosition(node.end).line
        - colorSource.file.getLineAndCharacterOfPosition(node.getStart(colorSource.file)).line + 1 },
      (_, offset) => colorSource.lineOf(node) + offset)))
    const otherLines = [...colorSource.mapped].filter(line =>
      !mixed.includes(line) && !all.includes(line) && !importLines.has(line)
      && !/^\s*}\s*$/.test(colorSource.lines[line - 1] ?? ''))
    assert.ok(otherLines.length >= 2)
    const [sharedLine, unknownLine] = otherLines

    const readerPath = 'src/client/Reader.tsx'
    const readerSource = await sourceFixture(readerPath)
    const imports = readerSource.nodes(ts.isImportDeclaration)
    const runtimeImportLine = readerSource.lineOf(imports.find(node => !node.importClause?.isTypeOnly)!)
    const typeImportLine = readerSource.lineOf(imports.find(node => node.importClause?.isTypeOnly)!)

    const linkagePath = 'src/modules/annotations/index.ts'
    const linkageSource = await sourceFixture(linkagePath)
    const linkageReExport = linkageSource.nodes(ts.isExportDeclaration)
      .find(node => node.moduleSpecifier && !node.isTypeOnly)
    assert.ok(linkageReExport, 'the annotations module entry has a static re-export')
    const linkageLine = linkageSource.lineOf(linkageReExport)
    assert.ok(linkageSource.mapped.has(linkageLine), 'TypeScript maps that ESM linkage line')

    const runtimeExportPath = 'src/entrypoints/reader-client.tsx'
    const runtimeExportSource = await sourceFixture(runtimeExportPath)
    const runtimeExportLine = runtimeExportSource.lines.findIndex(line => line.includes("export const name = 'pdf-reader-client'")) + 1
    assert.ok(runtimeExportLine && runtimeExportSource.mapped.has(runtimeExportLine), 'the runtime export is mapped')

    const localFilesPath = 'src/adapters/host/filesystem/local-files.ts'
    const localFilesSource = await sourceFixture(localFilesPath)
    const elseLine = localFilesSource.lines.findIndex(line => /}\s*else\s*{/.test(line)) + 1
    assert.ok(elseLine, 'the file adapter fixture has a combined else line')

    const node = join(directory, 'node.lcov')
    const browser = join(directory, 'browser.lcov')
    const native = join(directory, 'native.lcov')
    const reportPath = join(directory, 'report.json')
    await writeFile(node, [
      `SF:${join(root, lifecyclePath)}`, `DA:${executable},1`, ...structural.map(line => `DA:${line},0`), 'end_of_record',
      `SF:${join(root, ocrPath)}`, `FN:${ocrLine},registerOcrAgentTool`, 'FNDA:1,registerOcrAgentTool', `DA:${ocrLine},0`, 'end_of_record',
      `SF:${join(root, colorPath)}`,
      ...mixed.map(line => `FN:${line},repeatedMixed`),
      ...all.map(line => `FN:${line},repeatedAll`),
      `FN:${sharedLine},sameLine`, `FN:${sharedLine},sameLine`,
      `FN:${unknownLine},missingLine`, 'FN:undefined,missingLine',
      'FNDA:1,repeatedMixed', 'FNDA:0,repeatedMixed', 'FNDA:0,repeatedMixed',
      'FNDA:1,repeatedAll', 'FNDA:1,repeatedAll',
      'FNDA:1,sameLine', 'FNDA:0,sameLine',
      'FNDA:1,missingLine', 'FNDA:0,missingLine',
      ...[...mixed, ...all, sharedLine, unknownLine].map(line => `DA:${line},0`),
      'end_of_record', '',
    ].join('\n'))
    await writeFile(browser, '')
    await writeFile(native, `SF:${join(root, 'native/pdfium-worker.cpp')}\nDA:38,1\nLF:1\nLH:1\nend_of_record\n`)
    const result = spawnSync(process.execPath, ['scripts/report-project-coverage.mjs', node, browser, native, reportPath],
      { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 1, 'the report still fails because other production lines are uncovered')
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      files: { path: string; excludedStructuralLines: number[]; excludedLinkageLines: number[]; uncoveredLines?: number[] }[]
      totals: { excludedStructuralLines: number; excludedLinkageLines: number }
    }
    const lifecycle = report.files.find(file => file.path === lifecyclePath)
    assert.ok(lifecycle)
    for (const line of structural) {
      assert.ok(lifecycle.excludedStructuralLines.includes(line), `closing brace at ${line} is structural`)
      assert.equal(lifecycle.uncoveredLines?.includes(line), false)
    }
    assert.equal(lifecycle.uncoveredLines?.includes(executable), false, 'the executable hit remains covered')
    const localFiles = report.files.find(file => file.path === localFilesPath)
    assert.ok(localFiles)
    assert.equal(localFiles.excludedStructuralLines.includes(elseLine), false, '`} else {` is not a standalone brace')
    const ocrTool = report.files.find(file => file.path === ocrPath)
    assert.ok(ocrTool)
    assert.equal(ocrTool.uncoveredLines?.includes(ocrLine), false,
      'a positive FNDA function call covers its declaration even when Node DA says zero')
    const colorBar = report.files.find(file => file.path === colorPath)
    assert.ok(colorBar)
    for (const line of mixed) {
      assert.ok(colorBar.uncoveredLines?.includes(line),
        `a hit on one of several same-named functions cannot be credited to line ${line}`)
    }
    for (const line of all) {
      assert.equal(colorBar.uncoveredLines?.includes(line), false,
        `when every same-named function ran, line ${line} is covered`)
    }
    assert.equal(colorBar.uncoveredLines?.includes(sharedLine), false,
      'one invocation proves a shared declaration line ran even if another closure did not')
    assert.ok(colorBar.uncoveredLines?.includes(unknownLine),
      'an FN without a source line must not be paired with another same-named declaration')
    assert.ok(report.totals.excludedStructuralLines >= 3)
    const reader = report.files.find(file => file.path === readerPath)
    assert.ok(reader)
    assert.ok(reader.excludedLinkageLines.includes(runtimeImportLine), 'the React import is bundled linkage, not a runtime statement')
    assert.equal(reader.uncoveredLines?.includes(typeImportLine), false, 'type-only imports cannot execute')
    assert.equal(reader.uncoveredLines?.includes(runtimeImportLine), false)
    assert.ok(report.totals.excludedLinkageLines >= reader.excludedLinkageLines.length)
    const linkage = report.files.find(file => file.path === linkagePath)
    assert.ok(linkage)
    assert.ok(linkage.excludedLinkageLines.includes(linkageLine), 'static re-export is ESM linkage, not an executable line')
    assert.equal(linkage.uncoveredLines?.includes(linkageLine), false)
    const runtimeExport = report.files.find(file => file.path === runtimeExportPath)
    assert.ok(runtimeExport)
    assert.equal(runtimeExport.excludedLinkageLines.includes(runtimeExportLine), false,
      'a local value export remains in the executable denominator')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('project source-line report rejects an empty native LCOV lane', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pdf-coverage-empty-native-'))
  try {
    const node = join(directory, 'node.lcov')
    const browser = join(directory, 'browser.lcov')
    const native = join(directory, 'native.lcov')
    const reportPath = join(directory, 'report.json')
    await writeFile(node, '')
    await writeFile(browser, '')
    await writeFile(native, '')
    const result = spawnSync(process.execPath, ['scripts/report-project-coverage.mjs', node, browser, native, reportPath],
      { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Native LCOV must contain measured lines for native\/pdfium-worker\.cpp/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
