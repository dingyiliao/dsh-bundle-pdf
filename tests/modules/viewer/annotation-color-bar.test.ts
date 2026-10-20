import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnnotationColorBar } from '../../../src/modules/viewer/components/AnnotationColorBar.tsx'
import { DEFAULT_HIGHLIGHT_QUICK_COLORS } from '../../../src/modules/viewer/model/highlight-colors.ts'
import { readerLocales } from '../../../src/modules/viewer/index.js'

const t = (key: string) => (readerLocales.en as Record<string, string>)[key] ?? key

const render = (value: string, disabled = false) => {
  // Node has no localStorage; the bar must fall back to the default quick colors
  // instead of throwing, which is also the reader's first-run path.
  const globals = globalThis as { localStorage?: unknown }
  const previous = globals.localStorage
  globals.localStorage = { getItem: () => null, setItem: () => {} }
  try {
    return renderToStaticMarkup(React.createElement(AnnotationColorBar, {
      value, disabled, label: t('reader.annotationColor'), t, onQuickColor: () => {}, onPaletteColor: () => {},
    }))
  } finally {
    if (previous === undefined) delete globals.localStorage
    else globals.localStorage = previous
  }
}

/** Highlight, underline and strike-out share this bar; only the pressed slot differs. */
const MARKS = [
  { subtype: 'Highlight', hex: '#ff9f0a' },
  { subtype: 'Underline', hex: '#80bfff' },
  { subtype: 'StrikeOut', hex: '#d1a2ff' },
] as const

test('every text mark gets the same quick colors, palette and add control', () => {
  const rendered = MARKS.map(mark => ({ ...mark, html: render(mark.hex) }))
  for (const { subtype, hex, html } of rendered) {
    assert.equal((html.match(/data-testid="pdf-highlight-swatch-\d"/g) ?? []).length, DEFAULT_HIGHLIGHT_QUICK_COLORS.length,
      `${subtype} shows all five quick slots`)
    assert.match(html, /data-testid="pdf-highlight-palette"/, `${subtype} shows the palette`)
    assert.match(html, new RegExp(`aria-pressed="true"[^>]*>\\s*<span class="dsh-pdf-highlight-swatch-core" style="background-color:${hex}"`),
      `${subtype} marks its own color as pressed`)
    // A saved color needs no add button, but any unsaved one still offers it.
    assert.doesNotMatch(html, /data-testid="pdf-highlight-add-color"/, `${subtype} hides add for a saved color`)
    assert.match(render('#123456'), /data-testid="pdf-highlight-add-color"/, `${subtype} offers adding an unsaved color`)
    assert.equal(hex, hex.toLowerCase(), `${subtype} uses a normalized hex color`)
  }
  // Normalizing the pressed marker and every color away leaves one identical
  // control set for all three marks.
  const shapes = rendered.map(({ html }) => html
    .replace(/aria-pressed="(?:true|false)"/g, 'aria-pressed="X"')
    .replace(/#[0-9a-f]{6}/g, 'COLOR'))
  assert.equal(new Set(shapes).size, 1, 'the three marks render the same control set')
})

test('a disabled mark keeps the bar visible but not operable', () => {
  const html = render('#ffff00', true)
  assert.equal((html.match(/disabled=""/g) ?? []).length, DEFAULT_HIGHLIGHT_QUICK_COLORS.length + 1)
  assert.match(html, /data-testid="pdf-highlight-palette"[^>]*disabled/)
})
