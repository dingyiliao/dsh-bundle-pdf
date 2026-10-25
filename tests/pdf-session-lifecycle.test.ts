import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfSessionLifecycle, type PdfSessionOwner } from '../src/client/pdf-session-lifecycle.ts'
import type { WorkspaceSnapshot } from '../src/shared/contracts.ts'

const address = (sessionId: string, file = 'paper.pdf') => `dsh-resource://file/session/${sessionId}//books/${file}`
const snapshot = (id: string) => ({ id }) as WorkspaceSnapshot
function observable<Value>(initial: Value) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: Value) { value = next; for (const listener of [...listeners]) listener() },
    get listenerCount() { return listeners.size },
  }
}
type Tab = { sessionId: string; tabId: string; kind: string; contentId: string }
type Released = { sessionId: string; id: string | undefined; referenceId: string }
function fixture(initialTabs: Tab[] = []) {
  const session = observable<{ key: string | undefined }>({ key: 'container-a' })
  const mounted = observable<string | undefined>('container-a')
  const tabs = observable<readonly Tab[]>(initialTabs)
  const plugin = new AbortController()
  const opened: Array<{ sessionId: string; address: string; signal?: AbortSignal; referenceId?: string }> = []
  const closedTabs: string[] = []
  const released: Released[] = []
  const errors: unknown[] = []
  let openImpl = async (_sessionId: string, _address: string) => snapshot(`workspace-${opened.length}`)
  let releaseImpl = async (_sessionId: string, _id: string | undefined, _referenceId: string) => {}
  let closeImpl = (tabId: string) => {
    closedTabs.push(tabId)
    tabs.set(tabs.getSnapshot().filter(tab => !(tab.sessionId === mounted.getSnapshot() && tab.tabId === tabId)))
  }
  const lifecycle = createPdfSessionLifecycle({
    currentSession: session,
    sidebar: { mounted, openTabs: tabs, close(tabId) { closeImpl(tabId) } },
    api: {
      open(sessionId, requestedAddress, signal, referenceId) {
        opened.push({ sessionId, address: requestedAddress, signal, referenceId })
        return openImpl(sessionId, requestedAddress)
      },
      async release(sessionId, id, referenceId) {
        released.push({ sessionId, id, referenceId })
        await releaseImpl(sessionId, id, referenceId)
      },
    },
    signal: plugin.signal,
    onError(error) { errors.push(error) },
  })
  return { session, mounted, tabs, plugin, lifecycle, opened, closedTabs, released, errors,
    setOpen(fn: typeof openImpl) { openImpl = fn }, setRelease(fn: typeof releaseImpl) { releaseImpl = fn },
    setClose(fn: typeof closeImpl) { closeImpl = fn }, switchTo(key: string | undefined) { session.set({ key }) } }
}
function occurrence(containerSessionId = 'container-a', tabId = 'tab-1', resourceSessionId = containerSessionId,
  resourceAddress = address(resourceSessionId)) {
  const controller = new AbortController()
  const closes: string[] = []
  const owner: PdfSessionOwner = { containerSessionId, resourceSessionId, tabId, resourceAddress, signal: controller.signal,
    close() { closes.push(resourceAddress); controller.abort() } }
  return { owner, controller, closes }
}
function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(accept => { resolve = accept })
  return { promise, resolve }
}
const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }

test('Session switches release each view reference of one shared draft, never discard it', async () => {
  const f = fixture()
  f.setOpen(async () => snapshot('shared-draft'))
  const first = occurrence('container-a', 'one', 'resource-x')
  const second = occurrence('container-a', 'two', 'resource-x')
  f.lifecycle.register(first.owner); f.lifecycle.register(second.owner)
  await f.lifecycle.open(first.owner, 'resource-x', first.owner.resourceAddress)
  await f.lifecycle.open(second.owner, 'resource-x', second.owner.resourceAddress)
  assert.equal(f.opened[0]?.signal, f.plugin.signal)
  assert.ok(f.opened[0]?.referenceId)
  assert.notEqual(f.opened[0]?.referenceId, f.opened[1]?.referenceId)
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(first.closes, [first.owner.resourceAddress])
  assert.deepEqual(second.closes, [second.owner.resourceAddress])
  assert.deepEqual(f.released, f.opened.map(open => ({ sessionId: 'resource-x', id: undefined, referenceId: open.referenceId! })))
  f.lifecycle.dispose()
})

