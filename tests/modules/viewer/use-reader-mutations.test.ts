import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act as reactAct } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderMutations, type ReaderMutationsOptions } from '../../../src/modules/viewer/controllers/use-reader-mutations.ts'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

async function withMutations(run: (fixture: {
  state(): ReturnType<typeof useReaderMutations>
  current(): WorkspaceSnapshot
  owner: { current: number }
  tab: AbortController
  errors: unknown[]
  accepted: WorkspaceSnapshot[]
  clearCount(): number
  changeCalls: unknown[][]
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  let current = { id: 'doc-1', revision: 1, conflict: false } as WorkspaceSnapshot
  const owner = { current: 1 }
  const tab = new AbortController()
  const errors: unknown[] = [], accepted: WorkspaceSnapshot[] = [], changeCalls: unknown[][] = []
  let cleared = 0
  const api = { async change(...args: unknown[]) { changeCalls.push(args); return { ...current, revision: current.revision + 1 } } } as unknown as PdfClientApi
  const options: ReaderMutationsOptions = {
    api, sessionId: 'session-1', tabSignal: tab.signal, ownerSequence: owner,
    currentSnapshot: () => current,
    acceptSnapshot: next => { accepted.push(next); current = next },
    clearError: () => { cleared++ }, onError: error => errors.push(error),
  }
  let state: ReturnType<typeof useReaderMutations> | undefined
  const Harness = () => { state = useReaderMutations(options); return null }
  await reactAct(async () => root.render(React.createElement(Harness)))
  try { await run({ state: () => state!, current: () => current, owner, tab, errors, accepted,
    clearCount: () => cleared, changeCalls }) }
  finally {
    await reactAct(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('mutation transaction serializes writes and applies only the winning snapshot', async () => {
  await withMutations(async ({ state, current, accepted, clearCount, changeCalls }) => {
    let release: ((next: WorkspaceSnapshot) => void) | undefined
    const pendingResult = new Promise<WorkspaceSnapshot>(resolve => { release = resolve })
    let first: Promise<WorkspaceSnapshot | undefined> | undefined
    await reactAct(async () => {
      first = state().act(() => pendingResult)
      assert.equal(state().operationLock.current, true)
      assert.equal(await state().act(() => Promise.resolve(current())), undefined)
    })
    assert.equal(state().busy, true)
    await reactAct(async () => { release!({ ...current(), revision: 2 }); await first })
    assert.equal(state().busy, false)
    assert.equal(state().operationLock.current, false)
    assert.equal(current().revision, 2)
    assert.equal(accepted.length, 1)
    assert.equal(clearCount(), 1)
    await reactAct(async () => { await state().change([{ type: 'delete', id: 'annotation-1' }]) })
    assert.equal(current().revision, 3)
    assert.equal(changeCalls.length, 1)
    assert.equal(changeCalls[0]?.[0], 'session-1')
    assert.equal(changeCalls[0]?.[1], 'doc-1')
    assert.equal(changeCalls[0]?.[2], 2)
  })
})

test('stale-save failure becomes a conflict, while ordinary failures remain errors', async () => {
  await withMutations(async ({ state, current, errors }) => {
    const stale = Object.assign(new Error('source changed'), { code: 'PDF_STALE_VERSION' })
    await reactAct(async () => { await state().act(async () => { throw stale }, true) })
    assert.equal(current().conflict, true)
    assert.deepEqual(errors, [])
    await reactAct(async () => { await state().act(async () => { throw stale }) })
    assert.deepEqual(errors, [stale])
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    await reactAct(async () => { await state().act(async () => { throw abort }) })
    assert.deepEqual(errors, [stale])
  })
})

test('late replies from a previous owner or aborted tab are discarded', async () => {
  await withMutations(async ({ state, owner, tab, accepted, current }) => {
    let release: ((next: WorkspaceSnapshot) => void) | undefined
    const pending = new Promise<WorkspaceSnapshot>(resolve => { release = resolve })
    let result: Promise<WorkspaceSnapshot | undefined> | undefined
    await reactAct(async () => { result = state().act(() => pending); await Promise.resolve() })
    owner.current++
    await reactAct(async () => { release!({ ...current(), revision: 2 }); assert.equal(await result, undefined) })
    assert.equal(accepted.length, 0)
    await reactAct(async () => { tab.abort(); assert.equal(await state().act(async () => ({ ...current(), revision: 3 })), undefined) })
    assert.equal(accepted.length, 0)
  })
})
