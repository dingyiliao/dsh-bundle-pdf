import assert from 'node:assert/strict'
import test from 'node:test'
import lock from '../native/dependencies.json' with { type: 'json' }
import { patchsetDigest, readPatchset } from '../native/pdfium/patchset.mjs'

test('PDFium patchset is ordered and pinned to the locked source revision', async () => {
  const patchset = await readPatchset()
  assert.equal(patchset.format, 1)
  assert.equal(patchset.sourceRevision, lock.pdfium.sourceRevision)
  assert.ok(patchset.steps.length > 0)
  assert.deepEqual(patchset.steps.map(step => step.id), [
    '0001-standalone-exports', '0002-dsh-extensions',
  ])
  assert.ok(patchset.steps.every(step => step.sources.length > 0))
})

test('PDFium patchset digest is deterministic and SDK identity is the same digest', async () => {
  const digest = await patchsetDigest()
  assert.match(digest, /^sha256:[0-9a-f]{64}$/)
  const sdk = await import('node:fs/promises').then(fs => fs.readFile('native/.deps/pdfium-patched/DSH_PATCHSET', 'utf8'))
  assert.equal(sdk.trim(), digest)
})
