import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'src/client/Reader.tsx')
const converter = join(root, 'scripts/report-browser-coverage.mjs')

test('browser coverage maps V8 ranges to source lines and rejects stale source maps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pdf-browser-coverage-'))
  const output = join(directory, 'output.lcov')
  const artifact = join(directory, 'browser-fixture.json')
  const authored = await readFile(source, 'utf8')
  const data = {
    version: 1,
    packageId: '@local/dsh-pdf',
    entries: [{
      url: 'http://127.0.0.1/plugins/??@local/dsh-pdf/client.js&rev=test',
      generatedSource: 'a();\nb();\n',
      sourceMap: {
        version: 3, sources: ['/plugins/@local/src/client/Reader.tsx'], sourcesContent: [authored],
        names: [], mappings: 'AAAA;AACA',
      },
      functions: [
        { functionName: '', isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 5, endOffset: 10, count: 0 }] },
      ],
    }],
  }
  const env = { ...process.env, DSH_PDF_BROWSER_COVERAGE_DIR: directory, DSH_PDF_BROWSER_COVERAGE_OUTPUT: output }
  try {
    await writeFile(artifact, JSON.stringify(data))
    execFileSync(process.execPath, [converter], { cwd: root, env })
    const report = await readFile(output, 'utf8')
    const section = report.split(`SF:${source}\n`)[1]?.split('end_of_record')[0]
    assert.ok(section, 'the PDF Client source appears in the browser LCOV report')
    assert.match(section, /^DA:1,1$/m)
    assert.match(section, /^DA:2,0$/m)
    data.entries.push({
      ...data.entries[0]!,
      sourceMap: { ...data.entries[0]!.sourceMap, sourcesContent: ['different source snapshot'] },
    })
    await writeFile(artifact, JSON.stringify(data))
    assert.throws(() => execFileSync(process.execPath, [converter], { cwd: root, env, stdio: 'pipe' }), error => {
      assert.match((error as { stderr: Buffer }).stderr.toString(), /Stale or incomplete browser source map/)
      return true
    })
    data.entries.pop()
    data.entries[0]!.sourceMap.sourcesContent[0] = 'stale source'
    await writeFile(artifact, JSON.stringify(data))
    assert.throws(() => execFileSync(process.execPath, [converter], { cwd: root, env, stdio: 'pipe' }),
      /Command failed/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
