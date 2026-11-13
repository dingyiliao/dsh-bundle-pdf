import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_TEXT_PAGES, TEXT_GLYPH_MIN_SCALE, TEXT_RUN_MIN_SCALE,
  textFidelityForPage, textFidelityForScale,
} from '../../../src/client/viewer/rendering/text-policy.ts'

test('text fidelity follows readable scale thresholds', () => {
  assert.equal(textFidelityForScale(0), 'none')
  assert.equal(textFidelityForScale(Number.NaN), 'none')
  assert.equal(textFidelityForScale(TEXT_RUN_MIN_SCALE - 0.01), 'none')
  assert.equal(textFidelityForScale(TEXT_RUN_MIN_SCALE), 'run')
  assert.equal(textFidelityForScale(TEXT_GLYPH_MIN_SCALE - 0.01), 'run')
  assert.equal(textFidelityForScale(TEXT_GLYPH_MIN_SCALE), 'glyph')
  assert.equal(textFidelityForScale(4), 'glyph')
})

test('text below the selection threshold is browse-only, even for current or pinned pages', () => {
  const base = { visible: true, current: false, pinned: false }
  assert.equal(textFidelityForPage(0.1, base), 'none')
  assert.equal(textFidelityForPage(0.1, { ...base, current: true }), 'none')
  assert.equal(textFidelityForPage(0.1, { ...base, pinned: true }), 'none')
  assert.equal(textFidelityForPage(0.1, { ...base, visible: false, pinned: true }), 'none')
  assert.equal(textFidelityForPage(0.6, { ...base, pinned: true }), 'run')
  assert.equal(textFidelityForPage(1, base), 'glyph')
  assert.equal(textFidelityForPage(0.6, base), 'run')
  assert.equal(textFidelityForPage(0.6, { ...base, visible: false }), 'none')
})

test('the per-window text cap is small and explicit', () => {
  assert.equal(MAX_TEXT_PAGES, 3)
})

test('text page selection caps the window and prioritises pinned and current pages', async () => {
  const { selectTextPages } = await import('../../../src/client/viewer/rendering/text-policy.ts')
  const page = (index: number, extra: Partial<import('../../../src/client/viewer/rendering/text-policy.ts').TextPageCandidate> = {}) => ({
    index, page: index + 1, scale: 0.1, visible: true, current: false, pinned: false, ...extra,
  })
  // At 10% there is no text layer at all, even for the current page.
  assert.equal(selectTextPages(Array.from({ length: 14 }, (_, index) => page(index, { current: index === 5 }))).size, 0)
  // Above the threshold the current page outranks plain visible pages; cap is three.
  const ranked = selectTextPages([
    page(0, { scale: 0.6, visible: true, current: true }),
    page(1, { scale: 0.6, visible: true }),
    page(2, { scale: 0.6, visible: false, pinned: true }),
    page(3, { scale: 0.6, visible: true }),
    page(4, { scale: 0.6, visible: true }),
  ])
  assert.deepEqual([...ranked], [[2, 'run'], [0, 'run'], [1, 'run']])
  // At readable scale visible pages get glyphs, still bounded by the cap.
  const readable = selectTextPages(Array.from({ length: 8 }, (_, index) => page(index, { scale: 1, current: index === 2 })))
  assert.equal(readable.size, 3)
  assert.ok([...readable.values()].every(fidelity => fidelity === 'glyph'))
})
