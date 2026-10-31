import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DocumentIndexSettings } from '../../../src/modules/viewer/components/DocumentIndexSettings.tsx'
import { readerLocales } from '../../../src/modules/viewer/locales.ts'
import type { PdfDocumentIndexPolicy } from '../../../src/contracts/indexing.ts'
import type { ReaderIndexingControl } from '../../../src/modules/viewer/controllers/use-reader-indexing.tsx'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const defaults: PdfDocumentIndexPolicy = { indexScanPages: false, indexImageDescriptions: false }
const scanLabel = 'Recognize scanned or damaged text', imageLabel = 'Include image descriptions'
const t = (key: string) => readerLocales.en[key] ?? key
interface Pending {
  kind: 'configure' | 'defaults'
  policy?: PdfDocumentIndexPolicy
  resolve(accepted: boolean): void
  reject(error: unknown): void
}

async function withSettings(run: (fixture: {
  container: HTMLElement
  pending: Pending[]
  calls: Array<{ kind: Pending['kind']; policy?: PdfDocumentIndexPolicy }>
  control: () => ReaderIndexingControl
  makeControl(identity: string, policy?: PdfDocumentIndexPolicy): ReaderIndexingControl
  render(control?: ReaderIndexingControl): Promise<void>
  button(label: string): HTMLButtonElement
  toggle(label: string): HTMLInputElement
  click(element: HTMLElement): Promise<void>
  accept(policy: PdfDocumentIndexPolicy): Promise<void>
  work: { starts: number; rebuilds: number }
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
    Element: dom.Element, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const container = dom.document.getElementById('root')!, root = createRoot(container)
  const pending: Pending[] = [], calls: Array<{ kind: Pending['kind']; policy?: PdfDocumentIndexPolicy }> = []
  const work = { starts: 0, rebuilds: 0 }
  const request = (kind: Pending['kind'], policy?: PdfDocumentIndexPolicy) => {
    calls.push({ kind, ...(policy ? { policy: structuredClone(policy) } : {}) })
    return new Promise<boolean>((resolve, reject) => { pending.push({ kind, policy, resolve, reject }) })
  }
  const makeControl = (identity: string, policy = defaults): ReaderIndexingControl => ({
    enabled: true, disabled: false, label: 'Update index', statusLabel: 'Index ready',
    onStart() { work.starts++ }, onRebuild() { work.rebuilds++ },
    configuration: { identity, disabled: false, saving: false,
      value: { documentId: identity, revision: 7, policy, activePolicy: policy,
        enabled: true, activeEnabled: true, pending: false, impact: 'none' },
      configure: policy => request('configure', policy), useDefaults: () => request('defaults') },
  })
  let control = makeControl('session:document')
  const render = async (next = control) => {
    control = next
    await act(async () => root.render(React.createElement(DocumentIndexSettings, {
      key: control.configuration?.identity ?? 'legacy', control, t,
    })))
  }
  const button = (label: string) => {
    const element = [...container.querySelectorAll('button')].find(button => button.textContent === label)
    assert.ok(element, `${label} button must be rendered`)
    return element
  }
  const toggle = (label: string) => {
    const element = [...container.querySelectorAll<HTMLLabelElement>('.dsh-pdf-index-toggle')]
      .find(item => item.textContent === label)?.querySelector('input')
    assert.ok(element, `${label} checkbox must be rendered`)
    return element
  }
  const click = async (element: HTMLElement) => { await act(async () => { element.click() }) }
  try {
    await render()
    await run({ container, pending, calls, control: () => control, makeControl, render, button, toggle, click, work,
      async accept(policy) {
        const operation = pending.shift()!
        assert.ok(operation, 'there must be a real pending settings request')
        const configuration = control.configuration!
        await render({ ...control, configuration: { ...configuration, value: { ...configuration.value,
          revision: configuration.value.revision + 1, policy, pending: true, impact: 'content' } } })
        await act(async () => { operation.resolve(true) })
      },
    })
  } finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('the PDF sidebar contains only two independent content switches and never chooses or configures engines', async () => {
  await withSettings(async f => {
    assert.equal(f.container.querySelectorAll('input[type="checkbox"]').length, 2)
    assert.equal(f.container.querySelector('select,input:not([type="checkbox"]),textarea'), null)
    assert.doesNotMatch(f.container.textContent ?? '', /Embedding engine|OCR engine|Image understanding engine|endpoint|API key|Provider|Model/)
    await f.click(f.toggle(scanLabel))
    const scanned = { ...defaults, indexScanPages: true }
    assert.deepEqual(f.calls, [{ kind: 'configure', policy: scanned }])
    assert.equal(f.button('Update index').disabled, true)
    await f.accept(scanned)
    await f.click(f.toggle(imageLabel))
    const visual = { ...scanned, indexImageDescriptions: true }
    assert.deepEqual(f.calls.at(-1), { kind: 'configure', policy: visual })
    await f.accept(visual)
    await f.click(f.toggle(scanLabel))
    assert.equal(f.toggle(imageLabel).checked, true, 'the image switch remains independent of OCR')
    await f.accept({ ...visual, indexScanPages: false })
    assert.equal(f.container.querySelector('select'), null, 'enabling either content source never reveals an engine selector')
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 }, 'saving switches must not start model work')
    await f.click(f.button('Update index'))
    await f.click(f.button('Recompute entire index'))
    assert.deepEqual(f.work, { starts: 1, rebuilds: 1 })
  })
})

test('a failed content choice retains its value and retries the exact two-flag policy', async () => {
  await withSettings(async f => {
    await f.click(f.toggle(scanLabel))
    await act(async () => { f.pending.shift()!.reject(new Error('Index settings changed')) })
    assert.equal(f.toggle(scanLabel).checked, true)
    assert.match(f.container.querySelector('[role="alert"]')!.textContent ?? '', /Index settings changed/)
    assert.match(f.container.textContent ?? '', /Settings could not be saved/)
    assert.equal(f.button('Update index').disabled, true)
    assert.equal(f.button('Recompute entire index').disabled, true)
    await f.click(f.button('Retry saving'))
    assert.deepEqual(f.calls[1], f.calls[0])
    await f.accept({ ...defaults, indexScanPages: true })
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    assert.equal(f.button('Update index').disabled, false)
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 })
  })
})

