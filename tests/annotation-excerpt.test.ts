import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnnotationList } from '../src/client/AnnotationList.tsx'
import { annotationExcerpt } from '../src/client/reader-annotation-excerpt.ts'
import type { PdfAnnotation } from '../src/core/pdf-types.ts'
import type { NativeTextContent } from '../src/shared/native.ts'

const annotation: PdfAnnotation = { id: 'highlight', page: 1, subtype: 'Highlight', flags: 4, supported: true, editable: true,
  rect: [64, 98, 118, 110], quadPoints: [64, 110, 118, 110, 64, 98, 118, 98] }
const content: NativeTextContent = { lang: null, styles: {}, items: [
  { str: 'Earlier text', transform: [10, 0, 0, 10, 0, 100], width: 50, height: 10, dir: 'ltr', fontName: 'nativeSans', hasEOL: false },
  { str: 'Target phrase', transform: [10, 0, 0, 10, 60, 100], width: 70, height: 10, dir: 'ltr', fontName: 'nativeSans', hasEOL: false },
] }

test('annotation preview uses nearby text runs rather than the comment field', () => {
  assert.equal(annotationExcerpt({ ...annotation, contents: 'My comment' }, content), 'Target phrase')
  assert.equal(annotationExcerpt({ ...annotation, subtype: 'Text' }, content), undefined)
  assert.equal(annotationExcerpt({ ...annotation, rect: [200, 200, 210, 210], quadPoints: undefined }, content), undefined)
})

test('annotation sidebar groups compact rows by page and keeps full metadata out of the list', () => {
  const html = renderToStaticMarkup(React.createElement(AnnotationList, {
    annotations: [{ ...annotation, contents: 'First note', author: 'Alice', createdAt: '2026-10-14T08:00:00Z' },
      { ...annotation, id: 'second', page: 2, contents: 'Second note' }],
    pdf: null, onSelect: () => {}, onDeselect: () => {},
    t: key => ({ 'reader.comments': 'Annotations', 'reader.filterAnnotations': 'Filter annotations',
      'reader.allAnnotations': 'All annotations', 'reader.annotationPagePrefix': 'Page ', 'reader.annotationPageSuffix': '',
      'reader.type.Highlight': 'Highlight' }[key] ?? key),
  }))
  assert.match(html, /Annotations <span class="dsh-pdf-annotation-count">2<\/span>/)
  assert.match(html, /Page 1/)
  assert.match(html, /Page 2/)
  assert.match(html, /First note/)
  assert.match(html, /Second note/)
  assert.doesNotMatch(html, /Alice|Created:/)
})
