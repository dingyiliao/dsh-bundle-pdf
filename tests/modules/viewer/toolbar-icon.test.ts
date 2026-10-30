import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolbarIcon, type ToolbarIconName } from '../../../src/modules/viewer/components/ToolbarIcon.tsx'

const render = (props: { name: ToolbarIconName; accent?: string }) =>
  renderToStaticMarkup(React.createElement(ToolbarIcon, props))

/** The rendered icon is `<path d="..." ...></path>` per subpath. */
const paths = (markup: string) =>
  [...markup.matchAll(/<path d="([^"]+)"([^>]*)><\/path>/g)].map(match => ({ d: match[1]!, attributes: match[2]! }))

/**
 * The highlighter glyph draws a bar under the pen. That bar is the mark, so an
 * accent colours it in place; a second bar stacked below the icon is what made
 * the control look misaligned with the underline icon beside it.
 */
test('the highlight accent colours the glyph bar and nothing else', () => {
  const markup = render({ name: 'highlight', accent: '#ff9f0a' })
  const drawn = paths(markup)
  assert.equal(drawn.length, 2)
  const bar = drawn.find(path => path.d === 'M3 21h14')
  const pen = drawn.find(path => path.d.startsWith('m4 17'))
  assert.ok(bar, 'the highlighter keeps a bar subpath')
  assert.ok(pen, 'the highlighter keeps its pen subpath')
  assert.match(bar.attributes, /stroke="#ff9f0a"/, 'the bar carries the accent')
  assert.doesNotMatch(pen.attributes, /stroke=/, 'the pen inherits currentColor from the svg')
  // No extra element may be emitted: the colour lives inside the glyph.
  assert.doesNotMatch(markup, /<span/)
})

test('without an accent the bar follows currentColor', () => {
  const markup = render({ name: 'highlight' })
  const bar = paths(markup).find(path => path.d === 'M3 21h14')
  assert.ok(bar)
  assert.match(bar.attributes, /stroke="currentColor"/)
  assert.doesNotMatch(markup, /stroke="#[0-9a-f]{6}"/)
})

test('the two text-mark bars share one baseline', () => {
  // A shared y keeps the adjacent highlight and underline icons on one line.
  assert.equal(paths(render({ name: 'highlight', accent: '#ffff00' })).find(path => path.d === 'M3 21h14')?.d, 'M3 21h14')
  assert.match(render({ name: 'underline' }), /d="M6 4v8a6 6 0 0 0 12 0V4M4 21h16"/)
})

test('undo and redo use matching, centered arrowheads', () => {
  assert.deepEqual(paths(render({ name: 'undo' })).map(path => path.d),
    ['m9 4-5 5 5 5', 'M4 9h9a7 7 0 0 1 7 7v3'])
  assert.deepEqual(paths(render({ name: 'redo' })).map(path => path.d),
    ['m15 4 5 5-5 5', 'M20 9h-9a7 7 0 0 0-7 7v3'])
})

test('Tools uses a toolbox silhouette rather than an ambiguous overflow mark', () => {
  const markup = render({ name: 'tools' })
  assert.match(markup, /data-icon="tools"/)
  assert.match(markup, /<rect x="3" y="8" width="18" height="12" rx="2"/)
  assert.match(markup, /d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h7m4 0h7"/)
  assert.doesNotMatch(markup, /<circle/)
})

test('the rename pencil uses the shared SVG canvas and stroke instead of a font glyph', () => {
  const markup = render({ name: 'edit' })
  assert.match(markup, /viewBox="0 0 24 24" width="18" height="18"/)
  assert.match(markup, /stroke-width="1.7"/)
  assert.match(markup, /data-icon="edit"/)
  assert.deepEqual(paths(markup).map(path => path.d), ['m15 4 5 5L9 20H4v-5L15 4ZM12.5 6.5l5 5'])
  assert.doesNotMatch(markup, /<text|✎/)
})

test('commented mark keeps the page top and folded corner visible above its comment bubble', () => {
  const drawn = paths(render({ name: 'commentedMark', accent: '#4b72e8' }))
  assert.ok(drawn.some(path => path.d === 'M5 3.5h8l4 4V12M5 3.5v17h8'), 'the document silhouette has an explicit top edge')
  assert.ok(drawn.some(path => path.d === 'M13 3.5v4h4'), 'the folded corner remains visible')
  assert.ok(drawn.some(path => path.d.startsWith('M13 13h5a1.5 1.5')), 'the comment bubble is a distinct overlay')
  assert.ok(drawn.some(path => path.d === 'M8 16h3.5' && /stroke="#4b72e8"/.test(path.attributes)), 'the comment accent remains visible')
})

test('region capture uses crossing crop guides instead of fullscreen corners', () => {
  const markup = render({ name: 'crop' })
  const drawn = paths(markup)
  assert.match(drawn[0]!.d, /^M7 3v12/)
  assert.match(drawn[0]!.d, /M3 7h12/)
  assert.ok(drawn.some(path => /stroke-dasharray=/.test(path.attributes)), 'the inside selection is distinct from the outer crop guides')
  assert.doesNotMatch(markup, /M4 9V4h5m6 0h5v5/, 'four fullscreen-style corners are no longer used')
})