test('retry merges the changed switch with an unrelated mirror-view change', async () => {
  await withSettings(async f => {
    await f.click(f.toggle(scanLabel))
    await act(async () => { f.pending.shift()!.reject(new Error('settings revision changed')) })
    const control = f.control(), configuration = control.configuration!
    const mirrored = { ...defaults, indexImageDescriptions: true }
    await f.render({ ...control, configuration: { ...configuration, value: { ...configuration.value,
      revision: configuration.value.revision + 1, policy: mirrored } } })
    assert.equal(f.toggle(scanLabel).checked, true)
    assert.equal(f.toggle(imageLabel).checked, true)
    await f.click(f.button('Retry saving'))
    const merged = { ...mirrored, indexScanPages: true }
    assert.deepEqual(f.calls[1], { kind: 'configure', policy: merged })
    await f.accept(merged)
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 })
  })
})

test('an older acknowledgement cannot clear a newer content choice', async () => {
  await withSettings(async f => {
    await f.click(f.toggle(scanLabel))
    await f.click(f.toggle(imageLabel))
    await act(async () => { f.pending.shift()!.resolve(true) })
    assert.equal(f.toggle(scanLabel).checked, true)
    assert.equal(f.toggle(imageLabel).checked, true)
    assert.equal(f.button('Update index').disabled, true)
    await f.accept({ indexScanPages: true, indexImageDescriptions: true })
    assert.equal(f.button('Update index').disabled, false)
  })
})

test('defaults remain Host-owned and can be retried after failure', async () => {
  await withSettings(async f => {
    await f.render(f.makeControl('session:document', { indexScanPages: true, indexImageDescriptions: true }))
    await f.click(f.button('Use current defaults'))
    assert.deepEqual(f.calls, [{ kind: 'defaults' }])
    assert.equal(f.toggle(scanLabel).checked, true)
    await act(async () => { f.pending.shift()!.reject('Defaults were changed') })
    assert.match(f.container.querySelector('[role="alert"]')!.textContent ?? '', /Defaults were changed/)
    await f.click(f.button('Retry saving'))
    assert.deepEqual(f.calls, [{ kind: 'defaults' }, { kind: 'defaults' }])
    await f.accept(defaults)
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    assert.equal(f.toggle(scanLabel).checked, false)
    assert.equal(f.toggle(imageLabel).checked, false)
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 })
  })
})

