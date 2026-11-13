import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'

test('the PDF bundle declares one tested DSH 0.2.x admission window', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const runtime = getDshRuntimeVersion()
  assert.match(runtime, /^0\.2\./, 'Development builds must exercise a DSH 0.2.x runtime')
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies)
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies)
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.1 <0.3.0-0', 'The runtime window is the single admission contract')
  for (const version of ['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2', '0.2.3']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version)
  }
  for (const version of ['0.2.1-rc.5', '0.3.0', '0.3.0-alpha.1']) {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    assert.ok(issue, `Do not claim compatibility with DSH ${version}`)
    assert.equal(issue.exempted, false)
  }
})
