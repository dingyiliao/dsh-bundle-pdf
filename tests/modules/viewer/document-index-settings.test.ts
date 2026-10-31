import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DocumentIndexSettings } from '../../../src/modules/viewer/components/DocumentIndexSettings.tsx'
import { readerLocales } from '../../../src/modules/viewer/locales.ts'
import type { PdfDocumentIndexPolicy } from '../../../src/contracts/indexing.ts'
import type { EngineCatalogSnapshot, EngineDescriptor } from '../../../src/modules/engines/index.ts'
import type { ReaderIndexingControl } from '../../../src/modules/viewer/controllers/use-reader-indexing.tsx'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const defaults: PdfDocumentIndexPolicy = { embeddingEngine: 'embedding-main', ocrEngine: 'ocr-main',
  imageEngine: 'image-main', indexScanPages: false, indexImageDescriptions: false }
const descriptor = (id: string, capabilities?: EngineDescriptor['capabilities']): EngineDescriptor => ({
  id, name: id, version: '1', execution: 'service', capabilities,
  configurationFields: [{ key: 'endpoint', label: 'Server endpoint', type: 'string' },
    { key: 'apiKey', label: 'API key', type: 'secret-reference' }],
})
const initialCatalog: EngineCatalogSnapshot = { revision: 'catalog-1', engines: {
  embedding: [descriptor('embedding-main'), descriptor('embedding-next')],
  ocr: [descriptor('ocr-main', ['ocr-text']), descriptor('ocr-next', ['ocr-text']),
    descriptor('ocr-without-capability'), descriptor('ocr-image-only', ['image-description'])],
  image: [descriptor('image-main', ['image-description']), descriptor('image-next', ['image-description']),
    descriptor('image-without-capability'), descriptor('image-ocr-only', ['ocr-text'])],
  translation: [],
} }
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
  render(control?: ReaderIndexingControl, catalog?: EngineCatalogSnapshot): Promise<void>
  select(field: 'embeddingEngine' | 'ocrEngine' | 'imageEngine'): HTMLSelectElement
  button(label: string): HTMLButtonElement
  toggle(label: string): HTMLInputElement
  change(field: 'embeddingEngine' | 'ocrEngine' | 'imageEngine', value: string): Promise<void>
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
  const container = dom.document.getElementById('root')!
  const root = createRoot(container)
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
      value: { documentId: identity, revision: 7, policy, activePolicy: policy, pending: false, impact: 'none' },
      configure: policy => request('configure', policy), useDefaults: () => request('defaults') },
  })
  let control = makeControl('session:document'), catalog = initialCatalog
  const render = async (next = control, engines = catalog) => {
    control = next; catalog = engines
    await act(async () => root.render(React.createElement(DocumentIndexSettings, {
      key: control.configuration?.identity ?? 'legacy', control, catalog, t,
    })))
  }
  const select = (field: 'embeddingEngine' | 'ocrEngine' | 'imageEngine') => {
    const element = container.querySelector<HTMLSelectElement>(`select[id$="-${field}"]`)
    assert.ok(element, `${field} selector must be rendered`)
    assert.ok(element.labels?.length, 'the engine selector must have an associated visible label')
    return element
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
    await run({ container, pending, calls, control: () => control, makeControl, render, select, button, toggle, click, work,
      async change(field, value) {
        await act(async () => { const element = select(field); element.value = value; element.dispatchEvent(new dom.Event('change', { bubbles: true })) })
      },
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

test('document engine choices save immediately while index processing remains an explicit command', async () => {
  await withSettings(async f => {
    await f.change('embeddingEngine', 'embedding-next')
    const embedding = { ...defaults, embeddingEngine: 'embedding-next' }
    assert.deepEqual(f.calls, [{ kind: 'configure', policy: embedding }])
    assert.equal(f.select('embeddingEngine').value, 'embedding-next')
    assert.equal(f.button('Update index').disabled, true, 'indexing cannot start with an unacknowledged local choice')
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 })
    await f.accept(embedding)
    assert.equal(f.button('Update index').disabled, false)

    await f.click(f.toggle('Recognize scanned or damaged text'))
    const scanned = { ...embedding, indexScanPages: true }
    assert.deepEqual(f.calls.at(-1), { kind: 'configure', policy: scanned })
    assert.equal(f.select('ocrEngine').value, defaults.ocrEngine)
    await f.accept(scanned)
    await f.change('ocrEngine', 'ocr-next')
    const recognized = { ...scanned, ocrEngine: 'ocr-next' }
    assert.deepEqual(f.calls.at(-1), { kind: 'configure', policy: recognized })
    await f.accept(recognized)
    await f.click(f.toggle('Include image descriptions'))
    const visual = { ...recognized, indexImageDescriptions: true }
    assert.deepEqual(f.calls.at(-1), { kind: 'configure', policy: visual })
    await f.accept(visual)
    await f.change('imageEngine', 'image-next')
    const selected = { ...visual, imageEngine: 'image-next' }
    assert.deepEqual(f.calls.at(-1), { kind: 'configure', policy: selected })
    await f.accept(selected)
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 }, 'saving document policy must not start or rebuild an index')
    await f.click(f.button('Update index'))
    await f.click(f.button('Recompute entire index'))
    assert.deepEqual(f.work, { starts: 1, rebuilds: 1 })
  })
})

