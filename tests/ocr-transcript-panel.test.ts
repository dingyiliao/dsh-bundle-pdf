import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OcrTranscriptPanel } from '../src/client/OcrTranscriptPanel.tsx'
import { ReadingSidebar } from '../src/client/ReadingSidebar.tsx'
import { readerLocales } from '../src/client/reader-locales.ts'
import type { HostOcrRecognition } from '../src/client/host-ocr-api.ts'

const t = (key: string) => (readerLocales.en as Record<string, string>)[key] ?? key
const transcript: HostOcrRecognition = {
  documentId: 'pdf-1', page: 3, revision: 2, contentVersion: 'v1',
  text: 'First line\nSecond <line>', status: 'complete',
  source: { backendId: 'session-llm', backendVersion: '1' },
  geometry: { status: 'none' }, warnings: ['geometry-unavailable'],
}

test('OCR transcript is visible, copyable, and explicitly not a positioned PDF text layer', () => {
  const html = renderToStaticMarkup(React.createElement(OcrTranscriptPanel, {
    result: transcript, region: true, t,
  }))
  assert.match(html, /Page 3 · OCR region/)
  assert.match(html, /First line\nSecond &lt;line&gt;/)
  assert.match(html, /Copy transcript/)
  assert.match(html, /not a precisely positioned PDF text layer/)
  assert.doesNotMatch(html, /dsh-pdf-ocr-layer/)
})

test('an empty OCR transcript shows no recognized text, not a failed request', () => {
  const html = renderToStaticMarkup(React.createElement(OcrTranscriptPanel, {
    result: { ...transcript, text: '', status: 'complete' }, region: false, t,
  }))
  assert.match(html, /No text was recognized/)
  assert.doesNotMatch(html, /Copy transcript/)
  assert.doesNotMatch(html, /role="alert"/)
})

test('the reading sidebar provides an OCR section for the transcript', () => {
  // Other sidebar panels use layout effects only in the browser. Their SSR
  // warning is unrelated to the OCR tab markup being checked here.
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    if (String(args[0]).startsWith('Warning: useLayoutEffect does nothing on the server')) return
    originalError(...args)
  }
  let html: string
  try {
    html = renderToStaticMarkup(React.createElement(ReadingSidebar, {
      activeSection: 'ocr', onSectionChange: () => {}, expanded: true, onExpandedChange: () => {},
      panels: { ocr: React.createElement(OcrTranscriptPanel, { result: transcript, region: false, t }) },
      pdf: null, currentPage: 3, pageInput: '3', navigating: false,
      onPageInputChange: () => {}, onPageInputSubmit: () => {}, onPageInputReset: () => {},
      onNavigatePage: () => {}, onStepPage: () => {}, onNavigateDestination: () => {}, t,
    }))
  } finally { console.error = originalError }
  assert.match(html, /role="tab"[^>]*aria-label="OCR"[^>]*aria-selected="true"/)
  assert.match(html, /role="tabpanel"[^>]*>.*dsh-pdf-ocr-transcript/s)
})
