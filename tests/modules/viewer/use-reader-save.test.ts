import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderSave, type ReaderSaveOptions } from '../../../src/modules/viewer/index.ts'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

async function withSave(run: (fixture: {
  state(): ReturnType<typeof useReaderSave>
  options: ReaderSaveOptions
  render(options: ReaderSaveOptions): Promise<void>
  paths: string[]
}) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const tab = new AbortController()
  const paths: string[] = []
  const snapshot = { id: 'doc-1', revision: 4, path: '/original.pdf', dirty: true } as WorkspaceSnapshot
  let latest: ReturnType<typeof useReaderSave> | undefined
  const Harness = (props: ReaderSaveOptions) => { latest = useReaderSave(props); return null }
  const options: ReaderSaveOptions = {
    api: { async save(_sessionId: string, _id: string, _revision: number, request: { path?: string }) {
      return { ...snapshot, path: request.path ?? snapshot.path, dirty: false }
    }, async inspectTarget() { return { version: null } } } as unknown as PdfClientApi,
    sessionId: 'session-1', resourceAddress: 'session-file:///original.pdf', tabSignal: tab.signal, snapshot,
    ownerSequence: { current: 1 }, operationLock: { current: false }, currentSnapshot: () => snapshot,
    act: async operation => operation(snapshot), openResource: path => { paths.push(path) },
    addressForPath: (sessionId, path) => `session-file://${sessionId}${path}`,
    setError() {}, onError: error => { throw error }, t: key => key,
  }
  const render = async (next: ReaderSaveOptions) => { await act(async () => root.render(React.createElement(Harness, next))) }
  try { await render(options); await run({ state: () => latest!, options, render, paths }) }
  finally {
    await act(async () => root.unmount())
    tab.abort()
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('same-file save reports success even when the caller drops a stale RPC snapshot', async () => {
  await withSave(async ({ state, options, render, paths }) => {
    await render({ ...options, act: async operation => { await operation(options.snapshot!); return undefined } })
    await act(async () => { await state().save() })
    assert.equal(state().feedback?.kind, 'saved')
    assert.equal(state().feedback?.path, '/original.pdf')
    assert.deepEqual(paths, [])
  })
})

test('native Save As inspects the target and replaces this resource only after a successful save', async () => {
  await withSave(async ({ state, options, render, paths }) => {
    const picked: string[] = []
    await render({ ...options, pickSavePath: async defaultPath => {
      picked.push(defaultPath)
      return '/copy.pdf'
    } })
    await act(async () => { await state().beginSaveAs() })
    assert.deepEqual(picked, ['/original-annotated.pdf'])
    assert.equal(state().feedback?.kind, 'saved')
    assert.equal(state().feedback?.path, '/copy.pdf')
    assert.equal(paths.length, 1)
    assert.match(paths[0], /copy\.pdf/)
  })
})
