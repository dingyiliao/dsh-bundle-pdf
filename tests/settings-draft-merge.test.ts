import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeSettingsValue } from '../src/client/settings-draft-merge.ts'

test('settings merge preserves disjoint nested configuration edits and removes cleared keys', () => {
  const base = { image: { endpoint: 'old', credential: 'old-reference' }, retired: true }
  const local = { image: { endpoint: 'new', credential: 'old-reference' } }
  const remote = { image: { endpoint: 'old', credential: 'new-reference' }, retired: true }
  assert.deepEqual(mergeSettingsValue(base, local, remote), {
    value: { image: { endpoint: 'new', credential: 'new-reference' } }, conflict: false,
  })
  assert.deepEqual(mergeSettingsValue(undefined, { endpoint: 'local' }, { model: 'remote' }), {
    value: { endpoint: 'local', model: 'remote' }, conflict: false,
  })
})

test('concurrent changes to one setting retain the local value and report a conflict', () => {
  assert.deepEqual(mergeSettingsValue('base', 'mine', 'theirs'), { value: 'mine', conflict: true })
  assert.deepEqual(mergeSettingsValue(['base'], ['mine'], ['theirs']), { value: ['mine'], conflict: true })
  assert.deepEqual(mergeSettingsValue('base', 'same', 'same'), { value: 'same', conflict: false })
})

test('acknowledgement confirms only submitted values, retaining later changes and reversions', () => {
  assert.deepEqual(mergeSettingsValue('original', 'original', 'submitted', { value: 'submitted' }), {
    value: 'original', conflict: false,
  })
  assert.deepEqual(mergeSettingsValue({ endpoint: 'old', model: 'old' },
    { endpoint: 'submitted', model: 'later' }, { endpoint: 'submitted', model: 'submitted' },
    { value: { endpoint: 'submitted', model: 'submitted' } }), {
    value: { endpoint: 'submitted', model: 'later' }, conflict: false,
  })
  assert.deepEqual(mergeSettingsValue(undefined, { newlyEdited: true }, {}, { value: undefined }), {
    value: { newlyEdited: true }, conflict: false,
  })
})

test('an acknowledgement cannot hide a newer external change, while normalized accepted values remain valid baselines', () => {
  assert.deepEqual(mergeSettingsValue('original', 'pending B', 'external C', { value: 'submitted A' }), {
    value: 'pending B', conflict: true,
  })
  assert.deepEqual(mergeSettingsValue('old', 'later', 'normalized', { value: ' normalized ', accepted: 'normalized' }), {
    value: 'later', conflict: false,
  })
})
