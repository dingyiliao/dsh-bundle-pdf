import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfReadingContextUpdate } from '../../../src/client/contracts.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderContextLease, type ReaderContextLeaseOptions } from '../../../src/modules/viewer/index.ts'

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

test('a visible Reader executes an agent jump through its history-aware callback and acknowledges it', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const tab = new AbortController()
  const snapshot = { id: 'doc-1', contentVersion: 'content-1', reader: { bytesHash: 'bytes', generation: 1 },
    document: { pageCount: 8 } } as WorkspaceSnapshot
  const jumped: number[] = []
  const digest = `sha256:${'a'.repeat(64)}`
  const target = { kind: 'text' as const, refId: 'ref-1', revision: 4, sourceDigest: digest,
    pageTextDigest: digest, startUtf16: 1, endUtf16: 5, textSha256: digest,
    rectPdf: [10, 20, 40, 30] as [number, number, number, number], quadPoints: [10, 30, 40, 30, 10, 20, 40, 20] }
  let acknowledged: { status: string; leaseId: string; targetRevision?: number; sourceDigest?: string } | undefined
  let finish!: () => void
  const completed = new Promise<void>(resolve => { finish = resolve })
  let calls = 0
  const Harness = (props: ReaderContextLeaseOptions) => { useReaderContextLease(props); return null }
  const options: ReaderContextLeaseOptions = {
    sessionId: 'session-1', tabId: 'tab-1', visible: true, tabSignal: tab.signal,
    snapshot, currentPage: 1, documentReady: true, enabled: true,
    report: async () => {},
    agentNavigation: {
      async wait(_context, signal) {
        if (++calls === 1) return { requestId: 'request-1', page: 6,
          documentId: 'doc-1', contentVersion: 'content-1', target }
        return new Promise<null>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }))
      },
      async watchRequest(_context, signal) {
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      },
      async complete(context) { acknowledged = context; finish() },
    },
    onAgentNavigate: async (request, signal) => {
      assert.deepEqual(request.target, target)
      assert.equal(signal.aborted, false)
      jumped.push(request.page); return 'opened'
    },
  }
  try {
    await act(async () => { root.render(React.createElement(Harness, options)) })
    await act(async () => { await completed })
    assert.deepEqual(jumped, [6])
    assert.equal(acknowledged?.status, 'opened')
    assert.ok(acknowledged?.leaseId)
    assert.equal(acknowledged?.targetRevision, 4)
    assert.equal(acknowledged?.sourceDigest, digest)
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

test('Host cancellation after delivery aborts an executing Client navigation and never acknowledges opened', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!), tab = new AbortController()
  let cancelHost!: (value: { active: boolean }) => void, completed!: () => void
  const completion = new Promise<void>(resolve => { completed = resolve })
  let calls = 0, opened = 0, result: string | undefined, executionSignal: AbortSignal | undefined
  const snapshot = { id: 'doc', contentVersion: 'v', reader: { bytesHash: 'bytes', generation: 1 },
    document: { pageCount: 3 } } as WorkspaceSnapshot
  const options: ReaderContextLeaseOptions = { sessionId: 'session', tabId: 'tab', visible: true,
    tabSignal: tab.signal, snapshot, currentPage: 1, documentReady: true, enabled: true, report: async () => {},
    agentNavigation: {
      async wait(_context, signal) {
        if (++calls === 1) return { requestId: 'request', page: 2, documentId: 'doc', contentVersion: 'v' }
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      },
      watchRequest: async () => new Promise(resolve => { cancelHost = resolve }),
      async complete(context) { result = context.status; completed() },
    },
    onAgentNavigate: async (_request, signal) => {
      executionSignal = signal
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      if (signal.aborted) return 'unavailable'
      opened++; return 'opened'
    },
  }
  const Harness = () => { useReaderContextLease(options); return null }
  try {
    await act(async () => root.render(React.createElement(Harness)))
    assert.equal(executionSignal?.aborted, false)
    await act(async () => { cancelHost({ active: false }); await completion })
    assert.equal(executionSignal?.aborted, true)
    assert.equal(result, 'unavailable')
    assert.equal(opened, 0)
  } finally {
    await act(async () => root.unmount()); tab.abort(); dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
