import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createSelectionPage, resolveSelection, selectionOnPage, type SelectionGlyph } from '../../../src/engine/client/selection.js'
import { createSelectionPages } from '../../../src/engine/client/selection-pages.js'
import { useNativeSelection } from '../../../src/engine/client/use-native-selection.js'
import type { SelectionGeometryChunk } from '../../../src/engine/protocol/selection.js'
import { NativeViewport } from '../../../src/shared/geometry/native-viewport.js'
import type { PageView, ReaderSelection } from '../../../src/client/viewer/index.js'
import { createDom } from '../../support/dom.js'

const quad = (x: number, y: number): SelectionGlyph['quad'] => [x, y + 10, x + 5, y + 10, x, y, x + 5, y]
const glyph = (index: number, text: string, x: number, y = 10, line = 0): SelectionGlyph => ({
  index, end: index + text.length, text, line, quad: quad(x, y),
})

test('a deferred native word selection cannot commit after the Reader stops owning its geometry', async () => {
  const { dom, install, restore } = createDom()
  install({ Element: dom.Element })
  const root = createRoot(dom.document.getElementById('root')!)
  const lifetime = new AbortController()
  const views = { current: new Map<number, PageView>() }
  const viewport = new NativeViewport({ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }, 1)
  let canSelect = true
  let complete!: (value: SelectionGeometryChunk) => void
  const pending = new Promise<SelectionGeometryChunk>(resolve => { complete = resolve })
  const commits: (ReaderSelection | null)[] = []
  const pages = createSelectionPages({ signal: lifetime.signal, cropBox: () => [0, 0, 100, 100], read: () => pending })
  function ReaderHarness() {
    const select = useNativeSelection({ pages, views, active: true, revision: 1, visiblePage: 1,
      canSelect: () => canSelect, onSelect: selection => commits.push(selection), onError: error => { throw error } })
    return createElement('div', { onDoubleClick: select.onDoubleClick }, createElement('div', { 'data-pdf-page': '1' }))
  }
  try {
    await act(async () => root.render(createElement(ReaderHarness)))
    const element = dom.document.querySelector<HTMLElement>('[data-pdf-page]')!
    element.getBoundingClientRect = () => new dom.DOMRect(0, 0, 100, 100)
    views.current.set(1, { element, viewport, page: {} as PageView['page'] })
    const click = () => element.dispatchEvent(new dom.MouseEvent('dblclick', { bubbles: true, clientX: 12, clientY: 85 }))
    await act(async () => { click() })
    canSelect = false
    await act(async () => complete({
      offset: 0, charCount: 1, nextOffset: null, unmapped: 0,
      glyphs: [{ index: 0, end: 1, text: 'A', line: 0, quad: [10, 20, 15, 20, 10, 10, 15, 10] }],
    }))
    assert.equal(commits.length, 0)
    canSelect = true
    await act(async () => { click() })
    assert.equal(commits[0]?.text, 'A')
  } finally {
    await act(async () => root.unmount())
    lifetime.abort()
    restore()
  }
})

test('current-page semantic text remains available while native selection is disabled', async () => {
  const { dom, install, restore } = createDom()
  install({ Element: dom.Element })
  const root = createRoot(dom.document.getElementById('root')!)
  const lifetime = new AbortController()
  const views = { current: new Map<number, PageView>() }
  const pages = createSelectionPages({ signal: lifetime.signal, cropBox: () => [0, 0, 100, 100], read: async () => ({
    offset: 0, charCount: 1, nextOffset: null, unmapped: 0,
    glyphs: [{ index: 0, end: 1, text: 'A', line: 0, quad: [10, 20, 15, 20, 10, 10, 15, 10] }],
  }) })
  let latest: ReturnType<typeof useNativeSelection> | undefined
  function ReaderHarness() {
    latest = useNativeSelection({ pages, views, active: true, revision: 1, visiblePage: 1,
      canSelect: () => false, onSelect: () => {}, onError: error => { throw error } })
    return null
  }
  try {
    await act(async () => root.render(createElement(ReaderHarness)))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
    assert.equal(latest?.enabled, false)
    assert.deepEqual(latest?.semantic && { page: latest.semantic.page, text: latest.semantic.text }, { page: 1, text: 'A' })
  } finally {
    await act(async () => root.unmount())
    lifetime.abort()
    restore()
  }
})

