import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PdfAnnotation, PdfPageInfo } from '../../../src/core/pdf-types.ts'
import { NativeViewport } from '../../../src/modules/viewer/rendering/viewport.ts'
import { PageContextOverlays, PageMarkupOverlay } from '../../../src/modules/viewer/rendering/PageOverlays.tsx'
import { annotationPolygons } from '../../../src/modules/viewer/model/reader-annotations.ts'

const geometry: PdfPageInfo = { page: 1, cropBox: [0, 0, 300, 400], rotation: 0, userUnit: 1 }
const viewport = new NativeViewport(geometry, 1, 0)

test('pending markup stays on the annotation layer only while a page is near', () => {
  const mark: PdfAnnotation = { id: 'highlight-1', page: 1, subtype: 'Highlight', rect: [10, 20, 80, 40],
    flags: 0, supported: true, editable: true, color: [1, 1, 0], quadPoints: [10, 40, 80, 40, 10, 20, 80, 20] }
  const props = { near: true, viewport, width: 300, height: 400, annotations: [mark], paintedAnnotations: [],
    patchBoxes: [], clipId: 'page-overlay-test' }
  const visible = renderToStaticMarkup(React.createElement(PageMarkupOverlay, props))
  assert.match(visible, /dsh-pdf-annotation-overlay/)
  assert.match(visible, /data-annotation-id="highlight-1"/)
  assert.match(visible, /mix-blend-mode:multiply/)
  assert.equal(renderToStaticMarkup(React.createElement(PageMarkupOverlay, { ...props, near: false })), '')
})

test('context layers keep note, comment, explanation and region targets distinct', () => {
  const note: PdfAnnotation = { id: 'note-1', page: 1, subtype: 'Text', rect: [10, 20, 30, 40],
    flags: 0, supported: true, editable: true }
  const comment: PdfAnnotation = { id: 'comment-1', page: 1, subtype: 'Highlight', rect: [40, 50, 80, 70],
    flags: 0, supported: true, editable: true, contents: 'Please explain this.' }
  const html = renderToStaticMarkup(React.createElement(PageContextOverlays, {
    near: true, textActive: false, viewport, width: 300, height: 400, pageNumber: 1, mode: 'text',
    annotations: [note, comment], selection: { kind: 'region', revision: 1, text: '',
      fragments: [{ page: 1, rect: [80, 100, 120, 140] as [number, number, number, number], quadPoints: [] }] },
    explanationExcerpts: [{ id: 'question-1', kind: 'text', question: 'Why?', text: 'sample',
      fragments: [{ page: 1, rect: [40, 50, 80, 70] as [number, number, number, number], quadPoints: [] }] }],
    ocrWords: [], ocrHost: React.createRef<HTMLDivElement>(), keyboardLinks: [], drag: null,
    followLink() {}, onAnnotation() {}, t: key => key,
  }))
  assert.match(html, /dsh-pdf-note-marker/)
  assert.match(html, /data-pdf-comment-id="comment-1"/)
  assert.match(html, /data-pdf-explanation-id="question-1"/)
  assert.match(html, /dsh-pdf-region/)
})

test('external replies create one page comment marker on their parent markup', () => {
  const root: PdfAnnotation = { id: 'mark', page: 1, subtype: 'Highlight', rect: [20, 30, 90, 50],
    flags: 4, supported: true, editable: true }
  const first: PdfAnnotation = { id: 'reply-1', page: 1, subtype: 'Text', rect: [20, 30, 35, 45],
    replyToId: root.id, contents: 'Imported reply', flags: 4, supported: true, editable: true }
  const second: PdfAnnotation = { ...first, id: 'reply-2', replyToId: first.id, contents: 'Nested' }
  const html = renderToStaticMarkup(React.createElement(PageContextOverlays, {
    near: true, textActive: false, viewport, width: 300, height: 400, pageNumber: 1, mode: 'text',
    annotations: [root, first, second], selection: null, ocrWords: [], ocrHost: React.createRef<HTMLDivElement>(),
    keyboardLinks: [], drag: null, followLink() {}, onAnnotation() {}, t: key => key,
  }))
  assert.match(html, /data-pdf-comment-id="mark"/)
  assert.match(html, /data-icon="commentedMark"/)
  assert.doesNotMatch(html, /data-pdf-comment-id="reply-/)
  assert.doesNotMatch(html, /dsh-pdf-note-marker/)
  const markerStyle = html.match(/class="dsh-pdf-comment-marker[^\"]*"[^>]*style="([^\"]+)"/)?.[1]
  const markerTop = Number(markerStyle?.match(/top:([\d.]+)px/)?.[1])
  const annotationTop = Math.min(...annotationPolygons(root, viewport)[0]!.map(([, y]) => y))
  assert.ok(Math.abs(markerTop + 24 - annotationTop) < 0.01, 'the marker stays above the markup instead of covering selected words')
})
