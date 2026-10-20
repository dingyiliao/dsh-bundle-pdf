import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReaderSelection } from '../../../src/modules/viewer/model/reader-selection.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { TranslationRegistry } from '../../../src/translation/index.ts'
import { useReaderTranslation, type ReaderTranslationOptions } from '../../../src/modules/viewer/index.ts'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

const source: ReaderSelection = { kind: 'text', revision: 4, text: 'contextual words',
  selectionBefore: 'before', selectionAfter: 'after',
  fragments: [{ page: 2, rect: [1, 2, 3, 4], quadPoints: [] }] }
const snapshot = { id: 'doc-1', revision: 4, contentVersion: 'v1' } as WorkspaceSnapshot

async function withTranslation(run: (fixture: {
  state(): ReturnType<typeof useReaderTranslation>
  options: ReaderTranslationOptions
  render(options: ReaderTranslationOptions): Promise<void>
  opened(): number
  requests: unknown[]
}) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const prior = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const registry = new TranslationRegistry({ timeoutMs: 1_000, maxInputCharacters: 200, maxOutputCharacters: 200 })
  const requests: unknown[] = []
  registry.register({ descriptor: { id: 'fake', name: 'Fake', version: '1', execution: 'local' },
    translate: async request => { requests.push(request); return { text: '译文', status: 'complete', warnings: [] } } })
  registry.select({ id: 'account', engineId: 'fake', configurationRevision: '1', config: {} })
  let latest: ReturnType<typeof useReaderTranslation> | undefined
  let current = snapshot
  let opened = 0
  const Harness = (props: ReaderTranslationOptions) => { latest = useReaderTranslation(props); return null }
  const options: ReaderTranslationOptions = { translation: registry, sessionId: 'chat-1',
    tabSignal: new AbortController().signal, snapshot, displayOwnerToken: 1,
    ownerSequence: { current: 1 }, currentSnapshot: () => current,
    selection: source, targetLanguage: 'zh', engine: 'fake', timeoutMs: 800,
    showSidebar: () => { opened++ } }
  const render = async (next: ReaderTranslationOptions) => {
    current = next.snapshot ?? current
    await act(async () => root.render(React.createElement(Harness, next)))
  }
  try {
    await render(options)
    await run({ state: () => latest!, options, render, opened: () => opened, requests })
  } finally {
    await act(async () => root.unmount())
    registry.dispose()
    dom.close()
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('translation captures selected text, nearby words, page and current session', async () => {
  await withTranslation(async ({ state, opened, requests }) => {
    await act(async () => state().begin())
    assert.equal(opened(), 1)
    assert.equal(state().selection?.text, source.text)
    assert.equal(state().selection?.targetLanguage, 'zh')
    const result = await state().translate({ text: source.text, targetLanguage: 'zh' })
    assert.equal(result.text, '译文')
    assert.deepEqual((requests[0] as { context: unknown }).context, {
      sessionId: 'chat-1', documentId: 'doc-1', contentVersion: 'v1', pages: [2],
      selectionBefore: 'before', selectionAfter: 'after',
    })
    await act(async () => state().close())
    assert.equal(state().selection, null)
  })
})

test('translation rejects a stale owner and resets when the source changes', async () => {
  await withTranslation(async ({ state, options, render, opened }) => {
    await render({ ...options, displayOwnerToken: 2 })
    await act(async () => state().begin())
    assert.equal(opened(), 0)
    await render(options)
    await act(async () => state().begin())
    assert.equal(state().selection?.documentId, 'doc-1')
    await act(async () => state().reset())
    assert.equal(state().selection, null)
    await act(async () => { await assert.rejects(state().translate({ text: source.text, targetLanguage: 'zh' })) })
  })
})