test('positioned selection hits a caret and returns only the covered word with line-sized quads', () => {
  const page = createSelectionPage(1, [glyph(0, 'A', 0), { index: 1, end: 2, text: ' ', line: 0, quad: null },
    glyph(2, 'c', 10), glyph(3, 'a', 15), glyph(4, 't', 20), { index: 5, end: 7, text: '\n', line: 0, quad: null },
    glyph(7, 'B', 0, 0, 7)])
  const hit = page.hit(19, 15)
  assert.deepEqual(hit, { page: 1, offset: 4, glyphOffset: 3 })
  const word = page.word(hit!.glyphOffset)!
  assert.deepEqual(word, [{ page: 1, offset: 2 }, { page: 1, offset: 5 }])
  assert.deepEqual(resolveSelection(word[0], word[1], () => page, 8), {
    revision: 8, kind: 'text', text: 'cat', selectionBefore: 'A ', selectionAfter: '\nB',
    fragments: [{ page: 1, rect: [10, 10, 25, 20], quadPoints: [10, 20, 25, 20, 10, 10, 25, 10] }],
  })
  assert.equal(page.hit(60, 15, 2), null)
})

test('backwards cross-page range resolves all pages independently of mounted views', () => {
  const first = createSelectionPage(1, [glyph(0, 'A', 0), glyph(1, 'B', 5)])
  const middle = createSelectionPage(2, [glyph(0, 'X', 0), glyph(1, 'Y', 5)])
  const last = createSelectionPage(3, [glyph(0, 'C', 0), glyph(1, 'D', 5)])
  const start = { page: 1, offset: 1 }, end = { page: 3, offset: 1 }
  const selected = resolveSelection(end, start, number => [first, middle, last][number - 1], 3)
  assert.equal(selected?.text, 'B\nXY\nC')
  assert.deepEqual(selected?.fragments.map(fragment => fragment.page), [1, 2, 3])
  assert.equal(selected?.selectionBefore, 'A')
  assert.equal(selected?.selectionAfter, 'D')
  const preview = selectionOnPage(end, start, middle)
  assert.deepEqual(preview, selected?.fragments[1])
  assert.equal(selectionOnPage(end, start, middle), preview, 'intermediate-page geometry is reused')
  assert.equal(resolveSelection(start, end, number => [first, undefined, last][number - 1], 3), null)
  assert.equal(resolveSelection(start, end, number => [first, createSelectionPage(2, []), last][number - 1], 3)?.text, 'B\nC')
})

test('grapheme endpoints avoid splitting a surrogate pair or a combining mark', () => {
  const page = createSelectionPage(1, [glyph(0, 'a', 0),
    { index: 1, end: 2, line: 0, text: '\u0301', quad: null }, glyph(2, '😀', 5), glyph(4, 'b', 10)])
  assert.deepEqual(page.hit(4, 15), { page: 1, offset: 2, glyphOffset: 0 })
  assert.deepEqual(page.hit(9, 15), { page: 1, offset: 4, glyphOffset: 2 })
  assert.equal(page.step(0, 1).offset, 2)
  assert.equal(page.step(4, -1).offset, 2)
  assert.equal(page.fragment(1, 4), null)
  assert.equal(page.fragment(0, 3), null)
  assert.ok(page.fragment(0, 4))
})

test('geometry preserves text orientation, isolates wide gutters, and clips to the page crop', () => {
  const rotated = createSelectionPage(1, [
    { ...glyph(0, 'A', 0), quad: [10, 0, 10, 5, 20, 0, 20, 5] },
    { ...glyph(1, 'B', 0), quad: [10, 5, 10, 10, 20, 5, 20, 10] },
  ])
  assert.equal(rotated.hit(15, 1)?.offset, 0)
  assert.equal(rotated.hit(15, 9)?.offset, 2)
  assert.deepEqual(rotated.fragment(0, 2)?.quadPoints, [10, 0, 10, 10, 20, 0, 20, 10])
  const columns = createSelectionPage(1, [glyph(0, 'A', 0), glyph(1, 'B', 50)], [2, 12, 54, 18])
  const fragment = columns.fragment(0, 2)!
  assert.equal(fragment.quadPoints.length, 16, 'different visual blocks on one baseline do not merge')
  assert.deepEqual(fragment.rect, [2, 12, 54, 18])
  assert.equal(columns.hit(1, 15, 3), null, 'the invisible portion is not selectable')
  const partial = columns.fragment(0, 1)
  assert.ok(partial)
  assert.equal(columns.fragment(0, 1), partial, 'an unchanged drag endpoint reuses partial-page geometry')
})

