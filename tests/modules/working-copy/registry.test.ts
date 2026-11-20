import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkingCopyRegistry } from '../../../src/layers/document/working-copy/registry.ts'

test('working-copy registry owns references, pins and release notification', () => {
  const registry = createWorkingCopyRegistry()
  registry.own('doc', 'ui', 'view')
  assert.equal(registry.references.get('doc')?.ui.has('view'), true)
  let released = 0
  const release = registry.hold('doc', () => { released++ })
  assert.equal(registry.references.get('doc')?.pins, 1)
  release(); release()
  assert.equal(registry.references.get('doc')?.pins, 0)
  assert.equal(released, 1)
})

test('working-copy registry validates session ownership and clears credentials', () => {
  const registry = createWorkingCopyRegistry()
  registry.suspended.set('doc', { record: { format: 1, sessionId: 'session', path: '/book.pdf', sourceVersion: 'fs',
    sourceHash: 'hash', contentVersion: 'content', revision: 0, groups: [], groupDates: [], cursor: 0 }, conflict: false })
  registry.passwords.set('doc', 'secret')
  assert.equal(registry.recordFor('session', 'doc').path, '/book.pdf')
  assert.throws(() => registry.recordFor('other', 'doc'), { code: 'pdf/session-mismatch' })
  registry.clear()
  assert.equal(registry.passwords.size, 0)
  assert.equal(registry.suspended.size, 0)
})
