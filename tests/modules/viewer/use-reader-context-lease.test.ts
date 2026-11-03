import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfReadingContextUpdate } from '../../../src/client/contracts.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderContextLease, type ReaderContextLeaseOptions } from '../../../src/modules/viewer/index.ts'
import { createReaderContexts } from '../../../src/modules/navigation/reader-contexts.ts'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

async function withReadingLease(run: (fixture: {
  options: ReaderContextLeaseOptions
  window: Window & typeof globalThis
  render(update?: Partial<ReaderContextLeaseOptions>): Promise<void>
  contexts: ReturnType<typeof createReaderContexts>
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const snapshot = { id: 'visible-pdf', contentVersion: 'content', reader: { bytesHash: 'bytes', generation: 1 },
    document: { pageCount: 20 } } as WorkspaceSnapshot
  const contexts = createReaderContexts({ readSnapshot: () => ({ ...snapshot, bytes: new Uint8Array() }) })
  let sequence = 0
  const options: ReaderContextLeaseOptions = { sessionId: 'chat', tabId: 'tab', visible: true,
    tabSignal: new AbortController().signal, snapshot, currentPage: 3, documentReady: true, enabled: true,
    report: async update => { contexts.update('chat', { ...update, sequence: ++sequence }) } }
  let current = options
  const Harness = (props: ReaderContextLeaseOptions) => { useReaderContextLease(props); return null }
  const render = async (update: Partial<ReaderContextLeaseOptions> = {}) => {
    current = { ...current, ...update }
    await act(async () => root.render(React.createElement(Harness, current)))
  }
  try { await run({ options, window: dom, render, contexts }) }
  finally {
    await act(async () => root.unmount())
    contexts.dispose(); dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('a visible PDF recovers a failed presence update without scrolling or waiting for its next heartbeat', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  t.mock.method(console, 'warn', () => {})
  await withReadingLease(async ({ options, render, contexts }) => {
    const send = options.report!
    let calls = 0
    options.report = async update => {
      if (++calls === 1) throw new Error('temporary connection failure')
      await send(update)
    }
    await render()
    assert.deepEqual(contexts.current('chat'), [], 'the initial presence request was lost')
    await act(async () => t.mock.timers.tick(1000))
    assert.equal(calls, 2)
    assert.deepEqual(contexts.current('chat'), [{ tabId: 'tab', documentId: 'visible-pdf', contentVersion: 'content', page: 3 }])
    await render({ visible: false })
    await act(async () => t.mock.timers.tick(90_001))
    assert.deepEqual(contexts.current('chat'), [], 'a hidden PDF is not revived by a retry')
  })
})

test('visible Reader heartbeats and focus restore Host presence without a new document or page change', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  await withReadingLease(async ({ render, contexts, window }) => {
    await render()
    const expected = contexts.current('chat')
    await act(async () => t.mock.timers.tick(90_001))
    assert.deepEqual(contexts.current('chat'), expected, 'an unchanged visible page renews its TTL')
    contexts.dispose()
    assert.deepEqual(contexts.current('chat'), [])
    await act(async () => { window.dispatchEvent(new window.Event('focus')) })
    assert.deepEqual(contexts.current('chat'), expected, 'foregrounding immediately restores an erased Host hint')
    contexts.dispose()
    await act(async () => { window.dispatchEvent(new window.Event('online')) })
    assert.deepEqual(contexts.current('chat'), expected, 'reconnecting does not require a scroll')
    await render({ visible: false })
    await act(async () => { window.dispatchEvent(new window.Event('focus')) })
    assert.deepEqual(contexts.current('chat'), [])
  })
})

test('replacing the reporter reannounces an unchanged visible page and failed old updates cannot resurrect a closed lease', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.mock.method(console, 'warn', () => {})
  await withReadingLease(async ({ options, render, contexts }) => {
    await render()
    const expected = contexts.current('chat')
    contexts.dispose()
    await render({ report: async update => options.report!(update) })
    assert.deepEqual(contexts.current('chat'), expected)
    let reject!: (error: Error) => void
    const lost = new Promise<void>((_resolve, no) => { reject = no })
    const send = options.report!
    let calls = 0
    await render({ report: async update => {
      calls++
      if (update.action === 'set') return lost
      return send(update)
    } })
    await render({ visible: false })
    await act(async () => { reject(new Error('late connection failure')) })
    await act(async () => t.mock.timers.tick(60_000))
    assert.equal(calls, 2, 'only the pending set and its clear were sent')
    assert.deepEqual(contexts.current('chat'), [])
  })
})

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
