import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedSaveVersion } from '../../../src/modules/working-copy/index.ts'

const source = `sha256:${'a'.repeat(64)}`
const observed = `sha256:${'b'.repeat(64)}`

test('plain Save uses the open source digest; Save As to a new path expects absence', () => {
  assert.equal(expectedSaveVersion(source, true, {}), source)
  assert.equal(expectedSaveVersion(source, false, { path: '/copy.pdf' }), null)
})

test('same-path Save As recreates a deleted source but only replaces an observed version', () => {
  assert.equal(expectedSaveVersion(source, true, { path: '/same.pdf', expectedTargetVersion: null }), null)
  assert.equal(expectedSaveVersion(source, true, {
    path: '/same.pdf', expectedTargetVersion: observed, overwrite: true,
  }), observed)
  assert.throws(() => expectedSaveVersion(source, true, { path: '/same.pdf', overwrite: true }),
    { code: 'pdf/overwrite-required' })
})

test('different-path replacement requires explicit overwrite and retains CAS', () => {
  assert.throws(() => expectedSaveVersion(source, false, {
    path: '/other.pdf', expectedTargetVersion: observed,
  }), { code: 'pdf/overwrite-required' })
  assert.equal(expectedSaveVersion(source, false, {
    path: '/other.pdf', expectedTargetVersion: observed, overwrite: true,
  }), observed)
})
