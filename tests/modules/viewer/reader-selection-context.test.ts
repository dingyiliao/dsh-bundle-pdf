import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { captureTextSelection, type PageView } from '../../../src/client/viewer/model/reader-selection.ts'

test('a selection inside one text node includes surrounding context and its actual page box', () => {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><div id="root"><div id="page"><div data-pdf-text="active"><span>hello world again</span></div></div></div>', { globals: [] })

  installDom({ window: dom, document: dom.document, Node: dom.Node, NodeFilter: dom.NodeFilter })
  try {
    const container = dom.document.getElementById('root')!
    const page = dom.document.getElementById('page')!
    const text = page.querySelector('span')!.firstChild!
    const selected = dom.document.createRange()
    selected.setStart(text, 6)
    selected.setEnd(text, 11)
    dom.getSelection()!.addRange(selected)
    const createRange = dom.document.createRange.bind(dom.document)
    let boxes = [
      { left: 10, top: 20, right: 35, bottom: 30, width: 25, height: 10 },
    ]
    dom.document.createRange = () => {
      const piece = createRange()
      piece.getClientRects = () => boxes as unknown as DOMRectList
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
    // A wrapped selection still needs one PDF quadrilateral per visual line.
    // Turning the three rows into one tall quad would create an opaque underline.
    boxes = [
      { left: 10, top: 20, right: 35, bottom: 30, width: 25, height: 10 },
      { left: 10, top: 32, right: 35, bottom: 42, width: 25, height: 10 },
      { left: 10, top: 44, right: 35, bottom: 54, width: 25, height: 10 },
    ]
    const wrapped = createRange()
    wrapped.selectNodeContents(text)
    dom.getSelection()!.removeAllRanges()
    dom.getSelection()!.addRange(wrapped)
    assert.deepEqual(captureTextSelection(container, new Map([[1, view]]), 8)?.fragments[0], {
      page: 1, rect: [10, 46, 35, 80],
      quadPoints: [10, 80, 35, 80, 10, 70, 35, 70,
        10, 68, 35, 68, 10, 58, 35, 58,
        10, 56, 35, 56, 10, 46, 35, 46],
    })
  } finally {
    restoreDom()

  }
})
