import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfSessionLifecycle, type PdfSessionOwner } from '../src/client/pdf-session-lifecycle.ts'
import type { WorkspaceSnapshot } from '../src/shared/contracts.ts'

const address = (sessionId: string, file = 'paper.pdf') =>
  `dsh-resource://file/session/${sessionId}//books/${file}`
const snapshot = (id: string) => ({ id }) as WorkspaceSnapshot

function observable<Value>(initial: Value) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: Value) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    get listenerCount() { return listeners.size },
  }
}

type Tab = { sessionId: string; tabId: string; kind: string; contentId: string }

function fixture(initialTabs: Tab[] = []) {
  const session = observable<{ key: string | undefined }>({ key: 'container-a' })
  const mounted = observable<string | undefined>('container-a')
  const tabs = observable<readonly Tab[]>(initialTabs)
  const plugin = new AbortController()
  const opened: Array<{ sessionId: string; address: string; signal?: AbortSignal }> = []
  const closedTabs: string[] = []
  const discardedIds: Array<{ sessionId: string; ids: string[] }> = []
  const discardedAddresses: Array<{ sessionId: string; addresses: string[] }> = []
  const errors: unknown[] = []
  let openImpl = async (_sessionId: string, _address: string) => snapshot(`workspace-${opened.length}`)
  let discardIdsImpl = async (_sessionId: string, _ids: readonly string[]) => {}
  let discardAddressesImpl = async (_sessionId: string, _addresses: readonly string[]) => {}
  let closeImpl = (tabId: string) => {
    closedTabs.push(tabId)
    tabs.set(tabs.getSnapshot().filter(tab => !(tab.sessionId === mounted.getSnapshot() && tab.tabId === tabId)))
  }
  const lifecycle = createPdfSessionLifecycle({
    currentSession: session,
    sidebar: { mounted, openTabs: tabs, close(tabId) { closeImpl(tabId) } },
    api: {
      open(sessionId, requestedAddress, signal) {
        opened.push({ sessionId, address: requestedAddress, signal })
        return openImpl(sessionId, requestedAddress)
      },
      async discardMany(sessionId, ids) {
        discardedIds.push({ sessionId, ids: [...ids] })
        await discardIdsImpl(sessionId, ids)
      },
      async discardAddresses(sessionId, addresses) {
        discardedAddresses.push({ sessionId, addresses: [...addresses] })
        await discardAddressesImpl(sessionId, addresses)
      },
    },
    signal: plugin.signal,
    onError(error) { errors.push(error) },
  })
  return {
    session, mounted, tabs, plugin, lifecycle, opened, closedTabs, discardedIds, discardedAddresses, errors,
    setOpen(fn: typeof openImpl) { openImpl = fn },
    setDiscardIds(fn: typeof discardIdsImpl) { discardIdsImpl = fn },
    setDiscardAddresses(fn: typeof discardAddressesImpl) { discardAddressesImpl = fn },
    setClose(fn: typeof closeImpl) { closeImpl = fn },
    switchTo(key: string | undefined) { session.set({ key }) },
  }
}

function occurrence(containerSessionId = 'container-a', tabId = 'tab-1', resourceSessionId = containerSessionId,
  resourceAddress = address(resourceSessionId)) {
  const controller = new AbortController()
  const closes: string[] = []
  const owner: PdfSessionOwner = {
    containerSessionId, resourceSessionId, tabId, resourceAddress, signal: controller.signal,
    close() { closes.push(resourceAddress); controller.abort() },
  }
  return { owner, controller, closes }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }

test('switching a Session closes its occurrences and discards each resource Session workspace once', async () => {
  const f = fixture()
  const first = occurrence('container-a', 'one', 'resource-x')
  const second = occurrence('container-a', 'two', 'resource-x')
  f.lifecycle.register(first.owner)
  f.lifecycle.register(second.owner)
  assert.equal((await f.lifecycle.open(first.owner, 'resource-x', first.owner.resourceAddress)).id, 'workspace-1')
  assert.equal((await f.lifecycle.open(second.owner, 'resource-x', second.owner.resourceAddress)).id, 'workspace-2')
  assert.equal(f.opened[0]?.signal, f.plugin.signal)

  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(first.closes, [first.owner.resourceAddress])
  assert.deepEqual(second.closes, [second.owner.resourceAddress])
  assert.deepEqual(f.discardedIds, [{ sessionId: 'resource-x', ids: ['workspace-1', 'workspace-2'] }])
  assert.deepEqual(f.discardedAddresses, [])
  f.lifecycle.dispose()
})

test('a late open is included in Session cleanup even though its caller is already closed', async () => {
  const f = fixture()
  const pending = deferred<WorkspaceSnapshot>()
  f.setOpen(() => pending.promise)
  const tab = occurrence()
  f.lifecycle.register(tab.owner)
  const opening = f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  await tick()
  assert.equal(f.opened.length, 1)
  f.switchTo('container-b')
  const cleaning = f.lifecycle.drain()
  await tick()
  assert.deepEqual(f.discardedIds, [])
  pending.resolve(snapshot('late-workspace'))
  await assert.rejects(opening, { name: 'AbortError' })
  await cleaning
  assert.deepEqual(f.discardedIds, [{ sessionId: 'container-a', ids: ['late-workspace'] }])
  f.lifecycle.dispose()
})