test('rerendering keeps an idempotent reference until the actual tab occurrence closes', async () => {
  const f = fixture()
  f.setOpen(async () => snapshot('shared-draft'))
  const tab = occurrence()
  f.lifecycle.register(tab.owner)
  await f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  f.lifecycle.register({ ...tab.owner })
  await f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  assert.equal(f.opened[0]?.referenceId, f.opened[1]?.referenceId)
  assert.deepEqual(f.released, [], 'React body remount must not release the occurrence')
  tab.controller.abort()
  await f.lifecycle.drain()
  assert.deepEqual(f.released, [{ sessionId: 'container-a', id: undefined, referenceId: f.opened[0]!.referenceId! }])
  f.lifecycle.dispose()
})

test('closing a pending UI adoption releases its token before the delayed reply', async () => {
  const f = fixture()
  const pending = deferred<WorkspaceSnapshot>()
  f.setOpen(() => pending.promise)
  const tab = occurrence()
  const opening = f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  await tick()
  tab.controller.abort()
  const cleaning = f.lifecycle.drain()
  await cleaning
  assert.deepEqual(f.released, [{ sessionId: 'container-a', id: undefined, referenceId: f.opened[0]!.referenceId! }])
  pending.resolve(snapshot('late-workspace'))
  await assert.rejects(opening, { name: 'AbortError' })
  assert.equal(f.released.length, 1)
  f.lifecycle.dispose()
})

test('failed releases retry before new opens with the same reference identity', async () => {
  const f = fixture()
  const old = occurrence()
  await f.lifecycle.open(old.owner, 'container-a', old.owner.resourceAddress)
  let attempts = 0
  const failure = new Error('temporary connection failure')
  f.setRelease(async () => { if (++attempts === 1) throw failure })
  f.switchTo('container-b')
  await assert.rejects(f.lifecycle.drain(), error => error === failure)
  assert.deepEqual(f.errors, [failure])
  const next = occurrence('container-b')
  assert.equal((await f.lifecycle.open(next.owner, 'container-b', next.owner.resourceAddress)).id, 'workspace-2')
  assert.equal(attempts, 2)
  assert.deepEqual(f.released[0], f.released[1])
  f.lifecycle.dispose()
})

test('unvisited PDF tabs close only in their mounted Session without touching unseen drafts', async () => {
  const pdf = { sessionId: 'container-a', tabId: 'unvisited', kind: 'text', contentId: address('resource-x') }
  const f = fixture([pdf,
    { sessionId: 'container-a', tabId: 'other', kind: 'text', contentId: address('container-a', 'notes.txt') },
    { sessionId: 'container-a', tabId: 'external', kind: 'browser', contentId: address('container-a') },
    { sessionId: 'container-a', tabId: 'malformed', kind: 'text', contentId: 'not-a-session-address' }])
  f.mounted.set('container-b'); f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(f.closedTabs, [])
  f.mounted.set('container-a')
  await f.lifecycle.drain()
  assert.deepEqual(f.closedTabs, ['unvisited'])
  assert.deepEqual(f.released, [], 'unopened tabs have no Host view reference')
  assert.equal(f.tabs.getSnapshot().length, 3)
  f.lifecycle.dispose()
})

test('a restored tab id with different content is not closed instead of the retired tab', async () => {
  const original = { sessionId: 'container-a', tabId: 'reused', kind: 'text', contentId: address('resource-x', 'old.pdf') }
  const restored = { ...original, contentId: address('resource-x', 'new.pdf') }
  const f = fixture([original])
  f.mounted.set('container-b'); f.switchTo('container-b'); f.tabs.set([restored])
  await f.lifecycle.drain()
  f.mounted.set('container-a')
  await f.lifecycle.drain()
  assert.deepEqual(f.closedTabs, [])
  assert.deepEqual(f.tabs.getSnapshot(), [restored])
  assert.deepEqual(f.released, [])
  f.lifecycle.dispose()
})

