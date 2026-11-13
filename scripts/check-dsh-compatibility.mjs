import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
const runtime = require('@deepseek-ai/dsh-app-boot/package.json').version

assert.deepEqual(lock.packages[''].engines, manifest.engines, 'package-lock engines must match package.json')
assert.equal(manifest.engines?.dsh, '>=0.2.2-rc.1 <0.3.0-0', 'unexpected DSH admission window')
assert.ok(semver.satisfies(runtime, manifest.engines.dsh, { includePrerelease: true }),
  `installed DSH ${runtime} is outside ${manifest.engines.dsh}`)
assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies, 'peerDependencies drifted from lock')
assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies, 'devDependencies drifted from lock')

for (const [name, range] of Object.entries(manifest.peerDependencies)) {
  if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
  assert.ok(semver.satisfies(runtime, range, { includePrerelease: true }), `${name}@${range} rejects DSH ${runtime}`)
}
// Every installed direct DSH development dependency should come from the same runtime release.
for (const name of Object.keys(manifest.devDependencies)) {
  if (!name.startsWith('@deepseek-ai/dsh-')) continue
  const version = require(`${name}/package.json`).version
  assert.equal(version, runtime, `${name}@${version} is not the tested DSH ${runtime}`)
}
console.log(`dsh compatibility: ok (runtime ${runtime}, admission ${manifest.engines.dsh})`)
