import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addHighlightQuickColor,
  DEFAULT_HIGHLIGHT_QUICK_COLORS,
  editHighlightQuickColor,
  MAX_HIGHLIGHT_QUICK_COLORS,
  parseHighlightQuickColors,
  removeHighlightQuickColor,
} from '../../../src/modules/viewer/model/highlight-colors.ts'

test('quick highlight colors start with five defaults and an intentionally emptied bar stays empty', () => {
  const defaults = parseHighlightQuickColors(null)
  assert.deepEqual(defaults, DEFAULT_HIGHLIGHT_QUICK_COLORS)
  assert.equal(defaults.length, MAX_HIGHLIGHT_QUICK_COLORS)
  assert.deepEqual(parseHighlightQuickColors('[]'), [])
})

test('malformed stored quick colors fall back safely and valid colors normalize', () => {
  for (const stored of ['{', '{}', '["oops"]', '["#abcdef", "#ABCDEF"]',
    JSON.stringify([...DEFAULT_HIGHLIGHT_QUICK_COLORS, '#123456'])]) {
    assert.deepEqual(parseHighlightQuickColors(stored), DEFAULT_HIGHLIGHT_QUICK_COLORS)
  }
  assert.deepEqual(parseHighlightQuickColors('["#ABCDEF", "#123456"]'), ['#abcdef', '#123456'])
})

test('quick colors never silently replace a full slot or duplicate another color', () => {
  const initial = [...DEFAULT_HIGHLIGHT_QUICK_COLORS]
  assert.equal(addHighlightQuickColor(initial, '#123456'), null)
  const reduced = removeHighlightQuickColor(initial, 1)
  assert.equal(reduced.length, 4)
  assert.deepEqual(addHighlightQuickColor(reduced, '#123456'), [...reduced, '#123456'])
  assert.equal(addHighlightQuickColor(reduced, '#FFFF00'), null)
  assert.deepEqual(editHighlightQuickColor(reduced, 0, '#ABCDEF')?.[0], '#abcdef')
  assert.equal(editHighlightQuickColor(reduced, 0, reduced[1]!), null)
})