test('manual close releases only its lease and restored occurrences receive new leases', async () => {
  const f = fixture()
  f.setOpen(async () => snapshot('shared-draft'))
  const old = occurrence()
  await f.lifecycle.open(old.owner, 'container-a', old.owner.resourceAddress)
  old.controller.abort()
  await f.lifecycle.drain()
  const replacement = occurrence()
  await f.lifecycle.open(replacement.owner, 'container-a', replacement.owner.resourceAddress)
  assert.notEqual(f.opened[0]?.referenceId, f.opened[1]?.referenceId)
  assert.equal(f.released.length, 1)
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(old.closes, [])
  assert.deepEqual(replacement.closes, [replacement.owner.resourceAddress])
  assert.equal(f.released.length, 2)
  f.lifecycle.dispose()
})

test('navigation retires the previous document and keeps terminal cleanup Sessions and close metadata', async () => {
  const f = fixture()
  const tab = occurrence('container-a', 'same-tab', 'resource-x')
  await f.lifecycle.open(tab.owner, 'resource-x', tab.owner.resourceAddress)
  const newAddress = address('resource-y', 'new.pdf')
  const latestClose: string[] = []
  const updated: PdfSessionOwner = { ...tab.owner, resourceSessionId: 'resource-y', resourceAddress: newAddress,
    close() { latestClose.push(newAddress); tab.controller.abort() } }
  f.lifecycle.register(updated)
  await f.lifecycle.open(updated, 'resource-y', newAddress)
  assert.throws(() => f.lifecycle.register({ ...updated, tabId: 'another-tab' }), /cannot change its container Session or tab identity/)
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(latestClose, [newAddress])
  assert.deepEqual(f.released, [
    { sessionId: 'resource-x', id: 'workspace-1', referenceId: f.opened[0]!.referenceId! },
    { sessionId: 'resource-x', id: undefined, referenceId: f.opened[0]!.referenceId! },
    { sessionId: 'resource-y', id: undefined, referenceId: f.opened[0]!.referenceId! },
  ])
  f.lifecycle.dispose()
})

test('A remains referenced while B loads, then only A is released after B is adopted', async () => {
  const f = fixture()
  const tab = occurrence()
  f.setOpen(async () => snapshot('document-a'))
  await f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  const next = { ...tab.owner, resourceAddress: address('container-a', 'b.pdf') }
  f.lifecycle.register(next)
  const pending = deferred<WorkspaceSnapshot>()
  f.setOpen(() => pending.promise)
  const opening = f.lifecycle.open(next, 'container-a', next.resourceAddress)
  await tick()
  assert.deepEqual(f.released, [], 'keep the displayed document during replacement loading')
  pending.resolve(snapshot('document-b'))
  assert.equal((await opening).id, 'document-b')
  await tick()
  assert.deepEqual(f.released, [{ sessionId: 'container-a', id: 'document-a', referenceId: f.opened[0]!.referenceId! }])
  await f.lifecycle.dispose()
})

test('a late A response after B adoption cannot reactivate A or release B', async () => {
  const f = fixture()
  const tab = occurrence()
  const pendingA = deferred<WorkspaceSnapshot>()
  f.setOpen(() => pendingA.promise)
  const openingA = f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  await tick()
  const next = { ...tab.owner, resourceAddress: address('container-a', 'b.pdf') }
  f.lifecycle.register(next)
  f.setOpen(async () => snapshot('document-b'))
  await f.lifecycle.open(next, 'container-a', next.resourceAddress)
  pendingA.resolve(snapshot('document-a'))
  await assert.rejects(openingA, /navigation was superseded/)
  await tick()
  assert.deepEqual(f.released, [{ sessionId: 'container-a', id: 'document-a', referenceId: f.opened[0]!.referenceId! }])
  await assert.rejects(f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress), /navigation was superseded/)
  assert.equal(f.opened.length, 2, 'an old render must not dispatch another open')
  await f.lifecycle.dispose()
})

