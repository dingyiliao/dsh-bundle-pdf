import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { OcrTranscriptPanel } from '../../../src/client/viewer/components/OcrTranscriptPanel.tsx'
import { ReadingSidebar } from '../../../src/client/viewer/components/ReadingSidebar.tsx'
import { readerLocales } from '../../../src/client/viewer/index.js'
import type { HostOcrRecognition } from '../../../src/adapters/client/remote/host-ocr-api.ts'

const t = (key: string) => (readerLocales.en as Record<string, string>)[key] ?? key
const transcript: HostOcrRecognition = {
  documentId: 'pdf-1', page: 3, revision: 2, contentVersion: 'v1',
  text: 'First line\nSecond <line>', status: 'complete',
  source: { backendId: 'session-llm', backendVersion: '1' },
  geometry: { status: 'none' }, warnings: ['geometry-unavailable'],
}

test('OCR transcript uses compact metadata and an accessible copy icon without backend or technical paragraphs', () => {
  const html = renderToStaticMarkup(React.createElement(OcrTranscriptPanel, {
    result: transcript, region: true, t,
  }))
  assert.match(html, /Page 3 · Region OCR/)
  assert.match(html, /First line\nSecond &lt;line&gt;/)
  assert.match(html, /Copy transcript/)
  assert.match(html, /title="Recognized text\. Check it against the page before using it\."/)
  assert.match(html, /aria-label="Copy transcript"[^>]*>.*data-icon="copy"/)
  assert.doesNotMatch(html, /dsh-pdf-ocr-layer|session-llm|precisely positioned|<p[^>]*>Recognized text/)
})

test('an empty OCR transcript shows no recognized text, not a failed request', () => {
  const html = renderToStaticMarkup(React.createElement(OcrTranscriptPanel, {
    result: { ...transcript, text: '', status: 'complete' }, region: false, t,
  }))
  assert.match(html, /No text was recognized/)
  assert.doesNotMatch(html, /Copy transcript/)
  assert.doesNotMatch(html, /role="alert"/)
})

async function withTranscript(run: (fixture: {
  container: HTMLElement
  dom: Window & typeof globalThis
  calls: ({ start: number; end: number } | undefined)[]
  render(result: HostOcrRecognition | null, enabled?: boolean): Promise<void>
  select(start: number, end: number): Promise<void>
  button(label: string): HTMLButtonElement
  unmount(): Promise<void>
}) => Promise<void>) {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><p id="outside">Outside selection</p><div id="root" class="dsh-pdf-reader"></div></body></html>', { globals: [] })

  installDom({ window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, CustomEvent: dom.CustomEvent,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true })
  const container = dom.document.getElementById('root')!, root = createRoot(container)
  const calls: ({ start: number; end: number } | undefined)[] = []
  let mounted = true
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  const render = async (result: HostOcrRecognition | null, enabled = true) => {
    await act(async () => root.render(React.createElement(OcrTranscriptPanel, {
      result, region: true, t, ...(enabled ? { onTranslate: (range?: { start: number; end: number }) => { calls.push(range) } } : {}),
    })))
  }
  try {
    await render(transcript)
    await run({ container, dom, calls, render, unmount,
      async select(start, end) {
        const text = container.querySelector('pre')!.firstChild!
        const range = dom.document.createRange()
        range.setStart(text, start); range.setEnd(text, end)
        await act(async () => {
          dom.document.getSelection()!.removeAllRanges()
          dom.document.getSelection()!.addRange(range)
          dom.document.dispatchEvent(new dom.Event('selectionchange'))
        })
      },
      button(label) {
        const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(element =>
          element.getAttribute('aria-label') === label || element.textContent === label)
        assert.ok(button, `Missing button ${label}`)
        return button
      },
    })
  } finally {
    await unmount()
    restoreDom()

  }
}

test('OCR primary action follows the text selection without adding a second translation button or automatic request', async () => {
  await withTranscript(async fixture => {
    assert.equal(fixture.container.querySelector('.dsh-pdf-split-action-main')!.getAttribute('aria-label'), 'Translate all')
    assert.equal(fixture.container.querySelectorAll('.dsh-pdf-split-action-main').length, 1)
    await act(async () => fixture.button('Translate all').click())
    assert.deepEqual(fixture.calls, [undefined])
    await fixture.select(6, transcript.text.length)
    assert.equal(fixture.button('Translate selected text').disabled, false)
    assert.deepEqual(fixture.calls, [undefined], 'selection alone never starts a model request')
    const action = fixture.button('Translate selected text')
    assert.equal(action.querySelector('.dsh-pdf-ocr-translate-label-full')!.textContent, 'Translate selection')
    assert.equal(action.querySelector('.dsh-pdf-ocr-translate-label-compact')!.textContent, 'Translate')
    const pointer = new fixture.dom.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    assert.equal(action.dispatchEvent(pointer), false, 'pointer focus must not collapse the text range before clicking')
    await act(async () => action.click())
    assert.deepEqual(fixture.calls, [undefined, { start: 6, end: transcript.text.length }])
    assert.equal(fixture.dom.document.getSelection()!.toString(), transcript.text.slice(6))
  })
})