test('a failed discard is retried before a new Session is permitted to open', async () => {
  const f = fixture()
  const old = occurrence()
  const next = occurrence('container-b')
  f.lifecycle.register(old.owner)
  await f.lifecycle.open(old.owner, 'container-a', old.owner.resourceAddress)
  let attempts = 0
  const failure = new Error('temporary storage failure')
  f.setDiscardIds(async () => { if (++attempts === 1) throw failure })

  f.switchTo('container-b')
  await assert.rejects(f.lifecycle.drain(), error => error === failure)
  assert.deepEqual(f.errors, [failure])
  assert.equal(f.opened.length, 1)
  assert.equal((await f.lifecycle.open(next.owner, 'container-b', next.owner.resourceAddress)).id, 'workspace-2')
  assert.equal(attempts, 2)
  assert.equal(f.opened.length, 2)
  f.lifecycle.dispose()
})

test('unvisited PDF tabs are closed only while their own Session is mounted', async () => {
  const pdf = { sessionId: 'container-a', tabId: 'unvisited', kind: 'text', contentId: address('resource-x') }
  const f = fixture([pdf, { sessionId: 'container-a', tabId: 'other', kind: 'text', contentId: address('container-a', 'notes.txt') },
    { sessionId: 'container-a', tabId: 'external', kind: 'browser', contentId: address('container-a') },
    { sessionId: 'container-a', tabId: 'malformed', kind: 'text', contentId: 'not-a-session-address' }])
  f.mounted.set('container-b')
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(f.closedTabs, [])
  assert.equal(f.tabs.getSnapshot().length, 4)

  f.mounted.set('container-a')
  await f.lifecycle.drain()
  assert.deepEqual(f.closedTabs, ['unvisited'])
  assert.deepEqual(f.discardedAddresses, [{ sessionId: 'resource-x', addresses: [pdf.contentId] }])
  assert.equal(f.tabs.getSnapshot().length, 3)
  f.lifecycle.dispose()
})

test('a restored tab id with different content is never closed in place of the old tab', async () => {
  const original = { sessionId: 'container-a', tabId: 'reused', kind: 'text', contentId: address('resource-x', 'old.pdf') }
  const restored = { ...original, contentId: address('resource-x', 'new.pdf') }
  const f = fixture([original])
  f.mounted.set('container-b')
  f.switchTo('container-b')
  f.tabs.set([restored])
  await f.lifecycle.drain()
  f.mounted.set('container-a')
  await f.lifecycle.drain()
  assert.deepEqual(f.closedTabs, [])
  assert.deepEqual(f.tabs.getSnapshot(), [restored])
  assert.deepEqual(f.discardedAddresses, [{ sessionId: 'resource-x', addresses: [original.contentId] }])
  f.lifecycle.dispose()
})

test('a manually ended occurrence keeps its draft; a later occurrence with the same tab id is distinct', async () => {
  const f = fixture()
  const old = occurrence()
  f.lifecycle.register(old.owner)
  await f.lifecycle.open(old.owner, 'container-a', old.owner.resourceAddress)
  old.controller.abort()
  await f.lifecycle.drain()
  assert.deepEqual(f.discardedIds, [])

  const replacement = occurrence()
  f.lifecycle.register(replacement.owner)
  await f.lifecycle.open(replacement.owner, 'container-a', replacement.owner.resourceAddress)
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(old.closes, [])
  assert.deepEqual(replacement.closes, [replacement.owner.resourceAddress])
  assert.deepEqual(f.discardedIds, [{ sessionId: 'container-a', ids: ['workspace-2'] }])
  f.lifecycle.dispose()
})

test('re-registering an occurrence refreshes its close metadata without changing its identity', async () => {
  const f = fixture()
  const oldAddress = address('resource-x', 'old.pdf')
  const newAddress = address('resource-y', 'new.pdf')
  const tab = occurrence('container-a', 'same-tab', 'resource-x', oldAddress)
  f.lifecycle.register(tab.owner)
  await f.lifecycle.open(tab.owner, 'resource-x', oldAddress)
  const latestClose: string[] = []
  const updated: PdfSessionOwner = { ...tab.owner, resourceSessionId: 'resource-y', resourceAddress: newAddress,
    close() { latestClose.push(newAddress); tab.controller.abort() } }
  f.lifecycle.register(updated)
  await f.lifecycle.open(tab.owner, 'resource-x', oldAddress)
  await f.lifecycle.open(updated, 'resource-y', newAddress)
  const invalid = { ...updated, tabId: 'another-tab' }
  assert.throws(() => f.lifecycle.register(invalid), /cannot change its container Session or tab identity/)
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(tab.closes, [])
  assert.deepEqual(latestClose, [newAddress])
  assert.deepEqual(f.discardedIds, [
    { sessionId: 'resource-x', ids: ['workspace-1', 'workspace-2'] },
    { sessionId: 'resource-y', ids: ['workspace-3'] },
  ])
  f.lifecycle.dispose()
})

