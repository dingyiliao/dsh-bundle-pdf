import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createV1NavigationStore } from '../../../src/adapters/host/storage/v1-navigation.ts'

test('bookmark and position stores use the same V1 path key but keep separate records', async () => {
  const bookmarks = new Map<string, string>()
  const positions = new Map<string, number>()
  const bookmarkTable = {
    get: (key: string) => bookmarks.get(key),
    async put(key: string, value: string) { bookmarks.set(key, value) },
    async delete(key: string) { bookmarks.delete(key) },
  }
  const positionTable = {
    get: (key: string) => positions.get(key),
    async put(key: string, value: number) { positions.set(key, value) },
    async delete(key: string) { positions.delete(key) },
  }
  const bookmarkStore = createV1NavigationStore(bookmarkTable)
  const positionStore = createV1NavigationStore(positionTable)
  const path = '/fixtures/book.pdf'
  const expected = createHash('sha256').update(path).digest('hex')
  assert.equal(bookmarkStore.key(path), expected)
  assert.equal(positionStore.key(path), expected)
  assert.equal(bookmarkStore.samePath(path, path), true)
  await bookmarkStore.put(expected, 'chapter 1')
  await positionStore.put(expected, 12)
  assert.equal(bookmarkStore.get(expected), 'chapter 1')
  assert.equal(positionStore.get(expected), 12)
  let replacementCalled = false
  bookmarkTable.delete = async () => { replacementCalled = true }
  await bookmarkStore.delete(expected)
  assert.equal(replacementCalled, true, 'adapter observes a live table method replacement')
  assert.equal(positionStore.get(expected), 12)
})