test('non-whitespace with unknown geometry blocks the range, with no partial output', () => {
  const page = createSelectionPage(1, [glyph(0, 'A', 0), { ...glyph(1, 'B', 5), quad: null }, glyph(2, 'C', 10)])
  assert.equal(page.hasUnpositionedText, true)
  assert.equal(resolveSelection({ page: 1, offset: 0 }, { page: 1, offset: 3 }, () => page, 1), null)
  assert.ok(page.fragment(2, 3))
})

test('a glyph wholly beyond the page crop cannot participate in hit testing or a range', () => {
  const page = createSelectionPage(1, [glyph(0, 'A', 0), glyph(1, 'B', 70)], [0, 0, 60, 50])
  assert.equal(page.hit(72, 15), null)
  assert.equal(page.hasUnpositionedText, true)
  assert.ok(page.fragment(0, 1))
  assert.equal(page.fragment(0, 2), null)
})

test('selection pages reject mixed chunk revisions and cache the decision to fall back for unusable data', async () => {
  const lifetime = new AbortController()
  try {
    const calls: [number, number][] = []
    const pages = createSelectionPages({ signal: lifetime.signal, cropBox: () => [0, 0, 100, 100], async read(page, offset) {
      calls.push([page, offset])
      if (page === 1) return { offset, charCount: offset === 0 ? 2 : 3, nextOffset: offset === 0 ? 1 : null, unmapped: 0, glyphs: [] }
      return { offset, charCount: page === 2 ? 1 : 24_001, nextOffset: null, unmapped: page === 2 ? 1 : 0, glyphs: [] }
    } })
    await assert.rejects(pages.load(1), /geometry changed while reading the page/)
    assert.equal(pages.get(1), undefined, 'never publish partial geometry')
    for (const page of [2, 3]) {
      assert.equal(await pages.load(page), null)
      assert.equal(await pages.load(page), null)
    }
    assert.deepEqual(calls, [[1, 0], [1, 1], [2, 0], [3, 0]])
  } finally { lifetime.abort() }
})

test('native selection falls back when geometry is unreliable and leaves mapped OCR on the browser layer', async () => {
  const { dom, install, restore } = createDom()
  install({ Element: dom.Element })
  const root = createRoot(dom.document.getElementById('root')!)
  const lifetime = new AbortController()
  const views = { current: new Map<number, PageView>() }
  const requests: number[] = []
  const commits: (ReaderSelection | null)[] = []
  const pages = createSelectionPages({ signal: lifetime.signal, cropBox: () => [0, 0, 100, 100], async read(page) {
    requests.push(page)
    return { offset: 0, charCount: 1, nextOffset: null, unmapped: 0,
      glyphs: [{ ...glyph(0, 'A', 10), quad: null }] }
  } })
  function ReaderHarness({ hasMappedOcr }: { hasMappedOcr: boolean }) {
    const select = useNativeSelection({ pages, views, active: true, revision: 1, visiblePage: 1, hasMappedOcr,
      canSelect: () => true, onSelect: selection => commits.push(selection), onError: error => { throw error } })
    return createElement('div', { onKeyDown: select.onKeyDown, 'data-backend': select.enabled ? 'native' : 'browser' })
  }
  try {
    await act(async () => root.render(createElement(ReaderHarness, { hasMappedOcr: true })))
    const reader = dom.document.querySelector<HTMLElement>('[data-backend]')!
    assert.equal(reader.dataset.backend, 'browser')
    assert.deepEqual(requests, [])
    await act(async () => root.render(createElement(ReaderHarness, { hasMappedOcr: false })))
    assert.equal(reader.dataset.backend, 'native')
    await act(async () => reader.dispatchEvent(new dom.KeyboardEvent('keydown', { bubbles: true, key: 'End', shiftKey: true })))
    assert.equal(reader.dataset.backend, 'browser')
    assert.deepEqual(requests, [1])
    assert.deepEqual(commits, [null])
    assert.equal(await pages.load(1), null)
    assert.deepEqual(requests, [1], 'unusable geometry is remembered for this document')
  } finally {
    await act(async () => root.unmount())
    lifetime.abort()
    restore()
  }
})