test('a failed document choice remains visible and retries that exact policy without starting the index', async () => {
  await withSettings(async f => {
    await f.change('embeddingEngine', 'embedding-next')
    await act(async () => { f.pending.shift()!.reject(new Error('Engine configuration changed')) })
    assert.equal(f.select('embeddingEngine').value, 'embedding-next')
    assert.match(f.container.querySelector('[role="alert"]')!.textContent ?? '', /Engine configuration changed/)
    assert.match(f.container.textContent ?? '', /Settings could not be saved/)
    assert.equal(f.button('Update index').disabled, true)
    assert.equal(f.button('Recompute entire index').disabled, true)
    await f.click(f.button('Retry saving'))
    assert.deepEqual(f.calls[1], f.calls[0])
    const accepted = { ...defaults, embeddingEngine: 'embedding-next' }
    await f.accept(accepted)
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    assert.equal(f.select('embeddingEngine').value, 'embedding-next')
    assert.equal(f.button('Update index').disabled, false)
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 })
  })
})

test('retry merges a local choice with unrelated policy changes accepted from a mirror view', async () => {
  await withSettings(async f => {
    await f.change('embeddingEngine', 'embedding-next')
    await act(async () => { f.pending[0]!.reject(new Error('settings revision changed')) })
    const control = f.control(), configuration = control.configuration!
    const mirrored = { ...defaults, indexScanPages: true, indexImageDescriptions: true, imageEngine: 'image-next' }
    await f.render({ ...control, configuration: { ...configuration, value: { ...configuration.value,
      revision: configuration.value.revision + 1, policy: mirrored } } })
    assert.equal(f.select('embeddingEngine').value, 'embedding-next', 'the local failed edit remains visible')
    assert.equal(f.toggle('Recognize scanned or damaged text').checked, true)
    assert.equal(f.toggle('Include image descriptions').checked, true)
    assert.equal(f.select('imageEngine').value, 'image-next', 'untouched fields follow the newly accepted Host state')
    await f.click(f.button('Retry saving'))
    const merged = { ...mirrored, embeddingEngine: 'embedding-next' }
    assert.deepEqual(f.calls[1], { kind: 'configure', policy: merged }, 'retry cannot overwrite unrelated edits from another view')
    await f.accept(merged)
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    assert.equal(f.select('embeddingEngine').value, 'embedding-next')
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 })
  })
})

test('an older save acknowledgement cannot clear a newer document choice', async () => {
  await withSettings(async f => {
    await f.change('embeddingEngine', 'embedding-next')
    await f.click(f.toggle('Recognize scanned or damaged text'))
    const earlier = f.pending.shift()!
    await act(async () => { earlier.resolve(true) })
    assert.equal(f.select('embeddingEngine').value, 'embedding-next')
    assert.equal(f.toggle('Recognize scanned or damaged text').checked, true)
    assert.equal(f.button('Update index').disabled, true, 'the latest request still needs its own acknowledgement')
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    await f.accept({ ...defaults, embeddingEngine: 'embedding-next', indexScanPages: true })
    assert.equal(f.button('Update index').disabled, false)
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 })
  })
})

test('restoring defaults retries the defaults operation and adopts only the acknowledged Host policy', async () => {
  await withSettings(async f => {
    const custom = { ...defaults, embeddingEngine: 'embedding-next', indexScanPages: true }
    await f.render(f.makeControl('session:document', custom))
    await f.click(f.button('Use current defaults'))
    assert.deepEqual(f.calls, [{ kind: 'defaults' }])
    assert.equal(f.select('embeddingEngine').value, 'embedding-next', 'pending defaults are not invented on the Client')
    await act(async () => { f.pending.shift()!.reject('Defaults were changed') })
    assert.match(f.container.querySelector('[role="alert"]')!.textContent ?? '', /Defaults were changed/)
    await f.click(f.button('Retry saving'))
    assert.deepEqual(f.calls, [{ kind: 'defaults' }, { kind: 'defaults' }])
    await f.accept(defaults)
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    assert.equal(f.select('embeddingEngine').value, defaults.embeddingEngine)
    assert.equal(f.toggle('Recognize scanned or damaged text').checked, false)
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 })
  })
})

