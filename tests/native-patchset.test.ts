import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import lock from '../native/dependencies.json' with { type: 'json' }
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { patchsetDigest, readPatchset } from '../native/pdfium/patchset.mjs'

const pdfiumRoot = fileURLToPath(new URL('../native/pdfium/', import.meta.url))

test('PDFium unified patch queue is ordered and pinned to the locked source revision', async () => {
  const patchset = await readPatchset()
  assert.equal(patchset.format, 2)
  assert.equal(patchset.sourceRevision, lock.pdfium.sourceRevision)
  assert.deepEqual(patchset.steps.map(step => step.id), [
    '0001-standalone-shared-library', '0002-acroform-object-identity', '0003-form-font-appearances',
    '0004-object-generation-preservation', '0005-dsh-native-extensions',
  ])
  for (const step of patchset.steps) {
    assert.match(step.patch, /^patches\/\d{4}-[a-z0-9-]+\.patch$/)
    const stat = execFileSync('git', ['apply', '--stat', join(pdfiumRoot, step.patch)], {
      cwd: pdfiumRoot, encoding: 'utf8',
    })
    assert.match(stat, /\d+ files? changed/)
  }
})

test('PDFium patchset digest is deterministic and SDK identity is the same digest', async () => {
  const digest = await patchsetDigest()
  assert.match(digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(await patchsetDigest(), digest)
  const sdk = await import('node:fs/promises').then(fs => fs.readFile('native/.deps/pdfium-patched/DSH_PATCHSET', 'utf8'))
  assert.equal(sdk.trim(), digest)
})
