import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { act } from 'react'
import { BackHistoryControl } from '../../../src/modules/viewer/components/BackHistoryControl.js'
import { readerLocales } from '../../../src/modules/viewer/index.js'
import type { NavigationHistorySnapshot } from '../../../src/shared/navigation-history.js'

async function withHistory(locale: 'en' | 'zh', run: (fixture: {
  container: HTMLElement
  backCalls: number[]
  destinations: [number, number][]
  render(history: NavigationHistorySnapshot, disabled?: boolean): Promise<void>
  open(): Promise<void>
}) => Promise<void>) {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root" class="dsh-pdf-reader"></div></body></html>', { globals: [] })

  installDom({ window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
    Element: dom.Element, Node: dom.Node, CustomEvent: dom.CustomEvent,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.getElementById('root')!, root = createRoot(container)
  const backCalls: number[] = [], destinations: [number, number][] = []
  const render = async (history: NavigationHistorySnapshot, disabled = false) => {
    await act(async () => { root.render(React.createElement(BackHistoryControl, {
      history, disabled, t: key => (readerLocales[locale] as Record<string, string>)[key] ?? key,
      onBack: () => { backCalls.push(1) }, onBackTo: (depth, revision) => { destinations.push([depth, revision]) },
    })) })
  }
  try { await run({ container, backCalls, destinations, render, async open() {
    await act(async () => { container.querySelector<HTMLButtonElement>('.dsh-pdf-split-action-trigger')!.click() })
  } }) }
  finally {
    await act(async () => { root.unmount() })
    restoreDom()

  }
}

const history: NavigationHistorySnapshot = { revision: 7, positions: [47, 47, 12].map((page, index) => ({
  documentVersion: 'source-v1', page, x: 0, y: index * 200, scale: 1, fit: 'width' as const,
})) }

for (const locale of ['en', 'zh'] as const) test(`back history names destinations naturally in ${locale} and preserves every reading position`, async () => {
  await withHistory(locale, async fixture => {
    await fixture.render(history)
    const main = fixture.container.querySelector<HTMLButtonElement>('.dsh-pdf-split-action-main')!
    const expected = locale === 'zh' ? '返回第 47 页' : 'Return to page 47'
    assert.equal(main.dataset.tooltip, expected)
    await fixture.open()
    const menu = fixture.container.querySelector('[data-testid="pdf-back-history"]')!
    assert.equal(menu.getAttribute('aria-label'), locale === 'zh' ? '返回位置' : 'Back history')
    const choices = [...menu.querySelectorAll<HTMLButtonElement>('.dsh-pdf-history-item')]
    assert.equal(choices.length, 3, 'different anchors on one page stay independently selectable')
    assert.deepEqual(choices.map(choice => choice.querySelector('span')!.textContent), locale === 'zh'
      ? ['第 47 页', '第 47 页', '第 12 页'] : ['Page 47', 'Page 47', 'Page 12'])
    assert.equal(choices[0]!.getAttribute('aria-label'), expected)
    assert.equal(menu.querySelectorAll('small').length, 1)
    assert.equal(choices[0]!.querySelector('small')!.textContent, locale === 'zh' ? '最近' : 'Most recent')
    assert.doesNotMatch(menu.textContent!, /次跳转前|jumps? back|页 47/)
    await act(async () => { choices[1]!.click() })
    assert.deepEqual(fixture.destinations, [[1, 7]], 'selection retains the exact depth and snapshot revision')
    assert.equal(fixture.container.querySelector('[data-testid="pdf-back-history"]'), null)
    await act(async () => { main.click() })
    assert.equal(fixture.backCalls.length, 1, 'the main action remains immediate Back')
  })
})

test('back history closes on navigation and both entry points stay disabled without a destination', async () => {
  await withHistory('en', async fixture => {
    await fixture.render(history)
    await fixture.open()
    await fixture.render(history, true)
    assert.equal(fixture.container.querySelector('[data-testid="pdf-back-history"]'), null)
    for (const button of fixture.container.querySelectorAll<HTMLButtonElement>('button')) {
      assert.equal(button.disabled, true)
      await act(async () => { button.click() })
    }
    await fixture.render({ revision: 8, positions: [] })
    const main = fixture.container.querySelector<HTMLButtonElement>('.dsh-pdf-split-action-main')!
    assert.equal(main.dataset.tooltip, 'Back')
    await fixture.open()
    assert.equal(fixture.container.querySelector('[data-testid="pdf-back-history"]'), null)
    assert.deepEqual(fixture.backCalls, [])
    assert.deepEqual(fixture.destinations, [])
  })
})
