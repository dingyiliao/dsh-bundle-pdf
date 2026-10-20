import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { captureTextSelection, type PageView } from '../../../src/modules/viewer/model/reader-selection.ts'

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

test('a selection inside one text node includes surrounding context and its actual page box', () => {
  const dom = new JSDOM('<!doctype html><div id="root"><div id="page"><div data-pdf-text="active"><span>hello world again</span></div></div></div>',
    { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, Node: dom.Node, NodeFilter: dom.NodeFilter })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  try {
    const container = dom.document.getElementById('root')!
    const page = dom.document.getElementById('page')!
    const text = page.querySelector('span')!.firstChild!
    const selected = dom.document.createRange()
    selected.setStart(text, 6)
    selected.setEnd(text, 11)
    dom.getSelection()!.addRange(selected)
    const createRange = dom.document.createRange.bind(dom.document)
    dom.document.createRange = () => {
      const piece = createRange()
      piece.getClientRects = () => ([
        { left: 10, top: 20, right: 35, bottom: 30, width: 25, height: 10 },
      ]) as unknown as DOMRectList
      return piece
    }
    page.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100,
      x: 0, y: 0, toJSON() {} })
    const view = { element: page, viewport: {
      width: 100, height: 100,
      convertToPdfPoint: (x: number, y: number) => [x, 100 - y],
    } } as unknown as PageView
    const result = captureTextSelection(container, new Map([[1, view]]), 7)
    assert.deepEqual(result, {
      revision: 7, kind: 'text', text: 'world',
      fragments: [{ page: 1, rect: [10, 70, 35, 80], quadPoints: [10, 80, 35, 80, 10, 70, 35, 70] }],
      selectionBefore: 'hello ', selectionAfter: ' again',
    })
  } finally {
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
