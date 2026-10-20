import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfReadingContextUpdate } from '../../../src/client/contracts.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderContextLease, type ReaderContextLeaseOptions } from '../../../src/modules/viewer/index.ts'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

test('a visible reader renews one page lease and clears it when hidden', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const tab = new AbortController()
  const reports: PdfReadingContextUpdate[] = []
  const snapshot = { id: 'doc-1', contentVersion: 'content-1', reader: { bytesHash: 'bytes', generation: 1 },
    document: { pageCount: 2 } } as WorkspaceSnapshot
  const Harness = (props: ReaderContextLeaseOptions) => { useReaderContextLease(props); return null }
  const options: ReaderContextLeaseOptions = {
    sessionId: 'session-1', tabId: 'tab-1', visible: true, tabSignal: tab.signal,
    snapshot, currentPage: 1, documentReady: true, enabled: true,
    report: async update => { reports.push(update) },
  }
  const render = async (next: ReaderContextLeaseOptions) => {
    await act(async () => { root.render(React.createElement(Harness, next)) })
  }
  try {
    await render(options)
    assert.equal(reports.length, 1)
    assert.equal(reports[0]?.action, 'set')
    const leaseId = reports[0]?.action === 'set' ? reports[0].leaseId : undefined
    await render({ ...options, currentPage: 2 })
    assert.equal(reports.length, 2)
    assert.equal(reports[1]?.action, 'set')
    assert.equal(reports[1]?.action === 'set' ? reports[1].leaseId : undefined, leaseId)
    await render({ ...options, visible: false, currentPage: 2 })
    assert.deepEqual(reports[2], { action: 'clear', sessionId: 'session-1', tabId: 'tab-1', leaseId })
  } finally {
    await act(async () => root.unmount())
    tab.abort()
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