test('the shared translation dropdown keeps full translation available while text is selected', async () => {
  await withTranscript(async fixture => {
    await fixture.select(6, transcript.text.length)
    const trigger = fixture.button('Translation options')
    trigger.focus()
    await act(async () => trigger.click())
    const menu = fixture.container.querySelector<HTMLElement>('[data-testid="pdf-ocr-translation-options"]')!
    assert.ok(menu)
    assert.equal(menu.getAttribute('role'), 'dialog')
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    const choices = [...menu.querySelectorAll<HTMLButtonElement>('button')]
    assert.deepEqual(choices.map(button => button.textContent), ['Translate all', 'Translate selected text'])
    assert.equal(choices[1]!.disabled, false)
    await act(async () => choices[0]!.click())
    assert.deepEqual(fixture.calls, [undefined])
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')

    await fixture.select(6, transcript.text.length)
    await act(async () => trigger.click())
    const partial = fixture.container.querySelector('[data-testid="pdf-ocr-translation-options"]')!
      .querySelectorAll<HTMLButtonElement>('button')[1]!
    await act(async () => partial.click())
    assert.deepEqual(fixture.calls, [undefined, { start: 6, end: transcript.text.length }])
  })
})

test('the translation dropdown does not offer a partial action for absent or invalid selections', async () => {
  await withTranscript(async fixture => {
    await act(async () => fixture.button('Translation options').click())
    const choices = fixture.container.querySelector('[data-testid="pdf-ocr-translation-options"]')!
      .querySelectorAll<HTMLButtonElement>('button')
    assert.equal(choices[1]!.disabled, true)
    await act(async () => choices[1]!.click())
    assert.deepEqual(fixture.calls, [])
    await act(async () => choices[0]!.click())
    assert.deepEqual(fixture.calls, [undefined])
  })
})

test('keyboard-style selections preserve exact multiline UTF16 offsets and reject split surrogate pairs', async () => {
  const unicode = { ...transcript, text: '  中文 😀\nSecond line\n末尾' }
  await withTranscript(async fixture => {
    await fixture.render(unicode)
    const start = unicode.text.indexOf('😀'), end = unicode.text.indexOf('\n末尾')
    await fixture.select(start, end)
    const button = fixture.button('Translate selected text')
    button.focus()
    await act(async () => button.click())
    assert.deepEqual(fixture.calls, [{ start, end }])
    assert.equal(unicode.text.slice(start, end), '😀\nSecond line')
    await fixture.select(start + 1, end)
    assert.equal(fixture.container.querySelector('.dsh-pdf-split-action-main')!.getAttribute('aria-label'), 'Translate all')
    await fixture.select(0, 2)
    assert.equal(fixture.container.querySelector('.dsh-pdf-split-action-main')!.getAttribute('aria-label'), 'Translate all',
      'blank ranges do not become a partial translation')
  })
})

test('outside, cross-boundary and collapsed selections clear the partial action', async () => {
  await withTranscript(async fixture => {
    const document = fixture.dom.document
    await fixture.select(0, 5)
    const outside = document.getElementById('outside')!.firstChild!
    const choose = async (start: Node, startOffset: number, end: Node, endOffset: number) => {
      const range = document.createRange()
      range.setStart(start, startOffset); range.setEnd(end, endOffset)
      await act(async () => {
        document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
        document.dispatchEvent(new fixture.dom.Event('selectionchange'))
      })
      assert.equal(fixture.container.querySelector('.dsh-pdf-split-action-main')!.getAttribute('aria-label'), 'Translate all')
    }
    await choose(outside, 0, outside, 7)
    await fixture.select(0, 5)
    await choose(outside, 0, fixture.container.querySelector('pre')!.firstChild!, 5)
    await fixture.select(2, 2)
    assert.equal(fixture.container.querySelector('.dsh-pdf-split-action-main')!.getAttribute('aria-label'), 'Translate all')
    assert.deepEqual(fixture.calls, [])
  })
})

test('replacing the OCR result clears selection and clipboard errors; empty or disconnected OCR cannot translate', async () => {
  await withTranscript(async fixture => {
    await fixture.select(0, 5)
    Object.defineProperty(fixture.dom.navigator, 'clipboard', { configurable: true,
      value: { writeText: async () => { throw new Error('clipboard denied') } } })
    await act(async () => fixture.button('Copy transcript').click())
    assert.ok(fixture.container.querySelector('[role="alert"]'))
    await fixture.render({ ...transcript, page: 4, text: 'Replacement transcript' })
    assert.equal(fixture.container.querySelector('.dsh-pdf-split-action-main')!.getAttribute('aria-label'), 'Translate all')
    assert.equal(fixture.container.querySelector('[role="alert"]'), null)
    assert.equal(fixture.dom.document.getSelection()!.rangeCount, 0)
    await fixture.render({ ...transcript, text: '' })
    assert.equal(fixture.container.querySelector('button'), null)
    await fixture.render(transcript, false)
    assert.equal(fixture.container.textContent!.includes('Translate all'), false)
    let copied = ''
    Object.defineProperty(fixture.dom.navigator, 'clipboard', { configurable: true,
      value: { writeText: async (text: string) => { copied = text } } })
    await act(async () => fixture.button('Copy transcript').click())
    assert.equal(copied, transcript.text)
    assert.deepEqual(fixture.calls, [])
  })
})

test('OCR removes selection listeners and ignores a late clipboard failure after unmount', async () => {
  await withTranscript(async fixture => {
    const removed: EventListenerOrEventListenerObject[] = []
    const document = fixture.dom.document
    const original = document.removeEventListener.bind(document)
    document.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === 'selectionchange') removed.push(listener)
      original(type, listener, options)
    }
    let fail!: (error: Error) => void
    Object.defineProperty(fixture.dom.navigator, 'clipboard', { configurable: true,
      value: { writeText: () => new Promise<void>((_resolve, reject) => { fail = reject }) } })
    await act(async () => fixture.button('Copy transcript').click())
    await fixture.select(0, 5)
    await fixture.unmount()
    assert.equal(removed.length, 1)
    assert.equal(document.getSelection()!.toString(), '')
    assert.equal(document.getSelection()!.isCollapsed, true)
    await act(async () => { fail(new Error('late failure')); await Promise.resolve() })
    assert.equal(fixture.container.textContent, '')
  })
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
