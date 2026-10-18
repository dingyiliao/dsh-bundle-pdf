import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnnotationList } from '../src/client/AnnotationList.tsx'
import { annotationExcerpt } from '../src/shared/annotation-excerpt.ts'
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

test('annotation preview rejects excessive quadrilaterals before reading their coordinates', () => {
  let coordinateReads = 0
  const quadPoints = new Proxy(Array<number>(257 * 8).fill(0), {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) coordinateReads++
      return Reflect.get(target, key, receiver)
    },
  })
  assert.equal(annotationExcerpt({ ...annotation, quadPoints }, content), undefined)
  assert.equal(coordinateReads, 0)
})

test('annotation preview stops scanning text runs on an unusually dense page', () => {
  const farAway = { ...content.items[0], transform: [10, 0, 0, 10, 1000, 1000] }
  const items = Array<NativeTextContent['items'][number]>(100_000).fill(farAway)
  items[items.length - 1] = content.items[1]
  let itemReads = 0
  const observed = new Proxy(items, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) itemReads++
      return Reflect.get(target, key, receiver)
    },
  })
  assert.equal(annotationExcerpt(annotation, { ...content, items: observed }), undefined)
  assert.ok(itemReads <= 8193, `read ${itemReads} text items`)
})

test('annotation preview caps exact overlap checks after broad-phase filtering', () => {
  const quads = Array.from({ length: 256 }, (_, x) => [x, 1, x + 0.2, 1, x, 0, x + 0.2, 0]).flat()
  const betweenQuads = { ...content.items[0], str: 'Not selected',
    transform: [1, 0, 0, 1, 128.5, 0], width: 0.1, height: 0.1 }
  const selected = { ...betweenQuads, str: 'Target phrase', transform: [1, 0, 0, 1, 0, 0] }
  const mark = { ...annotation, quadPoints: quads }
  assert.equal(annotationExcerpt(mark, { ...content, items: [...Array(100).fill(betweenQuads), selected] }), 'Target phrase')
  assert.equal(annotationExcerpt(mark, { ...content, items: [...Array(129).fill(betweenQuads), selected] }), undefined)
})

test('annotation preview caps an oversized matched text run before joining it', () => {
  const item = { ...content.items[1], str: 'A'.repeat(1_000_000) }
  assert.equal(annotationExcerpt(annotation, { ...content, items: [item] }), `${'A'.repeat(140)}…`)
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

test('annotation sidebar mounts only nearby rows in a long page group', () => {
  const annotations = Array.from({ length: 1000 }, (_, index): PdfAnnotation => ({
    ...annotation, id: `note-${index}`, subtype: 'Text', contents: `Note ${index}`,
  }))
  const html = renderToStaticMarkup(React.createElement(AnnotationList, {
    annotations, pdf: null, onSelect: () => {}, onDeselect: () => {},
    t: key => ({ 'reader.comments': 'Annotations', 'reader.filterAnnotations': 'Filter annotations',
      'reader.allAnnotations': 'All annotations', 'reader.annotationPagePrefix': 'Page ', 'reader.annotationPageSuffix': '',
      'reader.type.Text': 'Note' }[key] ?? key),
  }))
  assert.match(html, /Annotations <span class="dsh-pdf-annotation-count">1000<\/span>/)
  assert.match(html, /Page 1/)
  assert.match(html, /Note 0/)
  assert.doesNotMatch(html, /Note 999/)
  assert.ok((html.match(/class="dsh-pdf-comment-item/g) ?? []).length < 20)
})
