import { createDom } from '../../support/dom.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderDocument, type ReaderDocumentOptions } from '../../../src/client/viewer/controllers/use-reader-document.ts'

const makeSnapshot = (id: string, sourceVersion = 'source-1') => ({
  id, path: '/tmp/sample.pdf', sourceVersion, contentVersion: 'content-1', revision: 1,
  dirty: false, canUndo: false, canRedo: false, conflict: false,
  reader: { bytesHash: 'bytes-1', generation: 1, protocolVersion: 1 },
  document: { pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }],
    annotations: [], signed: false, encrypted: false, readOnly: false },
}) as WorkspaceSnapshot

async function withDocument(run: (fixture: {
  state(): ReturnType<typeof useReaderDocument>
  options: ReaderDocumentOptions
  render(options: ReaderDocumentOptions): Promise<void>
  unmount(): Promise<void>
  loaded: string[]
  failed: string[]
  switches: string[]
}) => Promise<void>) {
  const { dom, restore: restoreDom, install: installDom } = createDom('<!doctype html><html><body><div id="root"></div></body></html>', { globals: [] })

  installDom({ window: dom, document: dom.document,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(dom.document.getElementById('root')!)
  const loaded: string[] = [], failed: string[] = [], switches: string[] = []
  let latest: ReturnType<typeof useReaderDocument> | undefined
  const Harness = (props: ReaderDocumentOptions) => { latest = useReaderDocument(props); return null }
  const api = { open: async () => makeSnapshot('doc-1'), subscribe: () => () => {}, native: {} } as unknown as PdfClientApi
  const options: ReaderDocumentOptions = { api, sessionId: 'chat-1', resourceAddress: 'file:///tmp/sample.pdf',
    tabSignal: new AbortController().signal, content: { revision: 1,
      loaded: (source: string) => loaded.push(source), failed: () => failed.push('failed') },
    onError: failure => failed.push(String(failure)), onResourceSwitch: () => switches.push('switch'),
    onNativeOpened: () => {}, releaseRegionCapture: () => null }
  const render = async (next: ReaderDocumentOptions) => {
    await act(async () => { root.render(React.createElement(Harness, next)); await new Promise(resolve => setTimeout(resolve, 5)) })
  }
  const unmount = async () => { await act(async () => { root.render(null) }) }
  try { await run({ state: () => latest!, options, render, unmount, loaded, failed, switches }) }
  finally {
    await act(async () => root.unmount())
    restoreDom()

  }
}

test('document owner publishes a native handle and reports its source version', async () => {
  await withDocument(async ({ options, state, render, loaded, failed, switches }) => {
    await render(options)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(state().snapshot?.id, 'doc-1')
    assert.equal(state().pdf?.numPages, 1)
    assert.equal(state().documentReady(), true)
    assert.ok(loaded.includes('source-1'))
    assert.deepEqual(failed, [])
    assert.deepEqual(switches, ['switch'])
  })
})

test('password prompt retries a wrong password without failing the content lease', async () => {
  await withDocument(async ({ options, state, render, loaded, failed }) => {
    options.api.open = async () => { throw Object.assign(new Error('required'), { code: 'pdf/password-required' }) }
    const passwords: string[] = []
    options.api.unlock = async (_sessionId, _address, password) => {
      passwords.push(password)
      if (password === 'wrong') throw Object.assign(new Error('incorrect'), { code: 'pdf/password-incorrect' })
      return makeSnapshot('protected')
    }
    await render(options)
    assert.equal(state().passwordPrompt, 'required')
    assert.deepEqual(failed, [])
    await act(async () => { await state().unlock('wrong') })
    assert.equal(state().passwordPrompt, 'incorrect')
    assert.deepEqual(failed, [])
    await act(async () => { await state().unlock('correct') })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(state().passwordPrompt, null)
    assert.equal(state().snapshot?.id, 'protected')
    assert.ok(loaded.includes('source-1'))
    assert.deepEqual(passwords, ['wrong', 'correct'])
  })
})

test('an unlock transport failure releases pending Reader commands and reports the failed lease', async () => {
  await withDocument(async ({ options, state, render, loaded, failed }) => {
    options.api.open = async () => { throw Object.assign(new Error('required'), { code: 'pdf/password-required' }) }
    let disconnect!: (error: Error) => void
    options.api.unlock = () => new Promise((_resolve, reject) => { disconnect = reject })
    await render(options)
    assert.equal(state().passwordPrompt, 'required')
    const ready = state().waitForReady()
    let unlocking!: Promise<void>
    await act(async () => { unlocking = state().unlock('test-password') })
    assert.equal(state().unlocking, true)
    await act(async () => {
      disconnect(new Error('transport disconnected'))
      await unlocking
    })
    assert.equal(await ready, false)
    assert.equal(state().passwordPrompt, null)
    assert.equal(state().unlocking, false)
    assert.equal(state().snapshot, null)
    assert.deepEqual(loaded, [])
    assert.deepEqual(failed, ['Error: transport disconnected', 'failed'])
  })
})

test('cancelled unlock fails the current lease and a resource switch clears the prompt', async () => {
  await withDocument(async ({ options, state, render, failed }) => {
    options.api.open = async (_sessionId, address) => {
      if (address === options.resourceAddress) throw Object.assign(new Error('required'), { code: 'pdf/password-required' })
      return makeSnapshot('next')
    }
    await render(options)
    await act(async () => { state().cancelUnlock() })
    assert.equal(state().passwordPrompt, 'cancelled')
    assert.deepEqual(failed, ['failed'])
    await render({ ...options, resourceAddress: 'file:///tmp/next.pdf',
      content: { ...options.content, revision: 2 } })
    assert.equal(state().passwordPrompt, null)
    assert.equal(state().snapshot?.id, 'next')
  })
})

test('editing unlock failures and late replies leave the visible PDF readable', async () => {
  for (const interruption of ['cancel', 'switch'] as const) {
    await withDocument(async ({ options, state, render, failed }) => {
      const locked = makeSnapshot('locked')
      locked.document = { ...locked.document, encrypted: true, readOnly: true, annotationEditing: 'owner-password-required' }
      options.api.open = async (_session, address) => address === options.resourceAddress ? locked : makeSnapshot('next')
      options.api.unlockEdit = async () => { throw Object.assign(new Error('Source changed'), { code: 'pdf/source-conflict' }) }
      await render(options)
      const reading = state().pdf
      assert.ok(reading)
      await act(async () => { state().beginEditUnlock() })
      await act(async () => { await state().unlockEditing('fixture-owner') })
      assert.equal(state().editPasswordPrompt, 'required')
      assert.equal(state().unlocking, false)
      assert.equal(state().pdf, reading)
      assert.equal(state().documentReady(), true)
      assert.deepEqual(failed, ['Error: Source changed'], 'edit denial does not fail the reading lease')

      let resolve!: (value: WorkspaceSnapshot) => void
      let signal: AbortSignal | undefined
      options.api.unlockEdit = async (_session, _id, _revision, _password, requestSignal) => {
        signal = requestSignal
        return new Promise(accept => { resolve = accept })
      }
      let pending!: Promise<void>
      await act(async () => { pending = state().unlockEditing('fixture-owner') })
      assert.equal(state().unlocking, true)
      if (interruption === 'cancel') await act(async () => { state().cancelEditUnlock() })
      else await render({ ...options, resourceAddress: 'file:///tmp/next.pdf', content: { ...options.content, revision: 2 } })
      assert.equal(signal?.aborted, true)
      await act(async () => {
        resolve({ ...locked, revision: 2, document: { ...locked.document, readOnly: false, annotationEditing: 'allowed' } })
        await pending
      })
      assert.equal(state().editPasswordPrompt, null)
      assert.equal(state().unlocking, false)
      assert.equal(state().snapshot?.id, interruption === 'cancel' ? 'locked' : 'next')
      assert.notEqual(state().snapshot?.document.annotationEditing, 'allowed')
      assert.equal(state().documentReady(), true)
      assert.deepEqual(failed, ['Error: Source changed'])
    })
  }
})

test('a protected Host restart prompts again without replaying the earlier password', async () => {
  await withDocument(async ({ options, state, render, failed }) => {
    options.api.native.text = async () => { throw Object.assign(new Error('old baseline'), { code: 'pdf/stale-reader' }) }
    options.api.refresh = async () => { throw Object.assign(new Error('required'), { code: 'pdf/password-required' }) }
    const passwords: string[] = []
    options.api.unlock = async (_sessionId, _address, password) => {
      passwords.push(password)
      return { ...makeSnapshot('after-restart'), reader: { bytesHash: 'new-bytes', generation: 1, protocolVersion: 1 } }
    }
    await render(options)
    await act(async () => { await assert.rejects(state().pdf!.text(1), { name: 'AbortError' }) })
    assert.equal(state().passwordPrompt, 'required')
    assert.equal(state().pdf, null)
    assert.deepEqual(passwords, [])
    await act(async () => { await state().unlock('entered-again') })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(state().snapshot?.id, 'after-restart')
    assert.deepEqual(passwords, ['entered-again'])
    assert.deepEqual(failed, [])
  })
})

test('a restarted Host can replace the document ID while preserving the current resource owner', async () => {
  await withDocument(async ({ options, state, render, failed }) => {
    options.api.native.text = async (_sessionId, id) => {
      if (id === 'doc-1') throw Object.assign(new Error('old Host baseline'), { code: 'pdf/stale-reader' })
      return { items: [], styles: {}, lang: null }
    }
    options.api.refresh = async () => ({ ...makeSnapshot('new-host-document'), revision: 0,
      contentVersion: 'restored-content', reader: { bytesHash: 'restored-bytes', generation: 1, protocolVersion: 1 } })
    await render(options)
    const original = state().pdf!
    await act(async () => { await assert.rejects(original.text(1), { name: 'AbortError' }) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(state().snapshot?.id, 'new-host-document')
    assert.equal(state().snapshot?.revision, 0, 'the prior Host revision does not override a fresh Host identity')
    assert.notEqual(state().pdf, original)
    assert.equal(state().documentReady(), true)
    assert.deepEqual(failed, [])
  })
})

test('document ID recovery rejects a snapshot for a different file', async () => {
  await withDocument(async ({ options, state, render, failed }) => {
    options.api.native.text = async () => { throw Object.assign(new Error('old baseline'), { code: 'pdf/stale-reader' }) }
    options.api.refresh = async () => ({ ...makeSnapshot('foreign-document'), path: '/tmp/another.pdf' })
    await render(options)
    await act(async () => { await assert.rejects(state().pdf!.text(1), { name: 'AbortError' }) })
    assert.equal(state().snapshot?.id, 'doc-1')
    assert.equal(state().documentReady(), false)
    assert.ok(failed.some(message => message.includes('different document')))
  })
})

test('a superseded open cannot claim the new display owner', async () => {
  await withDocument(async ({ options, state, render, loaded }) => {
    let resolveOld!: (snapshot: WorkspaceSnapshot) => void
    const old = new Promise<WorkspaceSnapshot>(resolve => { resolveOld = resolve })
    options.api.open = async (_session, address) => address === options.resourceAddress ? old : makeSnapshot('doc-2', 'source-2')
    await render(options)
    await render({ ...options, resourceAddress: 'file:///tmp/next.pdf',
      content: { ...options.content, revision: 2 } })
    await act(async () => { resolveOld(makeSnapshot('doc-old')); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(state().snapshot?.id, 'doc-2')
    assert.ok(loaded.includes('source-2'))
    assert.ok(!loaded.includes('source-1'))
  })
})

test('open failure belongs to the current owner and is not reported as loaded', async () => {
  await withDocument(async ({ options, state, render, loaded, failed }) => {
    options.api.open = async () => { throw new Error('cannot open') }
    await render(options)
    assert.equal(state().snapshot, null)
    assert.deepEqual(loaded, [])
    assert.ok(failed.some(message => message.includes('cannot open')))
    assert.ok(failed.includes('failed'))
  })
})

test('commands wait for a same-resource refresh to publish its replacement display owner', async () => {
  await withDocument(async ({ options, state, render }) => {
    await render(options)
    const first = await state().waitForReady()
    assert.equal(typeof first, 'number')
    let finish!: (snapshot: WorkspaceSnapshot) => void
    options.api.open = () => new Promise(resolve => { finish = resolve })
    await render({ ...options, content: { ...options.content, revision: 2 } })
    assert.ok(state().snapshot)
    assert.ok(state().pdf, 'the last rendered PDF stays visible while its replacement opens')
    assert.equal(state().documentReady(), false)
    let settled = false
    const readiness = state().waitForReady()
    assert.equal(state().waitForReady(), readiness, 'one resource shares one readiness wait instead of accumulating callbacks')
    const waiting = readiness.then(token => { settled = true; return token })
    await Promise.resolve()
    assert.equal(settled, false)
    await act(async () => { finish({ ...makeSnapshot('doc-1'), revision: 2 }); await Promise.resolve() })
    const replacement = await waiting
    assert.equal(typeof replacement, 'number')
    assert.notEqual(replacement, first)
    assert.equal(state().documentReady(), true)
    assert.equal(await state().waitForReady(), replacement)
  })
})

for (const boundary of ['resource', 'session', 'api', 'tab'] as const) {
  test(`a pending ready command cannot cross the ${boundary} ownership boundary`, async () => {
    await withDocument(async ({ options, state, render }) => {
      let finishOld!: (snapshot: WorkspaceSnapshot) => void
      options.api.open = () => new Promise(resolve => { finishOld = resolve })
      await render(options)
      const waitOld = state().waitForReady
      const waiting = waitOld()
      const nextApi = { ...options.api, open: async () => makeSnapshot('replacement') }
      const next = { ...options,
        ...(boundary === 'resource' ? { resourceAddress: 'file:///tmp/next.pdf' } : {}),
        ...(boundary === 'session' ? { sessionId: 'chat-2' } : {}),
        ...(boundary === 'api' ? { api: nextApi } : {}),
        ...(boundary === 'tab' ? { tabSignal: new AbortController().signal } : {}),
      }
      if (boundary !== 'api') options.api.open = nextApi.open
      await render(next)
      assert.equal(await waiting, false)
      assert.equal(await waitOld(), false, 'an old callback cannot claim a new resource owner')
      await act(async () => { finishOld(makeSnapshot('stale')); await Promise.resolve() })
      assert.equal(state().snapshot?.id, 'replacement')
      assert.equal(typeof await state().waitForReady(), 'number')
    })
  })
}

test('tab abort and Reader unmount settle pending commands even when the carrier never replies', async () => {
  for (const boundary of ['abort', 'unmount'] as const) {
    await withDocument(async ({ options, state, render, unmount }) => {
      options.api.open = () => new Promise(() => {})
      const tab = new AbortController()
      await render({ ...options, tabSignal: tab.signal })
      const wait = state().waitForReady
      const waiting = wait()
      if (boundary === 'abort') tab.abort()
      else await unmount()
      assert.equal(await waiting, false)
      assert.equal(await wait(), false)
    })
  }
})

test('an open failure settles pending commands and a later refresh can recover', async () => {
  await withDocument(async ({ options, state, render, failed }) => {
    let reject!: (error: Error) => void
    options.api.open = () => new Promise((_resolve, fail) => { reject = fail })
    await render(options)
    const waiting = state().waitForReady()
    await act(async () => { reject(new Error('open unavailable')); await Promise.resolve() })
    assert.equal(await waiting, false)
    assert.equal(await state().waitForReady(), false)
    assert.ok(failed.some(message => message.includes('open unavailable')))
    options.api.open = async () => makeSnapshot('recovered')
    await render({ ...options, content: { ...options.content, revision: 2 } })
    assert.equal(typeof await state().waitForReady(), 'number')
    assert.equal(state().snapshot?.id, 'recovered')
  })
})

test('a native document initialization failure settles waiting commands', async () => {
  await withDocument(async ({ options, state, render, failed }) => {
    let finish!: (snapshot: WorkspaceSnapshot) => void
    options.api.open = () => new Promise(resolve => { finish = resolve })
    await render(options)
    const waiting = state().waitForReady()
    const snapshot = makeSnapshot('native-failure')
    Object.defineProperty(snapshot.document, 'pageCount', { get() { throw new Error('native init failed') } })
    await act(async () => { finish(snapshot); await Promise.resolve() })
    assert.equal(await waiting, false)
    assert.equal(state().documentReady(), false)
    assert.ok(failed.some(message => message.includes('native init failed')))
  })
})
