import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReadingSidebar } from '../../../src/modules/viewer/components/ReadingSidebar.tsx'
import { readerLocales } from '../../../src/modules/viewer/index.js'
import type { ReaderDocument } from '../../../src/modules/viewer/ports/reader-document.ts'

const t = (key: string) => (readerLocales.en as Record<string, string>)[key] ?? key

test('collapsed page navigation groups the page steps and current/total numbers in one capsule', () => {
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    if (String(args[0]).startsWith('Warning: useLayoutEffect does nothing on the server')) return
    originalError(...args)
  }
  let html: string
  try {
    html = renderToStaticMarkup(React.createElement(ReadingSidebar, {
      activeSection: 'ocr', onSectionChange: () => {}, expanded: false, onExpandedChange: () => {},
      panels: {}, pdf: { numPages: 858 } as ReaderDocument,
      currentPage: 329, pageInput: '329', navigating: false,
      onPageInputChange: () => {}, onPageInputSubmit: () => {}, onPageInputReset: () => {},
      onNavigatePage: () => {}, onStepPage: () => {}, onNavigateDestination: () => {}, t,
    }))
  } finally { console.error = originalError }

  const capsule = html.match(/<div class="dsh-pdf-sidebar-page-nav is-compact"[\s\S]*?<\/form><button[\s\S]*?<\/button><\/div>/)?.[0]
  assert.ok(capsule)
  assert.match(capsule, /aria-label="Previous page"/)
  assert.match(capsule, /value="329"/)
  assert.match(capsule, /class="dsh-pdf-page-total"[^>]*aria-label="Total pages 858"[^>]*>858<\/span>/)
  assert.match(capsule, /aria-label="Next page"/)
  assert.ok(capsule.indexOf('Previous page') < capsule.indexOf('value="329"'))
  assert.ok(capsule.indexOf('value="329"') < capsule.indexOf('>858</span>'))
  assert.ok(capsule.indexOf('>858</span>') < capsule.indexOf('Next page'))
})
