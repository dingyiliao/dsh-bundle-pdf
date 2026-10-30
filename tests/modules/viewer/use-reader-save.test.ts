import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderSave, type ReaderSaveOptions } from '../../../src/modules/viewer/index.ts'

const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

async function withSave(run: (fixture: {
  state(): ReturnType<typeof useReaderSave>
  options: ReaderSaveOptions
  render(options: ReaderSaveOptions): Promise<void>
  paths: string[]
  errors: unknown[]
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
  const errors: unknown[] = []
  const snapshot = { id: 'doc-1', revision: 4, path: '/original.pdf', dirty: true } as WorkspaceSnapshot
  let latest: ReturnType<typeof useReaderSave> | undefined
  const Harness = (props: ReaderSaveOptions) => { latest = useReaderSave(props); return null }
  const options: ReaderSaveOptions = {
    api: { async save(_sessionId: string, _id: string, _revision: number, request: { path?: string }) {
      return { ...snapshot, path: request.path ?? snapshot.path, dirty: false }
    }, async inspectTarget() { return { version: null } } } as unknown as PdfClientApi,
    sessionId: 'session-1', resourceAddress: 'session-file:///original.pdf', tabSignal: tab.signal, snapshot,
    ownerSequence: { current: 1 }, operationLock: { current: false }, currentSnapshot: () => snapshot,
    act: async operation => {
      try { return await operation(snapshot) }
      catch (failure) { errors.push(failure); return undefined }
    }, openResource: path => { paths.push(path) },
    addressForPath: (sessionId, path) => `session-file://${sessionId}${path}`,
    setError() {}, onError: error => { errors.push(error) }, t: key => key,
  }
  const render = async (next: ReaderSaveOptions) => { await act(async () => root.render(React.createElement(Harness, next))) }
  try { await render(options); await run({ state: () => latest!, options, render, paths, errors }) }
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
    await render({ ...options, act: async operation => {
      await operation(options.snapshot!)
      options.ownerSequence.current++
      return undefined
    } })
    await act(async () => { await state().save() })
    assert.equal(state().feedback?.kind, 'saved')
    assert.equal(state().feedback?.path, '/original.pdf')
    assert.equal(state().feedback?.durationMs, 2000)
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
    assert.equal(state().feedback?.durationMs, 2000)
    assert.equal(paths.length, 1)
    assert.match(paths[0], /copy\.pdf/)
  })
})

test('a rejected save keeps persistent failure feedback and reports the error only through act', async () => {
  await withSave(async ({ state, options, render, errors }) => {
    const failure = new Error('Disk is full')
    await render({ ...options, api: { ...options.api, save: async () => { throw failure } } })
    await act(async () => { await state().save() })
    assert.equal(state().feedback?.kind, 'failed')
    assert.equal(state().feedback?.durationMs, 0)
    assert.equal(state().feedback?.path, '/original.pdf')
    assert.deepEqual(errors, [failure])
  })
})

test('a successful retry replaces failed feedback with a new timed success occurrence', async () => {
  await withSave(async ({ state, options, render }) => {
    await render({ ...options, api: { ...options.api, save: async () => { throw new Error('Write failed') } } })
    await act(async () => { await state().save() })
    const failureOccurrence = state().feedback!.occurrence
    await render(options)
    await act(async () => { await state().save() })
    assert.equal(state().feedback?.kind, 'saved')
    assert.equal(state().feedback?.durationMs, 2000)
    assert.ok(state().feedback!.occurrence > failureOccurrence)
  })
})

test('a save not admitted by act preserves existing feedback without showing saving or failure', async () => {
  await withSave(async ({ state, options, render }) => {
    await act(async () => { state().showFeedback('failed', 0) })
    const failure = state().feedback
    let calls = 0
    await render({ ...options, act: async () => undefined,
      api: { ...options.api, save: async () => { calls++; throw new Error('Must not run') } } })
    await act(async () => { await state().save() })
    assert.equal(calls, 0)
    assert.equal(state().feedback, failure)
  })
})

