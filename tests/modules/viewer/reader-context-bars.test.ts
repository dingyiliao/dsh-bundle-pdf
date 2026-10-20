import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfAnnotation } from '../../../src/core/pdf-types.ts'
import type { ReaderSelection } from '../../../src/modules/viewer/model/reader-selection.ts'
import {
  ReaderAnnotationBar, ReaderSelectionBar,
  type ReaderAnnotationBarProps, type ReaderSelectionBarProps,
} from '../../../src/modules/viewer/components/ReaderContextBars.tsx'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

async function withBars(run: (fixture: {
  container: HTMLElement
  render(node: React.ReactNode): Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root" class="dsh-pdf-reader"></div></body></html>',
    { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const container = dom.document.getElementById('root')!
  const root = createRoot(container)
  const render = async (node: React.ReactNode) => { await act(async () => root.render(node)) }
  try { await run({ container, render }) }
  finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

const selection: ReaderSelection = {
  revision: 1, text: 'Example', kind: 'text',
  fragments: [{ page: 3, rect: [10, 20, 30, 40], quadPoints: [10, 20, 30, 20, 10, 40, 30, 40] }],
}

test('live selection actions preserve copy, explain, marks and note coordinates', async () => {
  await withBars(async ({ container, render }) => {
    const actions: string[] = []
    const props: ReaderSelectionBarProps = {
      viewport: null, getAnchor: () => null, active: true, selection,
      textCopied: false, canExplain: true, explanationSending: false, editable: true,
      color: '#ffff00', setColor: color => actions.push(`color:${color}`),
      copyText: () => actions.push('copy'), explain: value => actions.push(`explain:${value?.text}`),
      translate: () => actions.push('translate'), mark: (subtype, color) => actions.push(`mark:${subtype}:${color ?? ''}`),
      beginNote: (page, point) => actions.push(`note:${page}:${point.join(',')}`),
      clearSelection: () => actions.push('clear'), t: key => key,
    }
    await render(React.createElement(ReaderSelectionBar, props))
    const click = async (label: string) => {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
      assert.ok(button, label)
      await act(async () => button.click())
    }
    await click('reader.copyText')
    await click('reader.explain.askQuestion')
    await click('reader.translateSelection')
    await click('reader.highlight')
    await click('reader.underline')
    await click('reader.strike')
    await click('reader.note')
    await click('reader.clearSelection')
    assert.deepEqual(actions, [
      'copy', 'explain:Example', 'translate', 'color:#ffff00', 'mark:Highlight:#ffff00',
      'mark:Underline:', 'mark:StrikeOut:', 'note:3:10,40', 'clear', 'clear',
    ])
  })
})

test('existing annotation actions respect editability and comment access', async () => {
  await withBars(async ({ container, render }) => {
    const actions: string[] = []
    const selected = { id: 'mark', page: 4, subtype: 'Highlight', supported: true,
      editable: true, color: [1, 1, 0] } as PdfAnnotation
    const props: ReaderAnnotationBarProps = {
      viewport: null, getAnchor: () => null, selected, commentActionAvailable: true,
      commentColor: '#ffff00', readOnly: false, editable: true,
      updateColor: value => actions.push(`color:${value}`),
      openCommentEditor: () => actions.push('comment'), deleteAnnotation: () => actions.push('delete'),
      clearAnnotation: () => actions.push('clear'), t: key => key,
    }
    await render(React.createElement(ReaderAnnotationBar, props))
    assert.match(container.textContent ?? '', /reader.type.Highlight/)
    for (const label of ['reader.commentText', 'reader.delete', 'reader.deselectAnnotation']) {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
      assert.ok(button, label)
      await act(async () => button.click())
    }
    assert.deepEqual(actions, ['comment', 'delete', 'clear'])
    await render(React.createElement(ReaderAnnotationBar, { ...props, editable: false }))
    assert.equal(container.querySelector<HTMLButtonElement>('button[aria-label="reader.delete"]')?.disabled, true)
    await render(React.createElement(ReaderAnnotationBar, { ...props, commentActionAvailable: false }))
    assert.equal(container.querySelector<HTMLButtonElement>('button[aria-label="reader.commentText"]')?.disabled, true)
    await render(React.createElement(ReaderAnnotationBar, { ...props, selected: undefined }))
    assert.equal(container.querySelector('[role="toolbar"]'), null)
  })
})