test('an unaccepted settings request remains retryable instead of leaving a permanently pending draft', async () => {
  await withSettings(async f => {
    await f.change('embeddingEngine', 'embedding-next')
    await act(async () => { f.pending.shift()!.resolve(false) })
    assert.equal(f.select('embeddingEngine').value, 'embedding-next')
    assert.match(f.container.querySelector('[role="alert"]')!.textContent ?? '', /Settings could not be saved/)
    assert.equal(f.button('Update index').disabled, true)
    await f.click(f.button('Retry saving'))
    assert.deepEqual(f.calls[1], f.calls[0])
    await f.accept({ ...defaults, embeddingEngine: 'embedding-next' })
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    assert.equal(f.button('Update index').disabled, false)
  })
})

test('engine options update on plugin load and unload with capability filtering and no connection configuration', async () => {
  await withSettings(async f => {
    const policy = { ...defaults, indexScanPages: true, indexImageDescriptions: true }
    await f.render(f.makeControl('session:document', policy))
    assert.deepEqual([...f.select('ocrEngine').options].map(option => option.value), ['ocr-main', 'ocr-next'])
    assert.deepEqual([...f.select('imageEngine').options].map(option => option.value), ['image-main', 'image-next'])
    assert.equal(f.container.querySelector('input:not([type="checkbox"]),textarea'), null)
    assert.doesNotMatch(f.container.textContent ?? '', /Server endpoint|API key/)
    const unloaded: EngineCatalogSnapshot = { revision: 'unloaded', engines: {
      ...initialCatalog.engines, embedding: [descriptor('embedding-next')],
      ocr: [descriptor('ocr-next', ['ocr-text'])], image: [descriptor('image-next', ['image-description'])],
    } }
    await f.render(f.control(), unloaded)
    for (const field of ['embeddingEngine', 'ocrEngine', 'imageEngine'] as const) {
      assert.equal(f.select(field).value, policy[field])
      const selected = f.select(field).selectedOptions[0]!
      assert.equal(selected.disabled, true)
      assert.equal(selected.textContent, `Unavailable: ${policy[field]}`)
    }
    assert.equal(f.calls.length, 0, 'unloading engines cannot silently fall back or save another selection')
    await f.render(f.control(), initialCatalog)
    assert.equal(f.select('ocrEngine').selectedOptions[0]!.disabled, false)
    assert.equal(f.select('imageEngine').selectedOptions[0]!.disabled, false)
    assert.equal(f.calls.length, 0)
    await f.click(f.toggle('Recognize scanned or damaged text'))
    assert.equal(f.container.querySelector('select[id$="-ocrEngine"]'), null)
    assert.equal(f.select('imageEngine').value, policy.imageEngine, 'OCR and image description switches remain independent')
    assert.deepEqual(f.calls.at(-1)?.policy, { ...policy, indexScanPages: false })
    await f.accept({ ...policy, indexScanPages: false })
  })
})

test('pending impact explanations, saving locks, disclosure state and legacy controls remain accurate', async () => {
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
    assert.ok([...f.container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')]
      .every(element => element.disabled))
    await f.click(f.button('Use current defaults'))
    assert.deepEqual(f.calls, [])
    await f.render({ ...control, disabled: true, configuration: { ...configuration, disabled: true } })
    assert.equal(f.select('embeddingEngine').disabled, true)
    await f.change('embeddingEngine', 'embedding-next')
    assert.deepEqual(f.calls, [], 'even a synthetic change cannot bypass the current disabled configuration')
    await f.render(f.makeControl('session:document'))
    assert.match(f.container.textContent ?? '', /Settings saved for this PDF/)
    const details = f.container.querySelector('details')!
    assert.equal(details.open, true)
    await f.click(details.querySelector('summary')!)
    assert.equal(details.open, false)
    await f.render({ ...f.control(), statusLabel: 'Index running' })
    assert.equal(details.open, false, 'Host progress updates must not reopen a user-collapsed group')
    const { configuration: _configuration, ...legacy } = f.control()
    await f.render(legacy)
    assert.equal(f.container.querySelector('select,input'), null)
    assert.doesNotMatch(f.container.textContent ?? '', /Use current defaults|Native PDF text/)
    await f.click(f.button('Update index'))
    assert.equal(f.work.starts, 1)
    await f.render({ ...legacy, enabled: false })
    assert.equal(f.container.querySelector('button'), null)
  })
})

for (const late of ['accepted', 'rejected', 'unaccepted'] as const) test(`an unmounted document's late ${late} settings reply cannot alter its replacement`, async () => {
  await withSettings(async f => {
    await f.change('embeddingEngine', 'embedding-next')
    const previous = f.pending.shift()!
    await f.render(f.makeControl('another-session:another-document'))
    if (late === 'rejected') await act(async () => { previous.reject(new Error('old document failure')) })
    else await act(async () => { previous.resolve(late === 'accepted') })
    assert.equal(f.select('embeddingEngine').value, defaults.embeddingEngine)
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    assert.equal(f.button('Update index').disabled, false)
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.work, { starts: 0, rebuilds: 0 })
  })
})
