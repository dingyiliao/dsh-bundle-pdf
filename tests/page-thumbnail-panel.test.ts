import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PageThumbnailPanel, thumbnailColumnCount } from '../src/client/PageThumbnailPanel.tsx'
import type { ReaderDocument } from '../src/client/reader-document.ts'

test('page thumbnails switch to one column only when the sidebar is narrow', () => {
  assert.equal(thumbnailColumnCount(267), 1)
  assert.equal(thumbnailColumnCount(268), 2)
  assert.equal(thumbnailColumnCount(320), 2)
})

test('page thumbnails group consecutive pages into virtual rows without losing the current page', () => {
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    if (String(args[0]).startsWith('Warning: useLayoutEffect does nothing on the server')) return
    originalError(...args)
  }
  let html: string
  try {
    html = renderToStaticMarkup(React.createElement(PageThumbnailPanel, {
      pdf: { numPages: 5 } as ReaderDocument,
      active: true, currentPage: 4, onNavigatePage: () => {}, t: key => key === 'reader.page' ? 'Page' : key,
    }))
  } finally { console.error = originalError }
  assert.equal((html.match(/class="dsh-pdf-thumbnail-grid-row"/g) ?? []).length, 3)
  for (let page = 1; page <= 5; page++) assert.match(html, new RegExp(`aria-label="Page ${page} / 5"`))
  assert.doesNotMatch(html, /aria-label="Page 6 \/ 5"/)
  assert.match(html, /class="dsh-pdf-thumbnail-tile is-current" aria-current="page" aria-label="Page 4 \/ 5"/)
})
