import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'

test('the PDF bundle passes DSH version admission without exemptions on its tested runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  assert.equal(getDshRuntimeVersion(), '0.2.1-rc.3', 'Exercise the current released DSH checker, not an older SDK')
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies)
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies)
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.2', getDshRuntimeVersion()]) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version)
  }
  for (const version of ['0.2.1-rc.4', '0.2.1', '0.3.0']) {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    assert.ok(issue, `Do not claim compatibility with unverified DSH ${version}`)
    assert.equal(issue.exempted, false)
  }
})
