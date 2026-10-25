import assert from 'node:assert/strict'
import test from 'node:test'
import { createSearchSessions } from '../../../src/modules/search/search-sessions.ts'

type Start = { documentId: string; query: string; options?: { pages: number[]; limit: number } }
type Page = { value: { page: number }; nextCursor?: string | null }
const signal = new AbortController().signal
const input: Start = { documentId: 'document-a', query: 'original' }
const first = async (): Promise<Page> => ({ value: { page: 1 }, nextCursor: 'private-cursor-2' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('search IDs retain immutable arguments and internal progress through completion', async () => {
  const sessions = createSearchSessions<Start>({ prefix: 'rel_' })
  const original: Start = { ...input, options: { pages: [2, 3], limit: 4 } }
  const expected = structuredClone(original)
  const firstPage = await sessions.run('session-a', original, signal, async (args, cursor) => {
    assert.deepEqual(args, expected)
    assert.equal(cursor, undefined)
    args.query = 'changed by step'
    args.options!.pages.push(9)
    return first()
  })
  assert.match(firstPage.searchId, /^rel_[a-f0-9]{12}$/)
  assert.deepEqual(firstPage, { page: 1, searchId: firstPage.searchId, hasMore: true })
  assert.equal(sessions.documentId('session-a', firstPage.searchId), 'document-a')
  original.documentId = 'changed by caller'
  original.query = 'new query'
  original.options!.pages[0] = 8
  const final = await sessions.run('session-a', { searchId: firstPage.searchId }, signal, async (args, cursor) => {
    assert.deepEqual(args, expected)
    assert.equal(cursor, 'private-cursor-2')
    return { value: { page: 2 }, nextCursor: null }
  })
  assert.deepEqual(final, { page: 2, searchId: firstPage.searchId, hasMore: false })
  await assert.rejects(sessions.run('session-a', { searchId: final.searchId }, signal, async () => {
    assert.fail('completed search must not restart')
  }), { code: 'pdf/search-complete' })
  sessions.dispose()
})

test('copied, altered, malformed and wrong-tool IDs cannot claim search state', async () => {
  const sessions = createSearchSessions<Start>({ prefix: 'rel_' })
  const textSessions = createSearchSessions<Start>({ prefix: 'txt_' })
  const page = await sessions.run('session-a', input, signal, first)
  assert.throws(() => sessions.documentId('session-b', page.searchId), { code: 'pdf/unknown-search' })
  await assert.rejects(sessions.run('session-b', { searchId: page.searchId }, signal, first), { code: 'pdf/unknown-search' })
  const last = page.searchId.endsWith('0') ? '1' : '0'
  const altered = `${page.searchId.slice(0, -1)}${last}`
  assert.throws(() => sessions.documentId('session-a', altered), { code: 'pdf/unknown-search' })
  assert.throws(() => sessions.documentId('session-a', 'rel_bad'), { code: 'pdf/invalid-search' })
  assert.throws(() => textSessions.documentId('session-a', page.searchId), { code: 'pdf/invalid-search' })
  await assert.rejects(sessions.run('session-a', { ...input, searchId: page.searchId }, signal, first), {
    code: 'pdf/invalid-search',
  })
  await assert.rejects(sessions.run('session-a', { ...input, documentId: '' }, signal, first), {
    code: 'pdf/invalid-search',
  })
  sessions.dispose()
  textSessions.dispose()
})

test('independent searches and sessions keep separate arguments and progress', async () => {
  const sessions = createSearchSessions<Start>({ prefix: 'txt_' })
  const a = await sessions.run('a', input, signal, first)
  const b = await sessions.run('b', { ...input, query: 'other session' }, signal, first)
  const c = await sessions.run('a', { ...input, query: 'other query' }, signal, first)
  assert.equal(new Set([a.searchId, b.searchId, c.searchId]).size, 3)
  await sessions.run('a', { searchId: a.searchId }, signal, async (args, cursor) => {
    assert.equal(args.query, 'original')
    assert.equal(cursor, 'private-cursor-2')
    return { value: { page: 2 }, nextCursor: 'private-cursor-3' }
  })
  sessions.deleteSession('a')
  assert.throws(() => sessions.documentId('a', a.searchId), { code: 'pdf/unknown-search' })
  assert.throws(() => sessions.documentId('a', c.searchId), { code: 'pdf/unknown-search' })
  await sessions.run('b', { searchId: b.searchId }, signal, async (args, cursor) => {
    assert.equal(args.query, 'other session')
    assert.equal(cursor, 'private-cursor-2')
    return { value: { page: 2 } }
  })
  sessions.dispose()
})

test('a concurrent continuation fails busy and cannot skip a page', async () => {
  const sessions = createSearchSessions<Start>({ prefix: 'rel_' })
  const page = await sessions.run('a', input, signal, first)
  const pending = deferred<Page>()
  const advancing = sessions.run('a', { searchId: page.searchId }, signal, async (_args, cursor) => {
    assert.equal(cursor, 'private-cursor-2')
    return pending.promise
  })
  await assert.rejects(sessions.run('a', { searchId: page.searchId }, signal, first), { code: 'pdf/search-busy' })
  pending.resolve({ value: { page: 2 }, nextCursor: 'private-cursor-3' })
  assert.equal((await advancing).searchId, page.searchId)
  await sessions.run('a', { searchId: page.searchId }, signal, async (_args, cursor) => {
    assert.equal(cursor, 'private-cursor-3')
    return { value: { page: 3 } }
  })
  sessions.dispose()
})

test('failed and cancelled continuations retry the same stored progress', async () => {
  const sessions = createSearchSessions<Start>({ prefix: 'txt_' })
  const page = await sessions.run('a', input, signal, first)
  const failure = new Error('temporary reader failure')
  await assert.rejects(sessions.run('a', { searchId: page.searchId }, signal, async (_args, cursor) => {
    assert.equal(cursor, 'private-cursor-2')
    throw failure
  }), failure)
  const cancelled = new AbortController()
  const reason = new Error('cancelled by caller')
  cancelled.abort(reason)
  await assert.rejects(sessions.run('a', { searchId: page.searchId }, cancelled.signal, async () => {
    assert.fail('already cancelled calls must not invoke the step')
  }), reason)

  const controller = new AbortController()
  const pending = deferred<Page>()
  let settled = false
  const advancing = sessions.run('a', { searchId: page.searchId }, controller.signal, () => pending.promise)
  const rejected = assert.rejects(advancing, reason).then(() => { settled = true })
  controller.abort(reason)
  await Promise.resolve()
  assert.equal(settled, false, 'keep the caller document pin until the real operation settles')
  await assert.rejects(sessions.run('a', { searchId: page.searchId }, signal, first), { code: 'pdf/search-busy' })
  pending.resolve({ value: { page: 2 }, nextCursor: 'must-not-commit' })
  await rejected
  const retried = await sessions.run('a', { searchId: page.searchId }, signal, async (_args, cursor) => {
    assert.equal(cursor, 'private-cursor-2')
    return { value: { page: 2 } }
  })
  assert.equal(retried.hasMore, false)
  sessions.dispose()
})

test('a failed first page does not consume retained capacity', async () => {
  const sessions = createSearchSessions<Start>({ prefix: 'rel_', maxEntries: 1 })
  const failure = new Error('failed first page')
  await assert.rejects(sessions.run('a', input, signal, async () => { throw failure }), failure)
  const pending = deferred<Page>()
  const start = sessions.run('a', input, signal, () => pending.promise)
  await assert.rejects(sessions.run('b', input, signal, first), { code: 'pdf/search-capacity' })
  pending.resolve(await first())
  const page = await start
  assert.equal(sessions.documentId('a', page.searchId), input.documentId)
  sessions.dispose()
})

test('an aborted first page is discarded after its operation settles', async () => {
  const sessions = createSearchSessions<Start>({ prefix: 'rel_', maxEntries: 1 })
  const controller = new AbortController()
  const reason = new Error('cancelled first page')
  const pending = deferred<Page>()
  const start = sessions.run('a', input, controller.signal, () => pending.promise)
  controller.abort(reason)
  await assert.rejects(sessions.run('b', input, signal, first), { code: 'pdf/search-capacity' })
  pending.resolve(await first())
  await assert.rejects(start, reason)
  const next = await sessions.run('b', input, signal, first)
  assert.equal(sessions.documentId('b', next.searchId), input.documentId)
  sessions.dispose()
})

test('expiry is refreshed by use and does not expire a pinned step', async () => {
  let time = 0
  const sessions = createSearchSessions<Start>({ prefix: 'txt_', ttlMs: 100, now: () => time })
  const page = await sessions.run('a', input, signal, first)
  time = 90
  assert.equal(sessions.documentId('a', page.searchId), input.documentId)
  time = 189
  const pending = deferred<Page>()
  const next = sessions.run('a', { searchId: page.searchId }, signal, () => pending.promise)
  time = 1000
  await sessions.run('b', input, signal, first)
  assert.equal(sessions.documentId('a', page.searchId), input.documentId)
  pending.resolve({ value: { page: 2 }, nextCursor: 'private-cursor-3' })
  await next
  time = 1100
  assert.throws(() => sessions.documentId('a', page.searchId), { code: 'pdf/unknown-search' })
  sessions.dispose()
})

test('the default registry retains at most 64 searches for 30 idle minutes', async () => {
  let time = 0
  const sessions = createSearchSessions<Start>({ prefix: 'txt_', now: () => time })
  const ids: string[] = []
  for (let count = 0; count < 65; count++) {
    ids.push((await sessions.run('a', input, signal, first)).searchId)
  }
  assert.throws(() => sessions.documentId('a', ids[0]!), { code: 'pdf/unknown-search' })
  for (const id of ids.slice(1)) assert.equal(sessions.documentId('a', id), input.documentId)
  time = 30 * 60 * 1000
  for (const id of ids.slice(1)) {
    assert.throws(() => sessions.documentId('a', id), { code: 'pdf/unknown-search' })
  }
  sessions.dispose()
})

test('capacity evicts the least recently used idle record and preserves pinned records', async () => {
  const sessions = createSearchSessions<Start>({ prefix: 'rel_', maxEntries: 2, now: () => 0 })
  const a = await sessions.run('a', input, signal, first)
  const b = await sessions.run('b', input, signal, first)
  sessions.documentId('a', a.searchId)
  const c = await sessions.run('c', input, signal, first)
  assert.throws(() => sessions.documentId('b', b.searchId), { code: 'pdf/unknown-search' })
  const pending = deferred<Page>()
  const active = sessions.run('a', { searchId: a.searchId }, signal, () => pending.promise)
  sessions.documentId('c', c.searchId)
  const d = await sessions.run('d', input, signal, first)
  assert.throws(() => sessions.documentId('c', c.searchId), { code: 'pdf/unknown-search' })
  assert.equal(sessions.documentId('a', a.searchId), input.documentId)
  assert.equal(sessions.documentId('d', d.searchId), input.documentId)
  pending.resolve({ value: { page: 2 } })
  await active
  sessions.dispose()
})

test('session deletion invalidates pending results without reviving them in a new lifetime', async () => {
  const sessions = createSearchSessions<Start>({ prefix: 'txt_', maxEntries: 1 })
  const old = await sessions.run('a', input, signal, first)
  const pending = deferred<Page>()
  const active = sessions.run('a', { searchId: old.searchId }, signal, () => pending.promise)
  sessions.deleteSession('a')
  const fresh = await sessions.run('a', { ...input, documentId: 'new-document' }, signal, first)
  pending.resolve({ value: { page: 2 }, nextCursor: 'late' })
  await assert.rejects(active, { code: 'pdf/session-disposed' })
  assert.throws(() => sessions.documentId('a', old.searchId), { code: 'pdf/unknown-search' })
  assert.equal(sessions.documentId('a', fresh.searchId), 'new-document')
  sessions.dispose()
})

test('dispose releases records, fences pending first pages and prevents all later use', async () => {
  const sessions = createSearchSessions<Start>({ prefix: 'rel_' })
  const old = await sessions.run('a', input, signal, first)
  const pending = deferred<Page>()
  const active = sessions.run('b', input, signal, () => pending.promise)
  sessions.dispose()
  sessions.dispose()
  sessions.deleteSession('a')
  pending.resolve(await first())
  await assert.rejects(active, { code: 'pdf/unavailable' })
  assert.throws(() => sessions.documentId('a', old.searchId), { code: 'pdf/unavailable' })
  await assert.rejects(sessions.run('c', input, signal, first), { code: 'pdf/unavailable' })
})

test('invalid capacity and expiry configuration fails before creating a registry', () => {
  assert.throws(() => createSearchSessions({ prefix: '' }), TypeError)
  for (const maxEntries of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => createSearchSessions({ prefix: 'rel_', maxEntries }), TypeError)
  }
  for (const ttlMs of [0, -1, NaN, Infinity]) {
    assert.throws(() => createSearchSessions({ prefix: 'rel_', ttlMs }), TypeError)
  }
})