test('a draft notification does not replace in-flight save feedback', async () => {
  await withSave(async ({ state, options, render }) => {
    let reject!: (failure: Error) => void
    const pending = new Promise<WorkspaceSnapshot>((_resolve, no) => { reject = no })
    const savingOptions = { ...options, snapshot: { ...options.snapshot!, dirty: false },
      api: { ...options.api, save: () => pending } }
    await render(savingOptions)
    let saving!: Promise<void>
    await act(async () => { saving = state().save(); await Promise.resolve() })
    await render({ ...savingOptions, snapshot: { ...options.snapshot!, revision: 5 } })
    assert.equal(state().feedback?.kind, 'saving')
    await act(async () => { reject(new Error('Concurrent write')); await saving })
    assert.equal(state().feedback?.kind, 'failed')
  })
})

test('a cancelled save restores the previous feedback rather than manufacturing a failure', async () => {
  await withSave(async ({ state, options, render }) => {
    await act(async () => { state().showFeedback('unsaved') })
    const previous = state().feedback
    await render({ ...options,
      api: { ...options.api, save: async () => { throw new DOMException('Cancelled', 'AbortError') } },
      act: async operation => { try { return await operation(options.snapshot!) } catch { return undefined } } })
    await act(async () => { await state().save() })
    assert.equal(state().feedback, previous)
  })
})

test('changing documents while a save settles cannot publish the old success or failure', async () => {
  for (const outcome of ['saved', 'failed'] as const) {
    await withSave(async ({ state, options, render }) => {
      let resolve!: (snapshot: WorkspaceSnapshot) => void
      let reject!: (failure: Error) => void
      const pending = new Promise<WorkspaceSnapshot>((yes, no) => { resolve = yes; reject = no })
      await render({ ...options, api: { ...options.api, save: () => pending } })
      let saving!: Promise<void>
      await act(async () => { saving = state().save(); await Promise.resolve() })
      assert.equal(state().feedback?.kind, 'saving')
      const other = { ...options.snapshot!, id: 'doc-2', path: '/other.pdf', dirty: false }
      await render({ ...options, snapshot: other, resourceAddress: 'session-file:///other.pdf', currentSnapshot: () => other })
      assert.equal(state().feedback, null)
      await act(async () => {
        if (outcome === 'saved') resolve({ ...options.snapshot!, dirty: false })
        else reject(new Error('Old request failed'))
        await saving
      })
      assert.equal(state().feedback, null)
    })
  }
})

test('a failed request from an invalidated document owner does not become the current save failure', async () => {
  await withSave(async ({ state, options, render }) => {
    let reject!: (failure: Error) => void
    const pending = new Promise<WorkspaceSnapshot>((_resolve, no) => { reject = no })
    await render({ ...options, api: { ...options.api, save: () => pending } })
    let saving!: Promise<void>
    await act(async () => { saving = state().save(); await Promise.resolve() })
    options.ownerSequence.current++
    await act(async () => { reject(new Error('Old owner failed')); await saving })
    assert.equal(state().feedback, null)
  })
})

test('failed feedback survives a fresh edit but clears when the document becomes clean or is replaced', async () => {
  await withSave(async ({ state, options, render }) => {
    const clean = { ...options.snapshot!, dirty: false }
    await render({ ...options, snapshot: clean })
    await act(async () => { state().showFeedback('failed', 0) })
    await render({ ...options, snapshot: { ...clean, dirty: true, revision: 5 } })
    assert.equal(state().feedback?.kind, 'failed')
    await render({ ...options, snapshot: { ...clean, revision: 6 } })
    assert.equal(state().feedback, null)
    await act(async () => { state().showFeedback('failed', 0) })
    await render({ ...options, snapshot: { ...clean, revision: 7 } })
    assert.equal(state().feedback, null)
    await act(async () => { state().showFeedback('failed', 0) })
    await render({ ...options, snapshot: { ...clean, id: 'replacement', dirty: true } })
    assert.equal(state().feedback, null)
  })
})

test('native picker cancellation and target-inspection failures never claim that saving failed', async () => {
  await withSave(async ({ state, options, render, errors }) => {
    await act(async () => { state().showFeedback('unsaved') })
    const previous = state().feedback
    await render({ ...options, pickSavePath: async () => null })
    await act(async () => { await state().beginSaveAs() })
    assert.equal(state().feedback, previous)
    const failure = new Error('Cannot inspect target')
    await render({ ...options, pickSavePath: async () => '/copy.pdf',
      api: { ...options.api, inspectTarget: async () => { throw failure } } })
    await act(async () => { await state().beginSaveAs() })
    assert.equal(state().feedback, previous)
    assert.deepEqual(errors, [failure])
  })
})