test('the caller and plugin lifetimes gate opens without silently replacing the plugin signal', async () => {
  const f = fixture()
  const tab = occurrence()
  await assert.rejects(f.lifecycle.open(tab.owner, 'wrong-session', tab.owner.resourceAddress), /resource Session mismatch/)
  const caller = new AbortController()
  caller.abort(new Error('caller cancelled'))
  await assert.rejects(f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress, caller.signal), /caller cancelled/)
  assert.equal(f.opened.length, 0)
  const ended = occurrence('container-a', 'ended')
  ended.controller.abort()
  assert.throws(() => f.lifecycle.register(ended.owner), { name: 'AbortError' })
  f.plugin.abort()
  assert.equal(f.session.listenerCount, 0)
  assert.equal(f.mounted.listenerCount, 0)
  assert.equal(f.tabs.listenerCount, 0)
  await assert.rejects(f.lifecycle.drain(), { name: 'AbortError' })
  await assert.rejects(f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress), { name: 'AbortError' })
  f.lifecycle.dispose()
})

test('an address cleanup failure retains its exact source address for retry', async () => {
  const pdf = { sessionId: 'container-a', tabId: 'closed', kind: 'text', contentId: address('resource-x') }
  const f = fixture([pdf])
  const failure = new Error('address discard temporarily unavailable')
  let attempts = 0
  f.setDiscardAddresses(async () => { if (++attempts === 1) throw failure })
  f.switchTo('container-b')
  await assert.rejects(f.lifecycle.drain(), error => error === failure)
  assert.deepEqual(f.errors, [failure])
  await f.lifecycle.drain()
  assert.deepEqual(f.discardedAddresses, [
    { sessionId: 'resource-x', addresses: [pdf.contentId] },
    { sessionId: 'resource-x', addresses: [pdf.contentId] },
  ])
  f.lifecycle.dispose()
})

test('a tab mounted after its Session departed is immediately closed and not opened', async () => {
  const f = fixture()
  f.switchTo('container-b')
  const late = occurrence('container-a', 'late')
  f.lifecycle.register(late.owner)
  await f.lifecycle.drain()
  assert.deepEqual(late.closes, [late.owner.resourceAddress])
  await assert.rejects(f.lifecycle.open(late.owner, 'container-a', late.owner.resourceAddress), { name: 'AbortError' })
  assert.deepEqual(f.opened, [])
  f.lifecycle.dispose()
})

test('a registered tab also found in the unvisited inventory is closed just once', async () => {
  const tab = occurrence('container-a', 'registered', 'resource-x')
  const f = fixture([{ sessionId: 'container-a', tabId: 'registered', kind: 'text', contentId: tab.owner.resourceAddress }])
  f.lifecycle.register(tab.owner)
  await f.lifecycle.open(tab.owner, 'resource-x', tab.owner.resourceAddress)
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(tab.closes, [tab.owner.resourceAddress])
  assert.deepEqual(f.closedTabs, ['registered'])
  assert.deepEqual(f.discardedIds, [{ sessionId: 'resource-x', ids: ['workspace-1'] }])
  assert.deepEqual(f.discardedAddresses, [{ sessionId: 'resource-x', addresses: [tab.owner.resourceAddress] }])
  f.lifecycle.dispose()
})

test('a pending tab is still retired if its body mounts after its Session returns', async () => {
  const tab = occurrence('container-a', 'pending', 'resource-x')
  const f = fixture([{ sessionId: 'container-a', tabId: 'pending', kind: 'text', contentId: tab.owner.resourceAddress }])
  f.mounted.set('container-b')
  f.switchTo('container-b')
  f.switchTo('container-a')
  f.lifecycle.register(tab.owner)
  await f.lifecycle.drain()
  assert.deepEqual(tab.closes, [tab.owner.resourceAddress])
  f.mounted.set('container-a')
  await f.lifecycle.drain()
  assert.deepEqual(f.closedTabs, ['pending'])
  assert.deepEqual(f.discardedAddresses, [{ sessionId: 'resource-x', addresses: [tab.owner.resourceAddress] }])
  f.lifecycle.dispose()
})

test('a throwing occurrence close is reported without suppressing workspace discard', async () => {
  const f = fixture()
  const tab = occurrence()
  const failure = new Error('reader failed to close')
  const faulty: PdfSessionOwner = { ...tab.owner, close() { throw failure } }
  f.lifecycle.register(faulty)
  await f.lifecycle.open(faulty, 'container-a', faulty.resourceAddress)
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(f.errors, [failure])
  assert.deepEqual(f.discardedIds, [{ sessionId: 'container-a', ids: ['workspace-1'] }])
  f.lifecycle.dispose()
})

test('a tab close error is reported but does not prevent cleanup', async () => {
  const pdf = { sessionId: 'container-a', tabId: 'unvisited', kind: 'text', contentId: address('container-a') }
  const f = fixture([pdf])
  const failure = new Error('sidebar rejected close')
  f.setClose(() => { throw failure })
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(f.errors, [failure])
  assert.deepEqual(f.tabs.getSnapshot(), [pdf])
  f.lifecycle.dispose()
})