test('an unaccepted save remains retryable instead of leaving a permanently pending local switch', async () => {
  await withSettings(async f => {
    await f.click(f.toggle(imageLabel))
    await act(async () => { f.pending.shift()!.resolve(false) })
    assert.equal(f.toggle(imageLabel).checked, true)
    assert.match(f.container.querySelector('[role="alert"]')!.textContent ?? '', /Settings could not be saved/)
    await f.click(f.button('Retry saving'))
    assert.deepEqual(f.calls[1], f.calls[0])
    await f.accept({ ...defaults, indexImageDescriptions: true })
    assert.equal(f.container.querySelector('[role="alert"]'), null)
  })
})

test('global engine disable leaves document content choices editable but hides model-work commands', async () => {
  await withSettings(async f => {
    const control = f.control(), configuration = control.configuration!
    await f.render({ ...control, enabled: false, disabled: true, configuration: { ...configuration,
      value: { ...configuration.value, enabled: false, activeEnabled: false, pending: true, impact: 'embedding' } } })
    assert.equal(f.container.querySelector('select'), null)
    assert.equal(f.toggle(scanLabel).disabled, false)
    assert.equal(f.toggle(imageLabel).disabled, false)
    assert.equal([...f.container.querySelectorAll('button')].some(button => /Update index|Recompute/.test(button.textContent ?? '')), false)
    assert.equal(f.container.querySelector('.dsh-pdf-index-impact'), null)
    assert.doesNotMatch(f.container.textContent ?? '', /existing index is still using its previous settings|Update to encode/)
    assert.match(f.container.textContent ?? '', /Settings saved/)
    assert.match(f.container.textContent ?? '', /Engines are configured in PDF Settings/)
    await f.click(f.toggle(scanLabel))
    assert.deepEqual(f.calls, [{ kind: 'configure', policy: { ...defaults, indexScanPages: true } }])
    await f.accept({ ...defaults, indexScanPages: true })
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 })
  })
})

test('pending impact messages, disabled state, disclosure and legacy controls remain accurate', async () => {
  await withSettings(async f => {
    const impacts = {
      content: 'Update to apply the content choices. Reusable text and recognition results are retained.',
      embedding: 'Update to encode passages with the selected model. Extracted page content is retained.',
      configuration: 'Engine configuration has changed. Update to apply it; reusable results are retained.',
    } as const
    for (const impact of ['content', 'embedding', 'configuration'] as const) {
      const control = f.control(), configuration = control.configuration!
      await f.render({ ...control, configuration: { ...configuration, value: { ...configuration.value, pending: true, impact } } })
      assert.equal(f.container.querySelector('.dsh-pdf-index-impact')!.textContent, impacts[impact])
      assert.match(f.container.textContent ?? '', /existing index is still using its previous settings/)
    }
    const control = f.control(), configuration = control.configuration!
    await f.render({ ...control, disabled: true, configuration: { ...configuration, saving: true } })
    assert.match(f.container.textContent ?? '', /Saving settings/)
    assert.ok([...f.container.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')].every(element => element.disabled))
    await f.click(f.button('Use current defaults'))
    assert.equal(f.calls.length, 0)
    await f.render({ ...control, disabled: true, configuration: { ...configuration, disabled: true } })
    assert.equal(f.toggle(scanLabel).disabled, true)
    await f.render(f.makeControl('session:document'))
    const details = f.container.querySelector('details')!
    await f.click(details.querySelector('summary')!)
    assert.equal(details.open, false)
    await f.render({ ...f.control(), statusLabel: 'Index running' })
    assert.equal(details.open, false)
    const { configuration: _configuration, ...legacy } = f.control()
    await f.render(legacy)
    assert.equal(f.container.querySelector('select,input'), null)
    await f.click(f.button('Update index'))
    assert.equal(f.work.starts, 1)
  })
})

for (const late of ['accepted', 'rejected', 'unaccepted'] as const) test(`a different PDF ignores the previous PDF's late ${late} switch save`, async () => {
  await withSettings(async f => {
    await f.click(f.toggle(scanLabel))
    const previous = f.pending.shift()!
    await f.render(f.makeControl('another-session:another-document'))
    await act(async () => { if (late === 'rejected') previous.reject(new Error('old failure')); else previous.resolve(late === 'accepted') })
    assert.equal(f.toggle(scanLabel).checked, false)
    assert.equal(f.toggle(imageLabel).checked, false)
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 })
  })
})
