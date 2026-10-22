import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfPageInfo } from '../../../src/core/pdf-types.ts'
import type { NativeDocument } from '../../../src/modules/viewer/index.ts'
import type { OcrPage } from '../../../src/modules/viewer/controllers/reader-lifetime.ts'
import { useReaderSearch, type ReaderSearchOptions } from '../../../src/modules/viewer/index.ts'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

const pages: PdfPageInfo[] = [1, 2].map(page => ({ page, cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }))

function documentWithText(texts: readonly string[]): NativeDocument {
  return { numPages: texts.length, async getPage(number: number) {
    return { async getTextContent() { return { items: [{ str: texts[number - 1], transform: [1, 0, 0, 1, 18, 42],
      width: 80, height: 12, hasEOL: false }] } } }
  } } as unknown as NativeDocument
}

async function withSearch(run: (fixture: {
  state(): ReturnType<typeof useReaderSearch>
  options: ReaderSearchOptions
  render(options: ReaderSearchOptions): Promise<void>
}) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const tab = new AbortController()
  let latest: ReturnType<typeof useReaderSearch> | undefined
  const Harness = (props: ReaderSearchOptions) => { latest = useReaderSearch(props); return null }
  const options: ReaderSearchOptions = { document: documentWithText(['An Elephant walks', 'no native hit']), pages,
    ocrPages: new Map<number, OcrPage>([[2, { text: 'ELEPHANT diagram', words: [], engine: 'test', warnings: [] }]]),
    tabSignal: tab.signal, onError: error => { throw error } }
  const render = async (next: ReaderSearchOptions) => { await act(async () => { root.render(React.createElement(Harness, next)) }) }
  try { await render(options); await run({ state: () => latest!, options, render }) }
  finally {
    await act(async () => root.unmount())
    tab.abort()
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('search hook owns query, progress, results and UI completion state', async () => {
  await withSearch(async ({ state }) => {
    await act(async () => state().setQuery('elephant'))
    await act(async () => { await state().run() })
    assert.equal(state().query, 'elephant')
    assert.equal(state().searching, false)
    assert.equal(state().searched, true)
    assert.deepEqual(state().hits.map(hit => [hit.page, hit.source]), [[1, 'native'], [2, 'ocr']])
    assert.equal(state().hits[1].x, undefined)
  })
})

test('content reset invalidates prior results without clearing the user query', async () => {
  await withSearch(async ({ state, options, render }) => {
    await act(async () => state().setQuery('elephant'))
    await act(async () => { await state().run() })
    assert.equal(state().hits.length, 2)
    await act(async () => state().resetContent())
    assert.equal(state().searched, false)
    assert.equal(state().hits.length, 0)
    assert.equal(state().query, 'elephant')
    await render({ ...options, document: documentWithText(['another topic']), pages: pages.slice(0, 1), ocrPages: new Map() })
    await act(async () => { await state().run() })
    assert.equal(state().searched, true)
    assert.equal(state().hits.length, 0)
  })
})

test('search hook preserves the 500-result UI cap', async () => {
  await withSearch(async ({ state, options, render }) => {
    await render({ ...options, document: documentWithText(['target '.repeat(600)]),
      pages: pages.slice(0, 1), ocrPages: new Map() })
    await act(async () => state().setQuery('target'))
    await act(async () => { await state().run() })
    assert.equal(state().hits.length, 500)
    assert.equal(state().searched, true)
  })
})

test('document invalidation cancels an in-flight native search and drops late results', async () => {
  await withSearch(async ({ state, options, render }) => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const slow = { numPages: 1, async getPage() {
      return { async getTextContent() { await gate; return { items: [{ str: 'target', transform: [1, 0, 0, 1, 0, 0],
        width: 80, height: 12, hasEOL: false }] } } }
    } } as unknown as NativeDocument
    await render({ ...options, document: slow, pages: pages.slice(0, 1), ocrPages: new Map() })
    await act(async () => state().setQuery('target'))
    let pending: Promise<void> | undefined
    await act(async () => { pending = state().run(); await Promise.resolve() })
    assert.equal(state().searching, true)
    await act(async () => state().invalidateDocument())
    assert.equal(state().searching, false)
    release!()
    await act(async () => { await pending })
    assert.deepEqual(state().hits, [])
    assert.equal(state().searched, false)
  })
})

test('cancelled search leaves the query intact and cannot publish a completion', async () => {
  await withSearch(async ({ state, options, render }) => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const slow = { numPages: 1, async getPage() {
      return { async getTextContent() { await gate; return { items: [{ str: 'target', transform: [1, 0, 0, 1, 0, 0],
        width: 80, height: 12, hasEOL: false }] } } }
    } } as unknown as NativeDocument
    await render({ ...options, document: slow, pages: pages.slice(0, 1), ocrPages: new Map() })
    await act(async () => state().setQuery('target'))
    let pending: Promise<void> | undefined
    await act(async () => { pending = state().run(); await Promise.resolve() })
    await act(async () => state().cancel())
    release!()
    await act(async () => { await pending })
    assert.equal(state().query, 'target')
    assert.equal(state().searching, false)
    assert.equal(state().searched, false)
  })
})
