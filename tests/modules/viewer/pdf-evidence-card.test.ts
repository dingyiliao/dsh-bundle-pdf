import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PdfEvidenceToolCard, type PdfToolCallProps } from '../../../src/client/toolview/PdfEvidenceToolCard.tsx'
import type { PdfEvidenceNavigation } from '../../../src/client/toolview/pdf-evidence-navigation.ts'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}
const hash = `sha256:${'a'.repeat(64)}`
const meta = { kind: 'pdf-evidence-snapshot', version: 1, tool: 'pdf_read_page', documentId: 'doc',
  sourcePath: '/paper.pdf', sourceDigest: hash, contentVersion: 'v1', revision: 0,
  status: 'ok', page: 2, locator: { kind: 'text-window', startUtf16: 0, endUtf16: 5 },
  snapshot: { text: 'hello', sha256: hash, truncated: false } }

async function withCard(run: (value: { container: HTMLElement; render(props: PdfToolCallProps): Promise<void>;
  activate(): Promise<void> }) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const container = dom.document.getElementById('root')!
  const root = createRoot(container)
  let revision = 0, allowed = false
  const listeners = new Set<() => void>()
  const navigation: PdfEvidenceNavigation = {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getRevision: () => revision,
    register() { allowed = true; revision++; listeners.forEach(listener => listener());
      return () => { allowed = false; revision++; listeners.forEach(listener => listener()) } },
    canNavigate: () => allowed,
    async navigate() { return 'opened' },
  }
  const render = async (props: PdfToolCallProps) => {
    await act(async () => { root.render(React.createElement(PdfEvidenceToolCard, { ...props, navigation, t: key => key })) })
  }
  const activate = async () => { await act(async () => { navigation.register({} as never) }) }
  try {
    await run({ container, render, activate })
  } finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('PDF evidence card renders persisted excerpt, but disables navigation until a visible reader exists', async () => {
  await withCard(async ({ container, render, activate }) => {
    await render({ phase: 'result', toolName: 'pdf_read_page', sessionId: 'session-1',
      block: { meta, content: [{ type: 'text', text: 'historical result' }] } })
    assert.match(container.textContent ?? '', /hello/)
    assert.equal(container.querySelector<HTMLButtonElement>('.pdf-evidence-card-entry button')?.disabled, true)
    await activate()
    assert.equal(container.querySelector<HTMLButtonElement>('.pdf-evidence-card-entry button')?.disabled, false)
  })
})

test('malformed PDF evidence metadata falls back to recorded text instead of hiding the result', async () => {
  await withCard(async ({ container, render }) => {
    await render({ phase: 'result', toolName: 'pdf_read_page', sessionId: 'session-1',
      block: { meta: { ...meta, version: 99 }, content: [{ type: 'text', text: 'recorded output' }] } })
    assert.match(container.querySelector('.pdf-evidence-card-raw')?.textContent ?? '', /recorded output/)
  })
})
