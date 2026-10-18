import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('project source-line report excludes non-executable braces and static bundle linkage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pdf-coverage-report-'))
  try {
    const node = join(directory, 'node.lcov')
    const browser = join(directory, 'browser.lcov')
    const native = join(directory, 'native.lcov')
    const reportPath = join(directory, 'report.json')
    await writeFile(node, `SF:${join(root, 'src/client/pdf-session-lifecycle.ts')}\nDA:171,1\nDA:172,0\nDA:173,0\nDA:174,0\nend_of_record\nSF:${join(root, 'src/host/ocr-tool.ts')}\nFN:10,registerOcrAgentTool\nFNDA:1,registerOcrAgentTool\nDA:10,0\nend_of_record\nSF:${join(root, 'src/client/AnnotationColorBar.tsx')}\nFN:101,onClick\nFN:117,onClick\nFN:137,onClick\nFN:110,onChange\nFN:132,onChange\nFN:95,sameLine\nFN:95,sameLine\nFN:96,unknownLine\nFN:undefined,unknownLine\nFNDA:1,onClick\nFNDA:0,onClick\nFNDA:0,onClick\nFNDA:1,onChange\nFNDA:1,onChange\nFNDA:1,sameLine\nFNDA:0,sameLine\nFNDA:1,unknownLine\nFNDA:0,unknownLine\nDA:101,0\nDA:117,0\nDA:137,0\nDA:110,0\nDA:132,0\nDA:95,0\nDA:96,0\nend_of_record\n`)
    await writeFile(browser, '')
    await writeFile(native, `SF:${join(root, 'native/pdfium-worker.cpp')}\nDA:38,1\nLF:1\nLH:1\nend_of_record\n`)
    const result = spawnSync(process.execPath, ['scripts/report-project-coverage.mjs', node, browser, native, reportPath],
      { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 1, 'the report still fails because other production lines are uncovered')
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      files: { path: string; excludedStructuralLines: number[]; excludedLinkageLines: number[]; uncoveredLines?: number[] }[]
      totals: { excludedStructuralLines: number; excludedLinkageLines: number }
    }
    const lifecycle = report.files.find(file => file.path === 'src/client/pdf-session-lifecycle.ts')
    assert.ok(lifecycle)
    for (const line of [172, 173, 174]) {
      assert.ok(lifecycle.excludedStructuralLines.includes(line), `closing brace at ${line} is structural`)
      assert.equal(lifecycle.uncoveredLines?.includes(line), false)
    }
    assert.ok(lifecycle.uncoveredLines?.includes(171) === false, 'the executable hit remains covered')
    const localFiles = report.files.find(file => file.path === 'src/host/local-files.ts')
    assert.ok(localFiles)
    assert.equal(localFiles.excludedStructuralLines.includes(119), false, '`} else {` is not a standalone brace')
    const ocrTool = report.files.find(file => file.path === 'src/host/ocr-tool.ts')
    assert.ok(ocrTool)
    assert.equal(ocrTool.uncoveredLines?.includes(10), false,
      'a positive FNDA function call covers its declaration even when Node DA says zero')
    const colorBar = report.files.find(file => file.path === 'src/client/AnnotationColorBar.tsx')
    assert.ok(colorBar)
    for (const line of [101, 117, 137]) {
      assert.ok(colorBar.uncoveredLines?.includes(line),
        `a hit on one of several same-named onClick functions cannot be credited to line ${line}`)
    }
    for (const line of [110, 132]) {
      assert.equal(colorBar.uncoveredLines?.includes(line), false,
        `when every same-named onChange function ran, line ${line} is covered`)
    }
    assert.equal(colorBar.uncoveredLines?.includes(95), false,
      'one invocation proves a shared declaration line ran even if another closure did not')
    assert.ok(colorBar.uncoveredLines?.includes(96),
      'an FN without a source line must not be paired with another same-named declaration')
    assert.ok(report.totals.excludedStructuralLines >= 3)
    const reader = report.files.find(file => file.path === 'src/client/Reader.tsx')
    assert.ok(reader)
    assert.ok(reader.excludedLinkageLines.includes(1), 'the React import is bundled linkage, not a runtime statement')
    assert.equal(reader.uncoveredLines?.includes(4), false, 'type-only imports cannot execute')
    assert.equal(reader.uncoveredLines?.includes(1), false)
    assert.ok(report.totals.excludedLinkageLines >= reader.excludedLinkageLines.length)
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
