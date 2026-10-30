import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act, createRef } from 'react'
import { ReaderToolbar, type ReaderToolbarActions, type ReaderToolbarState } from '../../../src/modules/viewer/components/ReaderToolbar.tsx'
import type { ExplanationStatusBarProps } from '../../../src/modules/viewer/components/ExplanationStatusBar.tsx'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

const readyState: ReaderToolbarState = {
  hasDocument: true, canPromptExplanation: true, explanationActive: false, explanationSending: false,
  screenshotActive: false, screenshotPreparing: false, busy: false, editable: true, ocrBusy: false,
  ocrAvailability: { status: 'available' }, dirty: true, canUndo: true, canRedo: false, conflict: false,
  colorPending: false, saveAsPicking: false, hasUnappliedAnnotation: false, canGoBack: false,
  navigating: false, history: { revision: 0, positions: [] }, fit: 'width', zoom: 1,
}

async function withToolbar(run: (f: {
  container: HTMLElement; calls: string[]; menu: React.RefObject<HTMLDetailsElement>
  render(state?: Partial<ReaderToolbarState>, explanation?: ExplanationStatusBarProps): Promise<void>
  openMenu(): Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root" class="dsh-pdf-reader"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
    Element: dom.Element, Node: dom.Node, CustomEvent: dom.CustomEvent,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.getElementById('root')!, root = createRoot(container)
  const menu = createRef<HTMLDetailsElement>(), calls: string[] = []
  const record = (name: string) => () => { calls.push(name) }
  const actions: ReaderToolbarActions = { onOpenMenu: record('menu'), onToggleExplanation() {}, onScreenshot: record('screenshot'),
    onNote() {}, onOcr() {}, onReload: record('reload'), onSaveAs: record('save-as'),
    onDiscard: record('discard'), onUndo: record('undo'), onRedo: record('redo'), onSave: record('save'), onBack() {}, onBackTo() {}, onZoom() {} }
  const render = async (state: Partial<ReaderToolbarState> = {}, explanation?: ExplanationStatusBarProps) => {
    await act(async () => { root.render(React.createElement(ReaderToolbar, { t: key => key, menuRef: menu,
      state: { ...readyState, ...state }, explanation,
      actions })) })
  }
  try {
    await render()
    await run({ container, calls, menu, render, async openMenu() {
      await act(async () => {
        if (!menu.current!.open) menu.current!.querySelector<HTMLElement>('summary')!.click()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      assert.equal(menu.current!.open, true)
      assert.equal(container.querySelector<HTMLElement>('.dsh-pdf-tools-menu[aria-label="reader.fileMenu"]')!
        .closest<HTMLElement>('.dsh-pdf-disclosure-popover')!.hidden, false)
    } })
  } finally {
    await act(async () => { root.unmount() })
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

function command(container: HTMLElement, name: string, surface: 'direct' | 'menu') {
  const result = container.querySelector<HTMLButtonElement>(`[data-document-command="${name}"][data-command-surface="${surface}"]`)
  assert.ok(result, `${name} is available in the ${surface} command surface`)
  return result
}

test('expanded document icons and the compact menu invoke the same existing commands', async () => {
  await withToolbar(async f => {
    for (const name of ['save-as', 'reload', 'discard']) {
      const direct = command(f.container, name, 'direct')
      assert.ok(direct.getAttribute('aria-label'))
      assert.equal(direct.getAttribute('data-tooltip'), direct.getAttribute('aria-label'))
      assert.ok(direct.querySelector('svg[data-icon]'), 'the expanded command has an icon instead of an unlabeled slot')
      await act(async () => { direct.click() })
      assert.equal(f.calls.at(-1), name)
      await f.openMenu()
      await act(async () => { command(f.container, name, 'menu').click() })
      assert.equal(f.calls.at(-1), name)
    }
    assert.deepEqual(f.calls.filter(name => name !== 'menu'), ['save-as', 'save-as', 'reload', 'reload',
      'discard', 'discard'])
  })
})

test('both command surfaces preserve clean, staged, conflicting and write-locked document guards', async () => {
  await withToolbar(async f => {
    const cases: { state: Partial<ReaderToolbarState>; disabled: boolean[] }[] = [
      { state: { dirty: false }, disabled: [false, false, true] },
      { state: { dirty: false, formPending: true }, disabled: [false, false, false] },
      { state: { dirty: false, conflict: true }, disabled: [false, false, false] },
      { state: { hasUnappliedAnnotation: true }, disabled: [true, false, false] },
      { state: { editable: false, busy: true, colorPending: true },
        disabled: [true, true, true] },
      { state: { hasDocument: false, editable: false }, disabled: [true, true, true] },
    ]
    for (const { state, disabled } of cases) {
      await f.render(state)
      for (const surface of ['direct', 'menu'] as const) {
        assert.deepEqual(['save-as', 'reload', 'discard'].map(name => command(f.container, name, surface).disabled), disabled)
        for (const name of ['save-as', 'reload', 'discard']) {
          const button = command(f.container, name, surface)
          if (!button.disabled) continue
          const count = f.calls.length
          await act(async () => { button.click() })
          assert.equal(f.calls.length, count, `disabled ${surface} ${name} never executes`)
        }
      }
    }
  })
})

test('document controls leave indexing actions to search while retaining the shared task entry', async () => {
  await withToolbar(async f => {
    await f.openMenu()
    assert.equal(f.container.querySelector('[data-document-command="index"]'), null)
    assert.equal(f.container.querySelector('[data-icon="index"]'), null)
    assert.ok(f.container.querySelector('.dsh-pdf-activity-trigger'))
  })
})

test('save command presents document state without a persistent rail label or a second focus stop', async () => {
  await withToolbar(async f => {
    const save = () => f.container.querySelector<HTMLButtonElement>('.dsh-pdf-toolbar-save')!
    const wrapper = () => f.container.querySelector<HTMLElement>('.dsh-pdf-save-control')!
    const feedback = (kind: 'saved' | 'saving' | 'failed') => ({ kind, occurrence: 1, durationMs: kind === 'saved' ? 2000 : 0 })
    const cases: { state: Partial<ReaderToolbarState>; status: string; icon: string | null; label: string; disabled: boolean }[] = [
      { state: { dirty: false }, status: 'saved', icon: 'save', label: 'allChangesSaved', disabled: true },
      { state: { dirty: false, saveFeedback: feedback('saved') }, status: 'saved-success', icon: 'check', label: 'allChangesSaved', disabled: true },
      { state: { dirty: true, saveFeedback: feedback('saved') }, status: 'dirty', icon: 'save', label: 'unsaved', disabled: false },
      { state: { dirty: false, formPending: true }, status: 'dirty', icon: 'save', label: 'unsaved', disabled: false },
      { state: { saveFeedback: feedback('saving'), busy: true }, status: 'saving', icon: null, label: 'saving', disabled: true },
      { state: { saveFeedback: feedback('failed') }, status: 'failed', icon: 'warning', label: 'saveFailed', disabled: false },
      { state: { hasUnappliedAnnotation: true }, status: 'pending', icon: 'edit', label: 'pendingEditsHelp', disabled: true },
      { state: { conflict: true }, status: 'conflict', icon: 'warning', label: 'sourceChanged', disabled: false },
      { state: { readOnly: true, conflict: true }, status: 'read-only', icon: 'lock', label: 'readOnly', disabled: true },
      { state: { hasDocument: false, editable: false }, status: 'loading', icon: null, label: 'loading', disabled: true },
    ]
    for (const { state, status, icon, label, disabled } of cases) {
      await f.render(state)
      assert.equal(save().getAttribute('data-save-state'), status)
      assert.equal(save().disabled, disabled)
      assert.equal(save().getAttribute('aria-label'), 'reader.save', 'the command keeps its accessible name')
      assert.equal(wrapper().getAttribute('data-tooltip'), `reader.${label}`)
      assert.equal(save().getAttribute('data-tooltip'), disabled ? null : `reader.${label}`, 'an enabled button anchors its own keyboard tooltip')
      assert.equal(wrapper().getAttribute('tabindex'), disabled ? '0' : null, 'disabled state stays keyboard discoverable')
      assert.equal(save().querySelector('svg')?.getAttribute('data-icon') ?? null, icon)
      assert.equal(!!save().querySelector('.dsh-pdf-save-spinner'), icon === null)
      const description = f.container.querySelector(`[id="${save().getAttribute('aria-describedby')}"]`)!
      assert.equal(description.textContent, `reader.${label}`)
      assert.equal(description.getAttribute('role'), 'status')
      assert.equal(f.container.querySelector('.dsh-pdf-document-state'), null)
      const count = f.calls.length
      await act(async () => { save().click() })
      assert.equal(f.calls.length, count + (disabled ? 0 : 1))
      if (!disabled) assert.equal(f.calls.at(-1), 'save')
    }
  })
})

test('save locks conflicting writes without claiming success or changing the dirty glyph during other mutations', async () => {
  await withToolbar(async f => {
    for (const lock of [{ busy: true }, { colorPending: true }, { saveAsPicking: true }, { editable: false }]) {
      await f.render({ dirty: true, ...lock })
      const save = f.container.querySelector<HTMLButtonElement>('.dsh-pdf-toolbar-save')!
      assert.equal(save.disabled, true)
      assert.equal(save.dataset.saveState, 'dirty')
      assert.ok(save.hasAttribute('data-dirty'))
      assert.equal(save.querySelector('svg')?.getAttribute('data-icon'), 'save')
      const count = f.calls.length
      await act(async () => { save.click() })
      assert.equal(f.calls.length, count)
    }
  })
})

test('both history entry points share staged-form, redo and mutation guards', async () => {
  await withToolbar(async f => {
    const cases: { state: Partial<ReaderToolbarState>; disabled: boolean[] }[] = [
      { state: { canUndo: true, canRedo: true }, disabled: [false, false] },
      { state: { canUndo: false, canRedo: false }, disabled: [true, true] },
      { state: { canUndo: false, formPending: true, canRedo: false }, disabled: [false, true] },
      { state: { canUndo: true, canRedo: true, busy: true }, disabled: [true, true] },
      { state: { canUndo: true, canRedo: true, colorPending: true }, disabled: [true, true] },
    ]
    for (const { state, disabled } of cases) {
      await f.render(state)
      for (const surface of ['direct', 'menu'] as const) {
        assert.deepEqual(['undo', 'redo'].map(name => command(f.container, name, surface).disabled), disabled)
        for (const name of ['undo', 'redo']) {
          if (surface === 'menu') await f.openMenu()
          const button = command(f.container, name, surface), calls = f.calls.length
          await act(async () => { button.click() })
          if (button.disabled) assert.equal(f.calls.length, calls, `disabled ${surface} ${name} never executes`)
          else assert.equal(f.calls.at(-1), name)
        }
      }
    }
    assert.equal(f.container.querySelectorAll('.dsh-pdf-document-history-menu button').length, 2)
  })
})

test('the single material shell separates scrolling tools from fixed explanation controls', async () => {
  await withToolbar(async f => {
    const explanation: ExplanationStatusBarProps = {
      count: 2, max: 20, sending: false, disabled: false, error: '', imageAvailable: true,
      selectingArea: false, t: key => key, onSend() {}, onExit() {}, onSelectArea: () => { f.calls.push('area') },
    }
    await f.render({ explanationActive: true }, explanation)
    const rail = f.container.querySelector('[data-pdf-tool-rail]')!
    const shell = rail.firstElementChild!
    assert.ok(shell.classList.contains('dsh-pdf-tool-rail-shell'))
    assert.ok(shell.classList.contains('dsh-pdf-glass'))
    assert.deepEqual([...shell.children].map(group => group.getAttribute('data-tool-group')), ['navigation', 'interaction', 'document'])
    assert.equal([...shell.children].some(group => group.classList.contains('dsh-pdf-glass')), false)
    const tools = shell.querySelector('.dsh-pdf-tool-middle')!, fixed = shell.querySelector('.dsh-pdf-mode-control')!
    const area = tools.querySelector<HTMLButtonElement>('.dsh-pdf-explanation-status-area')!
    assert.ok(area.classList.contains('dsh-pdf-tool-screenshot'))
    assert.equal(tools.contains(fixed), false, 'scrolling the tool list cannot scroll away Send or Exit')
    assert.equal(fixed.querySelector('.dsh-pdf-explanation-status-area'), null, 'area capture has exactly one entry in the tools')
    assert.ok(fixed.querySelector('.dsh-pdf-explanation-status-send'))
    assert.ok(fixed.querySelector('.dsh-pdf-explanation-status-exit'))
    await act(async () => { area.click() })
    assert.equal(f.calls.at(-1), 'area', 'explanation capture does not invoke the ordinary screenshot command')
    assert.equal(f.calls.includes('screenshot'), false)

    for (const unavailable of [{ imageAvailable: false, imageReason: 'Vision unavailable' }, { sending: true }, { disabled: true }]) {
      await f.render({ explanationActive: true }, { ...explanation, ...unavailable })
      const guarded = tools.querySelector<HTMLButtonElement>('.dsh-pdf-explanation-status-area')!
      assert.equal(guarded.disabled, true)
      const count = f.calls.length
      await act(async () => { guarded.click() })
      assert.equal(f.calls.length, count)
    }
    await f.render({ explanationActive: true }, { ...explanation, selectingArea: true })
    const cancelling = tools.querySelector<HTMLButtonElement>('.dsh-pdf-explanation-status-area')!
    assert.equal(cancelling.getAttribute('aria-label'), 'reader.explain.cancelArea')
    assert.equal(cancelling.getAttribute('aria-pressed'), 'true')
    assert.equal(cancelling.disabled, false)
  })
})
