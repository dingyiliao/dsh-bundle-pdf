import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderSave, type ReaderSaveOptions } from '../../../src/modules/viewer/index.ts'

async function withSave(run: (fixture: {
  state(): ReturnType<typeof useReaderSave>
  options: ReaderSaveOptions
  render(options: ReaderSaveOptions): Promise<void>
  paths: string[]
  errors: unknown[]
  saves: Array<{ path?: string; overwrite?: boolean; expectedTargetVersion?: string | null }>
  inspections: string[]
}) => Promise<void>): Promise<void> {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root"></div></body></html>', { globals: [] })

  installDom({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(dom.document.getElementById('root')!)
  const tab = new AbortController()
  const paths: string[] = []
  const errors: unknown[] = []
  const saves: Array<{ path?: string; overwrite?: boolean; expectedTargetVersion?: string | null }> = []
  const inspections: string[] = []
  const snapshot = { id: 'doc-1', revision: 4, path: '/original.pdf', dirty: true } as WorkspaceSnapshot
  let latest: ReturnType<typeof useReaderSave> | undefined
  const Harness = (props: ReaderSaveOptions) => { latest = useReaderSave(props); return null }
  const options: ReaderSaveOptions = {
    api: { async save(_sessionId: string, _id: string, _revision: number, request: { path?: string }) {
      saves.push({ ...request })
      return { ...snapshot, path: request.path ?? snapshot.path, dirty: false }
    }, async inspectTarget(_sessionId: string, path: string) { inspections.push(path); return { version: null } } } as unknown as PdfClientApi,
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
  try { await render(options); await run({ state: () => latest!, options, render, paths, errors, saves, inspections }) }
  finally {
    await act(async () => root.unmount())
    tab.abort()
    restoreDom()

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

async function waitForSave(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('Save As opens the draft, chooses only a directory, and rebinds this resource only after explicit save', async () => {
  await withSave(async ({ state, options, render, paths, saves, inspections }) => {
    let picks = 0
    await render({ ...options, pickSaveDirectory: async () => { picks++; return '/copies' } })
    await act(async () => { state().beginSaveAs() })
    assert.equal(state().saveAsOpen, true)
    assert.equal(state().saveName, 'original-annotated.pdf')
    assert.equal(state().saveDirectory, '/')
    assert.equal(picks, 0, 'opening the sheet must not launch a system dialog')
    assert.deepEqual(saves, [])
    await act(async () => { state().setSaveName('copy.pdf'); await state().chooseSaveDirectory() })
    assert.equal(picks, 1)
    assert.equal(state().saveDirectory, '/copies')
    assert.equal(state().savePath, '/copies/copy.pdf')
    assert.deepEqual(saves, [], 'directory selection must never save implicitly')
    await waitForSave(() => !!state().target, 'the composed target is inspected')
    assert.deepEqual(inspections, ['/copies/copy.pdf'])
    await act(async () => { await state().submitSaveAs() })
    assert.deepEqual(saves, [{ path: '/copies/copy.pdf', overwrite: false, expectedTargetVersion: null }])
    assert.equal(state().feedback?.kind, 'saved')
    assert.equal(state().feedback?.path, '/copies/copy.pdf')
    assert.equal(state().feedback?.durationMs, 2000)
    assert.equal(state().saveAsOpen, false)
    assert.deepEqual(paths, ['session-file://session-1/copies/copy.pdf'])
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

test('directory cancellation and target-inspection failures preserve the draft and never claim a failed save', async () => {
  await withSave(async ({ state, options, render, errors, saves }) => {
    await act(async () => { state().showFeedback('unsaved') })
    const previous = state().feedback
    await render({ ...options, pickSaveDirectory: async () => null })
    await act(async () => { state().beginSaveAs(); await state().chooseSaveDirectory() })
    assert.equal(state().feedback, previous)
    assert.equal(state().saveAsOpen, true)
    assert.equal(state().saveDirectory, '/')
    assert.equal(state().saveAsPicking, false)
    assert.deepEqual(saves, [])
    const failure = new Error('Cannot inspect target')
    await render({ ...options, api: { ...options.api, inspectTarget: async () => { throw failure } } })
    await act(async () => { state().beginSaveAs() })
    await waitForSave(() => errors.length === 1, 'the target failure is reported')
    assert.equal(state().feedback, previous)
    assert.equal(state().saveAsOpen, true)
    assert.deepEqual(errors, [failure])
    assert.deepEqual(saves, [])
  })
})

test('existing targets require a separate replacement decision bound to the inspected version', async () => {
  await withSave(async ({ state, options, render, paths, saves }) => {
    await render({ ...options, api: { ...options.api, inspectTarget: async () => ({ version: 'target-v1' }) } })
    await act(async () => { state().beginSaveAs() })
    await waitForSave(() => !!state().target, 'the existing target is inspected')
    await act(async () => { await state().submitSaveAs() })
    assert.equal(state().replaceConfirm, true)
    assert.deepEqual(saves, [])
    assert.deepEqual(paths, [])
    await act(async () => { state().backToSaveAs() })
    assert.equal(state().replaceConfirm, false)
    await act(async () => { await state().submitSaveAs() })
    assert.deepEqual(saves, [])
    await act(async () => { await state().submitSaveAs() })
    assert.deepEqual(saves, [{ path: '/original-annotated.pdf', overwrite: true, expectedTargetVersion: 'target-v1' }])
    assert.equal(paths.length, 1)
  })
})

test('a refused replacement refreshes the target and requires fresh consent while preserving the name and directory', async () => {
  await withSave(async ({ state, options, render, paths, errors }) => {
    const requests: Array<{ path?: string; overwrite?: boolean; expectedTargetVersion?: string | null }> = []
    let targetVersion = 'target-v1'
    let inspections = 0
    const failure = Object.assign(new Error('Target changed after inspection'), { code: 'PDF_STALE_VERSION' })
    await render({ ...options, api: { ...options.api,
      inspectTarget: async () => { inspections++; return { version: targetVersion } },
      save: async (_session, _id, _revision, request) => {
        requests.push({ ...request })
        if (requests.length === 1) { targetVersion = 'target-v2'; throw failure }
        return { ...options.snapshot!, path: request.path!, dirty: false }
      },
    } })
    await act(async () => { state().beginSaveAs(); state().setSaveDirectory('/copies'); state().setSaveName('chosen.pdf') })
    await waitForSave(() => !!state().target, 'the first target version is inspected')
    await act(async () => { await state().submitSaveAs() })
    await act(async () => { await state().submitSaveAs() })
    assert.deepEqual(errors, [failure])
    assert.equal(state().feedback?.kind, 'failed')
    assert.equal(state().replaceConfirm, false)
    assert.equal(state().saveAsOpen, true)
    assert.equal(state().saveName, 'chosen.pdf')
    assert.equal(state().saveDirectory, '/copies')
    assert.deepEqual(paths, [])
    await waitForSave(() => state().target?.version === 'target-v2', 'failed writes must obtain a new target version')
    assert.equal(inspections, 2)
    await act(async () => { await state().submitSaveAs() })
    assert.equal(requests.length, 1, 'new target contents need another explicit replacement decision')
    await act(async () => { await state().submitSaveAs() })
    assert.deepEqual(requests, [
      { path: '/copies/chosen.pdf', overwrite: true, expectedTargetVersion: 'target-v1' },
      { path: '/copies/chosen.pdf', overwrite: true, expectedTargetVersion: 'target-v2' },
    ])
    assert.equal(state().feedback?.kind, 'saved')
    assert.equal(paths.length, 1)
  })
})

test('invalid or unchecked targets cannot save, and changing the name revokes old replacement consent', async () => {
  await withSave(async ({ state, options, render, saves }) => {
    await render({ ...options, api: { ...options.api, inspectTarget: async () => ({ version: 'existing' }) } })
    await act(async () => { state().beginSaveAs() })
    await act(async () => { await state().submitSaveAs() })
    assert.deepEqual(saves, [], 'inspection must finish before submission')
    await waitForSave(() => !!state().target, 'the target is inspected')
    await act(async () => { await state().submitSaveAs() })
    assert.equal(state().replaceConfirm, true)
    await act(async () => { state().setSaveName('../outside.pdf') })
    assert.equal(state().locationError, 'name')
    assert.equal(state().target, null)
    assert.equal(state().replaceConfirm, false)
    await act(async () => { await state().submitSaveAs() })
    assert.deepEqual(saves, [])
    await act(async () => { state().setSaveName('other.pdf') })
    await waitForSave(() => state().target?.path === '/other.pdf', 'the new target needs its own inspection')
    await act(async () => { await state().submitSaveAs() })
    assert.equal(state().replaceConfirm, true)
    assert.deepEqual(saves, [], 'the previous filename consent cannot carry over')
  })
})

test('closing a sheet ignores a late directory result and cannot clear a newer dialog picker', async () => {
  await withSave(async ({ state, options, render, saves, errors }) => {
    const first = deferred<string | null>(), second = deferred<string | null>()
    let picks = 0
    await render({ ...options, pickSaveDirectory: () => ++picks === 1 ? first.promise : second.promise })
    await act(async () => { state().beginSaveAs() })
    let oldRequest!: Promise<void>, newRequest!: Promise<void>
    await act(async () => { oldRequest = state().chooseSaveDirectory() })
    assert.equal(state().saveAsPicking, true)
    await act(async () => { state().closeSaveAs() })
    await act(async () => { state().beginSaveAs() })
    await act(async () => { newRequest = state().chooseSaveDirectory() })
    await act(async () => { first.resolve('/late-old'); await oldRequest })
    assert.equal(state().saveAsOpen, true)
    assert.equal(state().saveAsPicking, true, 'an old finally must not unlock the current picker')
    assert.equal(state().saveDirectory, '/')
    await act(async () => { second.resolve('/new'); await newRequest })
    assert.equal(state().saveDirectory, '/new')
    assert.equal(state().saveAsPicking, false)
    assert.deepEqual(saves, [])
    assert.deepEqual(errors, [])
  })
})

test('document, API, session and tab changes retire pending directory picks without leaking errors or values', async () => {
  for (const change of ['document', 'api', 'session', 'tab'] as const) {
    await withSave(async ({ state, options, render, saves, errors }) => {
      const pending = deferred<string | null>()
      const input = { ...options, pickSaveDirectory: () => pending.promise }
      await render(input)
      await act(async () => { state().beginSaveAs() })
      let picking!: Promise<void>
      await act(async () => { picking = state().chooseSaveDirectory() })
      const replacement = { ...options.snapshot!, id: 'new-document', path: '/new.pdf' }
      const next = change === 'document' ? { ...input, snapshot: replacement, resourceAddress: 'session-file:///new.pdf', currentSnapshot: () => replacement }
        : change === 'api' ? { ...input, api: { ...options.api } }
          : change === 'session' ? { ...input, sessionId: 'new-session' }
            : { ...input, tabSignal: new AbortController().signal }
      await render(next)
      assert.equal(state().saveAsOpen, false, `${change} replacement closes the old sheet`)
      assert.equal(state().saveAsPicking, false)
      await act(async () => { pending.reject(new Error('Old picker failed')); await picking })
      assert.equal(state().saveAsOpen, false)
      assert.equal(state().saveDirectory, '/')
      assert.deepEqual(errors, [])
      assert.deepEqual(saves, [])
    })
  }
})

test('cancelling a sheet ignores stale inspection and an aborted tab cannot accept a picker result', async () => {
  await withSave(async ({ state, options, render, errors, saves }) => {
    const inspected = deferred<{ version: string | null }>(), picked = deferred<string | null>()
    let entered = false
    const tab = new AbortController()
    await render({ ...options, tabSignal: tab.signal, pickSaveDirectory: () => picked.promise,
      api: { ...options.api, inspectTarget: async () => { entered = true; return inspected.promise } } })
    await act(async () => { state().beginSaveAs() })
    await waitForSave(() => entered, 'target inspection begins')
    await act(async () => { state().closeSaveAs(); inspected.resolve({ version: 'stale-target' }); await Promise.resolve() })
    assert.equal(state().target, null)
    await act(async () => { state().beginSaveAs() })
    let request!: Promise<void>
    await act(async () => { request = state().chooseSaveDirectory() })
    await act(async () => { tab.abort(); picked.resolve('/late'); await request })
    assert.equal(state().saveAsOpen, false)
    assert.equal(state().saveAsPicking, false)
    assert.deepEqual(errors, [])
    assert.deepEqual(saves, [])
  })
})