test('canonical address aliases resolving to the same document do not release its reference', async () => {
  const f = fixture()
  const tab = occurrence()
  f.setOpen(async () => snapshot('same-canonical-document'))
  await f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  const alias = { ...tab.owner, resourceAddress: address('container-a', 'alias.pdf') }
  f.lifecycle.register(alias)
  await f.lifecycle.open(alias, 'container-a', alias.resourceAddress)
  await tick()
  assert.deepEqual(f.released, [])
  tab.controller.abort()
  await f.lifecycle.drain()
  assert.deepEqual(f.released, [{ sessionId: 'container-a', id: undefined, referenceId: f.opened[0]!.referenceId! }])
  await f.lifecycle.dispose()
})

test('rapid A to B to A waits for the old A release before reacquiring A', async () => {
  const f = fixture()
  const tab = occurrence()
  f.setOpen(async (_sessionId, requestedAddress) => snapshot(requestedAddress.endsWith('b.pdf') ? 'document-b' : 'document-a'))
  await f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  const releasedA = deferred<void>()
  f.setRelease(async (_sessionId, id) => { if (id === 'document-a') await releasedA.promise })
  const next = { ...tab.owner, resourceAddress: address('container-a', 'b.pdf') }
  f.lifecycle.register(next)
  await f.lifecycle.open(next, 'container-a', next.resourceAddress)
  await tick()
  assert.equal(f.released[0]?.id, 'document-a')
  f.lifecycle.register(tab.owner)
  const returning = f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  await tick()
  assert.equal(f.opened.length, 2, 'do not reacquire while the previous release is in flight')
  releasedA.resolve()
  assert.equal((await returning).id, 'document-a')
  await tick()
  assert.equal(f.opened.length, 3)
  assert.deepEqual(f.released.map(release => release.id), ['document-a', 'document-b'])
  await f.lifecycle.dispose()
})

test('replacement navigation failure retains the previously adopted document', async () => {
  const f = fixture()
  const tab = occurrence()
  f.setOpen(async () => snapshot('document-a'))
  await f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  const next = { ...tab.owner, resourceAddress: address('container-a', 'b.pdf') }
  f.lifecycle.register(next)
  f.setOpen(async () => { throw new Error('B cannot be opened') })
  await assert.rejects(f.lifecycle.open(next, 'container-a', next.resourceAddress), /B cannot be opened/)
  await tick()
  assert.deepEqual(f.released, [])
  await f.lifecycle.dispose()
})

test('failed old-document retirement reports the error and retries without releasing the adopted document', async () => {
  const f = fixture()
  const tab = occurrence()
  f.setOpen(async (_sessionId, requestedAddress) => snapshot(requestedAddress.endsWith('b.pdf') ? 'document-b' : 'document-a'))
  await f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  const failure = new Error('temporary reference release failure')
  let attempts = 0
  f.setRelease(async (_sessionId, id) => { if (id === 'document-a' && ++attempts === 1) throw failure })
  const next = { ...tab.owner, resourceAddress: address('container-a', 'b.pdf') }
  f.lifecycle.register(next)
  assert.equal((await f.lifecycle.open(next, 'container-a', next.resourceAddress)).id, 'document-b')
  await tick()
  assert.deepEqual(f.errors, [failure])
  assert.deepEqual(f.released.map(release => release.id), ['document-a'])

  assert.equal((await f.lifecycle.open(next, 'container-a', next.resourceAddress)).id, 'document-b')
  await tick()
  assert.equal(attempts, 2)
  assert.deepEqual(f.released[0], f.released[1], 'retry the retained identity using the same reference')
  assert.deepEqual(f.errors, [failure], 'successful retry must not report another failure')
  await f.lifecycle.dispose()
  assert.deepEqual(f.released.map(release => release.id), ['document-a', 'document-a', undefined])
})

test('resource authorization, caller cancellation and plugin lifetime gate acquisition', async () => {
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
})

