import assert from 'node:assert/strict'
import test from 'node:test'
import { searchItemAtOffset, searchOffsetMap, SearchTextIndex } from '../src/client/reader-search.ts'

test('search text index skips known misses and reuses Unicode text', () => {
  const index = new SearchTextIndex(20)
  assert.equal(index.mayContain(1, 'absent'), true)
  assert.equal(index.remember(1, 'Hello 𝑅 WORLD'), 'hello 𝑅 world')
  assert.equal(index.mayContain(1, 'absent'), false)
  assert.equal(index.mayContain(1, '𝑅'), true)
  assert.equal(index.mayContain(1, 'world'), true)
})

test('search text index evicts the least recently used page within its limit', () => {
  const index = new SearchTextIndex(8)
  index.remember(1, 'Alpha')
  index.remember(2, 'Bye')
  assert.equal(index.mayContain(1, 'no match'), false)
  index.remember(3, 'One')
  assert.equal(index.mayContain(1, 'no match'), false)
  assert.equal(index.mayContain(2, 'bye'), true)
  assert.equal(index.mayContain(2, 'no match'), false)
  assert.equal(index.mayContain(3, 'no match'), false)
  index.remember(4, 'Oversized text')
  assert.equal(index.mayContain(4, 'oversized'), true)
  assert.equal(index.mayContain(4, 'no match'), false)
})

test('compact summaries prevent sequential scan eviction from reopening known misses', () => {
  const index = new SearchTextIndex(6)
  for (let page = 1; page <= 5; page++) index.remember(page, `Page ${page} has birds`)
  for (let page = 1; page <= 5; page++) assert.equal(index.mayContain(page, 'elephants'), false)
  assert.equal(index.mayContain(3, 'birds'), true)
})

test('compact summaries cover one and two character queries after text eviction', () => {
  const index = new SearchTextIndex(1)
  index.remember(1, '猫咪在睡觉')
  assert.equal(index.mayContain(1, '猫'), true)
  assert.equal(index.mayContain(1, '猫咪'), true)
  assert.equal(index.mayContain(1, '狗'), false)
  assert.equal(index.mayContain(1, '狗狗'), false)
})

test('search offsets return to source characters after case expansion', () => {
  const original = 'İabc 𝑅'
  const folded = original.toLocaleLowerCase()
  const offsets = searchOffsetMap(original, folded.length)
  assert.equal(folded.indexOf('abc'), 2)
  assert.equal(offsets[folded.indexOf('abc')], 1)
  assert.equal(offsets[folded.indexOf('abc') + 3], 4)
  assert.equal(searchItemAtOffset([0, 1, 5], offsets[folded.indexOf('abc')]), 1)
  assert.equal(offsets[folded.length], original.length)
})
