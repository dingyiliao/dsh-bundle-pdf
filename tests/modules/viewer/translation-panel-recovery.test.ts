import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { TranslationPanel, type TranslationPanelProps } from '../../../src/client/viewer/components/TranslationPanel.tsx'
import { TranslationError, translationEn, type TranslationRequest, type TranslationResult } from '../../../src/translation/index.ts'

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
  render(props: TranslationPanelProps): Promise<void>; button(text: string): HTMLButtonElement;
  resize(): Promise<void>
}) => Promise<void>, sourceText = 'subtrac', sourceLayout?: { clientHeight: number; scrollHeight: number }) {
  const { dom, restore: restoreDom, install: installDom } = createDom('<html><body><div id="root"></div></body></html>', { globals: [] })

  const resizeObservers = new Set<ResizeObserverCallback>()
  if (sourceLayout) for (const property of ['clientHeight', 'scrollHeight'] as const) {
    Object.defineProperty(dom.HTMLElement.prototype, property, { configurable: true, get(this: HTMLElement) {
      return this.classList.contains('dsh-pdf-translation-source-text') ? sourceLayout[property] : 0
    } })
  }
  const values = { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, Element: dom.Element,
    HTMLElement: dom.HTMLElement, MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    ResizeObserver: class {
      constructor(private callback: ResizeObserverCallback) { resizeObservers.add(callback) }
      observe() {} unobserve() {}
      disconnect() { resizeObservers.delete(this.callback) }
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true }
  installDom(values)
  const container = dom.document.getElementById('root')!, root = createRoot(container)
  const props: TranslationPanelProps = { selection: { text: sourceText, pages: [1], targetLanguage: 'zh' },
    engineName: 'Fixture', translate, rememberTargetLanguage: async () => true, onClose() {}, t }
  const render = async (value: TranslationPanelProps) => { await act(async () => { root.render(React.createElement(TranslationPanel, value)) }) }
  try {
    await render(props)
    await run({ container, dom, props, render,
      async resize() { await act(async () => { for (const callback of resizeObservers) callback([], {} as ResizeObserver) }) },
      button(text) {
      const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === text)
      assert.ok(button, `Missing button ${text}`)
      return button
    } })
  } finally {
    await act(async () => { root.unmount() })
    restoreDom()

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
    const details = f.container.querySelector<HTMLDetailsElement>('.dsh-pdf-translation-interpretation details')!
    assert.ok(details, 'the reconstruction is available without crowding out the translation')
    assert.equal(details.open, false, 'reconstruction details start collapsed')
    assert.match(details.querySelector('summary')!.textContent ?? '', /Possible completion/)
    const translated = f.container.querySelector('.dsh-pdf-translation-details')!
    assert.ok(translated)
    assert.equal(details.contains(translated), false, 'the translation is visible independently of reconstruction details')
    await act(async () => { details.querySelector('summary')!.click() })
    assert.equal(details.open, true)
    assert.equal(details.closest<HTMLElement>('[role="note"]')!.dataset.certainty, 'tentative')
    await act(async () => { details.querySelector('summary')!.click() })
    assert.equal(details.open, false)
    let copied = ''
    Object.defineProperty(f.dom.navigator, 'clipboard', { configurable: true,
      value: { async writeText(text: string) { copied = text } } })
    await act(async () => { f.button('Copy translation').click() })
    assert.equal(copied, 'Original: subtrac\nPossible completion: subtract\nThe final letter may have been omitted.\n\n减去')
    assert.equal(f.container.querySelector('.dsh-pdf-translation-source-text')!.textContent, 'subtrac')
  })
})

test('copying a translation reports unavailable and denied clipboard capabilities', async () => {
  await withPanel(async () => result('Copied text'), async f => {
    const copy = f.button('Copy translation')
    Object.defineProperty(f.dom.navigator, 'clipboard', { configurable: true, value: {} })
    await act(async () => { copy.click() })
    assert.match(f.container.querySelector('[role="alert"]')?.textContent ?? '', /Text copying is unavailable/)

    Object.defineProperty(f.dom.navigator, 'clipboard', { configurable: true,
      value: { async writeText() { throw new Error('permission denied') } } })
    await act(async () => { copy.click(); await Promise.resolve() })
    assert.match(f.container.querySelector('[role="alert"]')?.textContent ?? '', /Copy failed/)
  })
})

test('overflowing originals expand on demand while requests and copied qualifications retain the entire source', async () => {
  const source = '  An intentionally long selected passage.\n'.repeat(30) + 'FINAL ORIGINAL TEXT'
  const requests: TranslationRequest[] = []
  const interpreted: TranslationResult = { ...result('完整译文'), interpretation: {
    kind: 'correction', certainty: 'confident', text: `${source} — corrected`, explanation: 'Spacing was restored.',
  } }
  const layout = { clientHeight: 80, scrollHeight: 400 }
  await withPanel(async request => { requests.push(request); return interpreted }, async f => {
    assertOriginal(f.container, source)
    const paragraph = f.container.querySelector<HTMLElement>('.dsh-pdf-translation-source-text')!
    const show = f.button('Show full original')
    assert.equal(show.getAttribute('aria-expanded'), 'false')
    assert.equal(show.getAttribute('aria-controls'), paragraph.id)
    assert.equal(paragraph.dataset.expanded, 'false')
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.text, source)
    assert.equal(f.container.querySelector('.dsh-pdf-translation-text')!.textContent, '完整译文')

    await act(async () => { show.click() })
    assert.equal(f.button('Collapse original').getAttribute('aria-expanded'), 'true')
    assert.equal(paragraph.dataset.expanded, 'true')
    assertOriginal(f.container, source)
    await act(async () => { f.button('Collapse original').click() })
    assert.equal(f.button('Show full original').getAttribute('aria-expanded'), 'false')
    assert.equal(paragraph.dataset.expanded, 'false')

    let copied = ''
    Object.defineProperty(f.dom.navigator, 'clipboard', { configurable: true,
      value: { async writeText(text: string) { copied = text } } })
    await act(async () => { f.button('Copy translation').click() })
    assert.equal(copied, `Original: ${source}\nCorrected text: ${source} — corrected\nSpacing was restored.\n\n完整译文`)
    assert.equal(requests.length, 1, 'expanding, collapsing and copying do not submit another model request')
  }, source, layout)
})

test('original disclosure follows measured overflow after resizing and resets for a new selection', async () => {
  const source = 'A selected source spanning many lines. '.repeat(12)
  const layout = { clientHeight: 80, scrollHeight: 240 }
  await withPanel(async () => result(), async f => {
    assert.ok(f.button('Show full original'))
    layout.scrollHeight = 80
    await f.resize()
    assert.equal(f.container.querySelector('.dsh-pdf-translation-source button'), null,
      'a wide panel does not offer expansion when the source already fits')
    assertOriginal(f.container, source)

    layout.scrollHeight = 240
    await f.resize()
    await act(async () => { f.button('Show full original').click() })
    assert.equal(f.button('Collapse original').getAttribute('aria-expanded'), 'true')
    const next = `${source} This is a different selection.`
    await f.render({ ...f.props, selection: { ...f.props.selection, text: next } })
    assertOriginal(f.container, next)
    assert.equal(f.button('Show full original').getAttribute('aria-expanded'), 'false',
      'a previous expansion does not make the next long selection fill the panel')
    assert.equal(f.container.querySelector<HTMLElement>('.dsh-pdf-translation-source-text')!.dataset.expanded, 'false')
  }, source, layout)
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