test('late mounted departing tabs close without acquiring Host drafts', async () => {
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

test('registered tabs found in unvisited inventory close once', async () => {
  const tab = occurrence('container-a', 'registered', 'resource-x')
  const f = fixture([{ sessionId: 'container-a', tabId: 'registered', kind: 'text', contentId: tab.owner.resourceAddress }])
  await f.lifecycle.open(tab.owner, 'resource-x', tab.owner.resourceAddress)
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(tab.closes, [tab.owner.resourceAddress])
  assert.deepEqual(f.closedTabs, ['registered'])
  assert.equal(f.released.length, 1)
  f.lifecycle.dispose()
})

test('pending inventory remains retired when its body mounts after returning', async () => {
  const tab = occurrence('container-a', 'pending', 'resource-x')
  const f = fixture([{ sessionId: 'container-a', tabId: 'pending', kind: 'text', contentId: tab.owner.resourceAddress }])
  f.mounted.set('container-b'); f.switchTo('container-b'); f.switchTo('container-a')
  f.lifecycle.register(tab.owner)
  await f.lifecycle.drain()
  assert.deepEqual(tab.closes, [tab.owner.resourceAddress])
  f.mounted.set('container-a')
  await f.lifecycle.drain()
  assert.deepEqual(f.closedTabs, ['pending'])
  assert.deepEqual(f.released, [])
  f.lifecycle.dispose()
})

test('a throwing occurrence close is reported without suppressing view release', async () => {
  const f = fixture()
  const tab = occurrence()
  const failure = new Error('reader failed to close')
  const faulty = { ...tab.owner, close() { throw failure } }
  await f.lifecycle.open(faulty, 'container-a', faulty.resourceAddress)
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(f.errors, [failure])
  assert.equal(f.released.length, 1)
  f.lifecycle.dispose()
})

test('tab-close errors are reported without discarding any data', async () => {
  const pdf = { sessionId: 'container-a', tabId: 'unvisited', kind: 'text', contentId: address('container-a') }
  const f = fixture([pdf])
  const failure = new Error('sidebar rejected close')
  f.setClose(() => { throw failure })
  f.switchTo('container-b')
  await f.lifecycle.drain()
  assert.deepEqual(f.errors, [failure])
  assert.deepEqual(f.tabs.getSnapshot(), [pdf])
  assert.deepEqual(f.released, [])
  f.lifecycle.dispose()
})

test('Client-only disposal releases unknown pending references without waiting for replies', async () => {
  const f = fixture()
  const tab = occurrence()
  const pending = deferred<WorkspaceSnapshot>()
  f.setOpen(() => pending.promise)
  const opening = f.lifecycle.open(tab.owner, 'container-a', tab.owner.resourceAddress)
  await tick()
  await f.lifecycle.dispose()
  assert.deepEqual(f.released, [{ sessionId: 'container-a', id: undefined, referenceId: f.opened[0]!.referenceId! }])
  pending.resolve(snapshot('late-workspace'))
  await assert.rejects(opening, { name: 'AbortError' })
  await tick()
  assert.deepEqual(tab.closes, [])
  assert.equal(f.released.length, 1)
})

test('a failed open reply still releases its resource Session reference on close', async () => {
  const f = fixture()
  const failure = new Error('response lost after Host acquired reference')
  f.setOpen(async () => { throw failure })
  const tab = occurrence('container-a', 'lost', 'resource-x')
  await assert.rejects(f.lifecycle.open(tab.owner, 'resource-x', tab.owner.resourceAddress), error => error === failure)
  tab.controller.abort()
  await f.lifecycle.drain()
  assert.deepEqual(f.released, [{ sessionId: 'resource-x', id: undefined, referenceId: f.opened[0]!.referenceId! }])
  await f.lifecycle.dispose()
})

test('a never-settled old open does not prevent the next Session from opening', async () => {
  const f = fixture()
  const pending = deferred<WorkspaceSnapshot>()
  f.setOpen(async sessionId => sessionId === 'container-a' ? pending.promise : snapshot('new-session-document'))
  const old = occurrence()
  const opening = f.lifecycle.open(old.owner, 'container-a', old.owner.resourceAddress)
  await tick()
  f.switchTo('container-b')
  const next = occurrence('container-b')
  assert.equal((await f.lifecycle.open(next.owner, 'container-b', next.owner.resourceAddress)).id, 'new-session-document')
  assert.equal(f.released[0]?.id, undefined)
  pending.resolve(snapshot('late-old-document'))
  await assert.rejects(opening, { name: 'AbortError' })
  await f.lifecycle.dispose()
})
