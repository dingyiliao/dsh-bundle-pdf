import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { TranslationPanel, type TranslationPanelProps } from '../../../src/modules/viewer/components/TranslationPanel.tsx'
import { TranslationError, translationEn, type TranslationRequest, type TranslationResult } from '../../../src/translation/index.ts'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const t = (key: string) => translationEn[key.replace(/^reader\./, '') as keyof typeof translationEn] ?? key
const result = (text = 'Translated'): TranslationResult => ({ text, status: 'complete', warnings: [],
  source: { engineId: 'fixture', engineVersion: '1', instanceId: 'test', configurationRevision: '1' } })

function assertOriginal(container: HTMLElement, text: string) {
  const originals = container.querySelectorAll<HTMLElement>('.dsh-pdf-translation-source')
  assert.equal(originals.length, 1, 'each selection has one stable original block')
  assert.equal(originals[0]!.hidden, false, 'the original is visible independently of the result')
  assert.equal(originals[0]!.querySelector('.dsh-pdf-translation-source-text')!.textContent, text)
  assert.equal(container.querySelector('.dsh-pdf-translation-term'), null, 'the lexical result does not repeat the original as a title')
}

async function withPanel(translate: TranslationPanelProps['translate'], run: (fixture: {
  container: HTMLElement; dom: Window & typeof globalThis; props: TranslationPanelProps;
  render(props: TranslationPanelProps): Promise<void>; button(text: string): HTMLButtonElement
}) => Promise<void>, sourceText = 'subtrac') {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const previous = new Map<string, PropertyDescriptor | undefined>()
  const values = { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, Element: dom.Element,
    HTMLElement: dom.HTMLElement, MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true }
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const container = dom.document.getElementById('root')!, root = createRoot(container)
  const props: TranslationPanelProps = { selection: { text: sourceText, pages: [1], targetLanguage: 'zh' },
    engineName: 'Fixture', translate, rememberTargetLanguage: async () => true, onClose() {}, t }
  const render = async (value: TranslationPanelProps) => { await act(async () => { root.render(React.createElement(TranslationPanel, value)) }) }
  try {
    await render(props)
    await run({ container, dom, props, render, button(text) {
      const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === text)
      assert.ok(button, `Missing button ${text}`)
      return button
    } })
  } finally {
    await act(async () => { root.unmount() })
    dom.close()
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('component presentation of supplied reconstruction preserves the original and copies its qualification', async () => {
  const interpreted: TranslationResult = { ...result('减去'), interpretation: { text: 'subtract', kind: 'completion',
    certainty: 'tentative', explanation: 'The final letter may have been omitted.' },
    detail: { kind: 'word', meanings: [{ partOfSpeech: 'verb', meaning: '减去', example: 'Subtract two.', exampleTranslation: '减去二。' }] } }
  await withPanel(async () => interpreted, async f => {
    assertOriginal(f.container, 'subtrac')
    assert.equal(f.container.querySelector('.dsh-pdf-translation-interpreted-text')!.textContent, 'subtract')
    assert.match(f.container.querySelector('[role="note"]')!.textContent ?? '', /Possible completion.*subtract.*final letter/)
    let copied = ''
    Object.defineProperty(f.dom.navigator, 'clipboard', { configurable: true,
      value: { async writeText(text: string) { copied = text } } })
    await act(async () => { f.button('Copy translation').click() })
    assert.equal(copied, 'Original: subtrac\nPossible completion: subtract\nThe final letter may have been omitted.\n\n减去')
    assert.equal(f.container.querySelector('.dsh-pdf-translation-source-text')!.textContent, 'subtrac')
  })
})

for (const kind of ['word', 'phrase', 'sentence'] as const) {
  test(`ordinary ${kind} translations show the exact original once without a duplicate lexical title`, async () => {
    const source = kind === 'word' ? 'gradient' : kind === 'phrase' ? 'gradient of y with respect to x,' : 'We wish to calculate the gradient.'
    const translated: TranslationResult = { ...result('模型给出的译文'), ...(kind === 'sentence' ? {} : {
      detail: { kind, ...(kind === 'word' ? { pronunciation: '/ˈɡreɪdiənt/' } : {}), meanings: [
        { partOfSpeech: kind === 'word' ? 'noun' : 'noun phrase', meaning: '梯度', example: 'Calculate a derivative.', exampleTranslation: '计算导数。' },
      ] },
    }) }
    await withPanel(async () => translated, async f => {
      assertOriginal(f.container, source)
      assert.equal(f.container.querySelector('[role="note"]'), null)
      if (kind === 'sentence') assert.equal(f.container.querySelector('.dsh-pdf-translation-text')!.textContent, translated.text)
      else {
        assert.match(f.container.querySelector('.dsh-pdf-translation-details')!.textContent ?? '', /梯度.*Calculate a derivative/)
        assert.equal(f.container.querySelector('.dsh-pdf-translation-kind')!.textContent, kind === 'word' ? 'Word' : 'Phrase')
      }
    }, source)
  })
}

test('a request failure offers retry, and changing language resends the exact source', async () => {
  const requests: TranslationRequest[] = []
  await withPanel(async request => {
    requests.push(request)
    if (requests.length <= 2) throw new TranslationError('invalid-model-output', 'Invalid response format')
    return result('Recovered meaning')
  }, async f => {
    assertOriginal(f.container, 'subtrac')
    assert.ok(f.button('Retry'))
    assert.equal(f.container.querySelector('.dsh-pdf-translation-reselect'), null)
    await act(async () => { f.button('Retry').click() })
    assertOriginal(f.container, 'subtrac')
    assert.equal(requests.length, 2)
    await act(async () => { f.button('French').click() })
    assert.deepEqual(requests.map(request => [request.text, request.targetLanguage]), [
      ['subtrac', 'zh'], ['subtrac', 'zh'], ['subtrac', 'fr'],
    ])
    assert.match(f.container.textContent ?? '', /Recovered meaning/)
    assertOriginal(f.container, 'subtrac')
    assert.equal(f.container.querySelector('[role="alert"]'), null)
  })
})

test('loading, failure, retry and cancellation never hide or replace the original', async () => {
  const pending: { request: TranslationRequest; resolve(value: TranslationResult): void; reject(error: Error): void }[] = []
  const source = '  The exact selected\nfragment,  '
  await withPanel(request => new Promise<TranslationResult>((resolve, reject) => {
    pending.push({ request, resolve, reject })
  }), async f => {
    assert.equal(pending.length, 1)
    assertOriginal(f.container, source)
    assert.match(f.container.querySelector('.dsh-pdf-translation-status')!.textContent ?? '', /Translating/)
    await act(async () => { pending[0]!.reject(new TranslationError('invalid-model-output', 'Controlled malformed response')) })
    assertOriginal(f.container, source)
    assert.ok(f.container.querySelector('[role="alert"]'))
    await act(async () => { f.button('Retry').click() })
    assertOriginal(f.container, source)
    assert.equal(pending.length, 2)
    await act(async () => { f.button('Cancel').click() })
    assert.equal(pending[1]!.request.signal!.aborted, true)
    assertOriginal(f.container, source)
    await act(async () => { pending[1]!.resolve({ ...result('Cancelled stale result'), interpretation: {
      kind: 'completion', certainty: 'tentative', text: 'Cancelled reconstruction', explanation: 'Must be ignored.',
    } }) })
    assert.equal(f.container.querySelector('[role="note"]'), null)
    assert.doesNotMatch(f.container.textContent ?? '', /Cancelled stale result|Cancelled reconstruction/)
    assert.match(f.container.querySelector('.dsh-pdf-translation-status')!.textContent ?? '', /Translation cancelled/)
    await act(async () => { f.button('Retry').click() })
    assertOriginal(f.container, source)
    await act(async () => { pending[2]!.resolve(result('Current translation')) })
    assertOriginal(f.container, source)
    assert.equal(f.container.querySelector('.dsh-pdf-translation-text')!.textContent, 'Current translation')
    assert.deepEqual(pending.map(item => item.request.text), [source, source, source])
  }, source)
})

test('component dispatch sends clauses and arbitrary short fragments unchanged on initial request and Retry (controlled responses)', async () => {
  for (const text of ['reduces a tensor', 'btracti', 'a', 'x??']) {
    const requests: TranslationRequest[] = []
    await withPanel(async request => {
      requests.push(request)
      if (requests.length === 1) throw new TranslationError('invalid-model-output', 'Controlled malformed response')
      return result('模型提供的翻译或解释')
    }, async f => {
      assert.equal(requests.length, 1)
      assert.equal(requests[0]!.text, text)
      await act(async () => { f.button('Retry').click() })
      assert.deepEqual(requests.map(request => request.text), [text, text])
      assert.match(f.container.textContent ?? '', /模型提供的翻译或解释/)
      assert.equal(f.container.querySelector('[role="alert"]'), null)
      assert.equal(f.container.querySelector('[role="note"]'), null)
    }, text)
  }
})

test('language changes cancel a pending reconstruction and ignore its late response', async () => {
  const requests: TranslationRequest[] = []
  let finish!: (value: TranslationResult) => void
  const delayed = new Promise<TranslationResult>(resolve => { finish = resolve })
  await withPanel(async request => {
    requests.push(request)
    return requests.length === 1 ? delayed : result('Current French result')
  }, async f => {
    assertOriginal(f.container, 'subtrac')
    await act(async () => { f.button('French').click() })
    assert.equal(requests[0]!.signal!.aborted, true)
    assert.match(f.container.textContent ?? '', /Current French result/)
    assertOriginal(f.container, 'subtrac')
    await act(async () => { finish({ ...result('Late incorrect result'), interpretation: { text: 'outdated guess',
      kind: 'completion', certainty: 'tentative', explanation: 'Stale reconstruction' } }) })
    assert.match(f.container.textContent ?? '', /Current French result/)
    assert.doesNotMatch(f.container.textContent ?? '', /Late incorrect result|outdated guess|Stale reconstruction/)
    assertOriginal(f.container, 'subtrac')
  })
})

test('a new selection replaces the original immediately and rejects a late previous interpretation', async () => {
  const pending: { request: TranslationRequest; resolve(value: TranslationResult): void }[] = []
  await withPanel(request => new Promise<TranslationResult>(resolve => { pending.push({ request, resolve }) }), async f => {
    assertOriginal(f.container, 'subtrac')
    const source = '  new\nselected text  '
    await f.render({ ...f.props, selection: { text: source, pages: [2], targetLanguage: 'zh' } })
    assert.equal(pending[0]!.request.signal!.aborted, true)
    assertOriginal(f.container, source)
    await act(async () => { pending[0]!.resolve({ ...result('Old translation'), interpretation: {
      kind: 'completion', certainty: 'tentative', text: 'Old reconstruction', explanation: 'Previous selection.',
    } }) })
    assertOriginal(f.container, source)
    assert.equal(f.container.querySelector('[role="note"]'), null)
    assert.doesNotMatch(f.container.textContent ?? '', /Old translation|Old reconstruction|Previous selection/)
    await act(async () => { pending[1]!.resolve(result('New translation')) })
    assertOriginal(f.container, source)
    assert.equal(f.container.querySelector('.dsh-pdf-translation-text')!.textContent, 'New translation')
  })
})
