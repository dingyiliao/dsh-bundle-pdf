import assert from 'node:assert/strict'
import test from 'node:test'
import { migrateEngineConfigurations } from '../../src/shared/engine-configuration-migration.ts'
import type { EngineConfigurations } from '../../src/modules/engines/index.ts'

test('following the conversation removes orphan effort overrides without mutating saved settings', () => {
  for (const id of ['dsh-vision', 'session-vision']) {
    const source: EngineConfigurations = { image: { [id]: { reasoningEffort: 'high' },
      'third-party': { style: 'compact' } }, ocr: { local: { languages: 'eng' } } }
    const before = structuredClone(source)
    const migrated = migrateEngineConfigurations(source, id)
    assert.deepEqual(migrated.image?.['dsh-vision'], {})
    assert.deepEqual(migrated.image?.['third-party'], { style: 'compact' })
    assert.deepEqual(migrated.ocr, source.ocr)
    assert.deepEqual(source, before)
  }
})

test('explicit model effort and incomplete saved routes remain visible to validation', () => {
  const source: EngineConfigurations = { image: { 'dsh-vision': {
    provider: 'provider', model: 'visual', reasoningEffort: 'high',
  } } }
  assert.deepEqual(migrateEngineConfigurations(source), source)
  const partial: EngineConfigurations = { image: { 'dsh-vision': { provider: 'provider', reasoningEffort: 'high' } } }
  assert.deepEqual(migrateEngineConfigurations(partial), partial)
})

test('legacy whitespace routes normalize consistently with Host model routing', () => {
  const source: EngineConfigurations = { image: { 'dsh-vision': {
    provider: ' provider ', model: ' visual ', reasoningEffort: ' high ',
  } } }
  assert.deepEqual(migrateEngineConfigurations(source).image?.['dsh-vision'], {
    provider: 'provider', model: 'visual', reasoningEffort: 'high',
  })
  const blank: EngineConfigurations = { image: { 'dsh-vision': { provider: ' ', model: '\t', reasoningEffort: 'high' } } }
  assert.deepEqual(migrateEngineConfigurations(blank).image?.['dsh-vision'], {})
  assert.equal(source.image?.['dsh-vision']?.provider, ' provider ', 'read normalization does not mutate stored configuration')
})