test('line movement returns grapheme boundaries and can continue across a page edge', () => {
  const page = createSelectionPage(1, [glyph(0, 'a', 0), glyph(1, '😀', 5), glyph(3, '\n', 0), glyph(4, 'b', 0), glyph(5, 'c', 5)])
  assert.deepEqual(page.lineEdge(1, -1), { page: 1, offset: 0 })
  assert.deepEqual(page.lineEdge(1, 1), { page: 1, offset: 3 })
  assert.deepEqual(page.adjacentLine(1, 1), { page: 1, offset: 5 })
  assert.equal(page.adjacentLine(5, 1), null)
  assert.deepEqual(page.adjacentLine(6, -1), { page: 1, offset: 1 })
})

test('the selection controller falls back on read failures and can collapse, report and recover from interaction failures', async () => {
  const { dom, install, restore } = createDom()
  install({ Element: dom.Element })
  const root = createRoot(dom.document.getElementById('root')!)
  const lifetime = new AbortController()
  const views = { current: new Map<number, PageView>() }
  const viewport = new NativeViewport({ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }, 1)
  const pageCache = (read: Parameters<typeof createSelectionPages>[0]['read']) =>
    createSelectionPages({ signal: lifetime.signal, cropBox: () => [0, 0, 100, 100], read })
  const unavailable = pageCache(async () => { throw new Error('selection geometry RPC disconnected') })
  const available = pageCache(async () => ({ offset: 0, charCount: 1, nextOffset: null, unmapped: 0,
    glyphs: [{ index: 0, end: 1, text: 'A', line: 0, quad: [10, 20, 15, 20, 10, 10, 15, 10] }] }))
  const errors: unknown[] = [], commits: (ReaderSelection | null)[] = []
  let failCommit: Error | undefined
  function ReaderHarness({ pages }: { pages: typeof available }) {
    const select = useNativeSelection({ pages, views, active: true, revision: 1, visiblePage: 1, canSelect: () => true,
      onSelect(selection) { if (failCommit) throw failCommit; commits.push(selection) }, onError: error => errors.push(error) })
    return createElement('div', { 'data-backend': select.enabled ? 'native' : 'browser',
      onKeyDown: select.onKeyDown, onPointerDown: select.onPointerDown, onPointerUp: select.onPointerUp },
    createElement('div', { 'data-pdf-page': '1' }))
  }
  try {
    await act(async () => root.render(createElement(ReaderHarness, { pages: unavailable })))
    const reader = dom.document.querySelector<HTMLElement>('[data-backend]')!
    const element = dom.document.querySelector<HTMLElement>('[data-pdf-page]')!
    element.getBoundingClientRect = () => new dom.DOMRect(0, 0, 100, 100)
    views.current.set(1, { element, viewport, page: {} as PageView['page'] })
    const press = (key: string, shiftKey = false) => act(async () => {
      reader.dispatchEvent(new dom.KeyboardEvent('keydown', { bubbles: true, key, shiftKey }))
    })
    await press('End', true)
    assert.equal(reader.dataset.backend, 'browser')
    assert.equal(commits.length, 1)
    assert.equal(commits[0], null)
    assert.deepEqual(errors, [], 'geometry failures leave text to the browser layer')

    await act(async () => root.render(createElement(ReaderHarness, { pages: available })))
    assert.equal(reader.dataset.backend, 'native')
    await press('End', true)
    assert.equal(commits.at(-1)?.text, 'A')
    await press('ArrowLeft')
    assert.equal(commits.at(-1), null)
    await press('ArrowRight', true)
    assert.equal(commits.at(-1)?.text, 'A', 'extension resumes from the collapsed caret')

    const keyboardFailure = new Error('Could not stage the keyboard selection')
    failCommit = keyboardFailure
    await press('ArrowLeft', true)
    assert.deepEqual(errors, [keyboardFailure])
    const pointerFailure = new Error('Could not stage the pointer selection')
    failCommit = pointerFailure
    await act(async () => {
      for (const type of ['pointerdown', 'pointerup']) {
        element.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, pointerId: 1,
          pointerType: 'mouse', button: 0, clientX: 11, clientY: 85 }))
      }
    })
    assert.deepEqual(errors, [keyboardFailure, pointerFailure])
    failCommit = undefined
    await press('End', true)
    assert.equal(commits.at(-1)?.text, 'A')
  } finally {
    await act(async () => root.unmount())
    lifetime.abort()
    restore()
  }
})
