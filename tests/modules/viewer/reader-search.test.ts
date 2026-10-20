import assert from 'node:assert/strict'
import test from 'node:test'
import { joinSearchText, searchItemAtOffset, searchOffsetMap, searchResultExcerpt,
  SearchProgressPacer, SearchTextIndex } from '../../../src/modules/viewer/model/reader-search.ts'
import { joinPageText } from '../../../src/shared/page-text.ts'

test('cached search misses yield by elapsed time without publishing unchanged hits', async () => {
  let now = 0, frames = 0, publications = 0
  const pacer = new SearchProgressPacer(() => now, async () => { frames++ }, () => { publications++ }, () => true)
  for (let page = 0; page < 8; page++) {
    now++
    assert.equal(pacer.checkpoint(0), undefined)
  }
  assert.equal(frames, 0)
  assert.equal(publications, 0)
  now = 12
  assert.equal(await pacer.checkpoint(0), true)
  assert.equal(frames, 1)
  assert.equal(publications, 0)
  now = 13
  assert.equal(pacer.checkpoint(0), undefined)
})

test('warm common-hit search still yields even when every page read resolves from cache', async () => {
  let now = 0, frames = 0, publications = 0
  const pacer = new SearchProgressPacer(() => now, async () => { frames++; now++ }, () => { publications++ }, () => true)
  for (let page = 1; page <= 100; page++) {
    now += 2
    const pause = pacer.checkpoint(page)
    if (pause) assert.equal(await pause, true)
  }
  assert.ok(frames >= 14 && frames <= 17)
  assert.equal(publications, frames)
})

test('search progress stops publishing after cancellation during a yield', async () => {
  let now = 0, publications = 0, current = true
  const pacer = new SearchProgressPacer(() => now, async () => { current = false; now++ },
    () => { publications++ }, () => current)
  now = 12
  assert.equal(await pacer.checkpoint(1), false)
  assert.equal(publications, 1)
  now = 24
  assert.equal(pacer.checkpoint(2), undefined)
  assert.equal(publications, 1)
})

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

test('search offsets preserve source positions under Lithuanian contextual case expansion', () => {
  // A browser whose default locale is lt-LT inserts a combining dot when I is
  // followed by an accent. Emulate that default locale in this Node test; the
  // folded length is computed from the same string and same locale as search.
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'toLocaleLowerCase')!
  const nativeLower = String.prototype.toLocaleLowerCase
  Object.defineProperty(String.prototype, 'toLocaleLowerCase', { configurable: true, value:
    function (this: string, locales?: string | string[]) { return nativeLower.call(this, locales ?? 'lt-LT') },
  })
  try {
    const original = 'I\u0301'
    const folded = original.toLocaleLowerCase()
    assert.equal(folded, 'i\u0307\u0301')
    assert.equal(folded.length, 3)
    assert.deepEqual([...searchOffsetMap(original, folded.length)], [0, 1, 1, 2])
  } finally {
    Object.defineProperty(String.prototype, 'toLocaleLowerCase', descriptor)
  }
})

test('replacing cached page text adjusts the retained-byte budget', () => {
  const index = new SearchTextIndex(10, 0)
  index.remember(1, 'hello')
  index.remember(2, 'world')
  index.remember(1, 'hi')
  index.remember(3, 'again')
  assert.equal(index.mayContain(1, 'hi'), true)
  assert.equal(index.mayContain(2, 'non-present'), true, 'the least-recently-used page was evicted')
  assert.equal(index.mayContain(3, 'again'), true)
})

test('offset mapping handles a folded-length mismatch without splitting a source character', () => {
  assert.deepEqual([...searchOffsetMap('ABC', 2)], [0, 1, 3])
})

test('search text joins line endings and positioned gaps but preserves split words', () => {
  const item = (str: string, x: number, y: number, width: number, hasEOL = false) => ({
    str, transform: [1, 0, 0, 1, x, y], width, height: 10, hasEOL,
  })
  assert.deepEqual(joinSearchText([
    item('hel', 0, 0, 30), item('lo', 30, 0, 20),
    item('world', 80, 0, 40, true), item('next', 0, 15, 30),
  ]), { text: 'hello world\nnext', starts: [0, 3, 6, 12] })
  assert.deepEqual(joinSearchText([item('above', 0, 0, 30), item('below', 0, 15, 30)]),
    { text: 'above below', starts: [0, 6] })
})

test('reader search and Host page text share the same positioned-text rules', () => {
  const item = (str: string, x: number, y: number, width: number, hasEOL = false) => ({
    str, transform: [1, 0, 0, 1, x, y], width, height: 10, hasEOL,
  })
  const pages = [
    [],
    [item('multi', 0, 0, 25), item('modal', 25, 0, 25)],
    [item('PDF ', 0, 0, 20), item('reader', 28, 0, 30), item('下一行', 0, 15, 30, true), item('text', 0, 30, 20)],
    [item('😀', 0, 0, 10), item('词', 15, 0, 10)],
  ]
  for (const items of pages) {
    const joined = joinSearchText(items)
    assert.equal(joined.text, joinPageText(items))
    assert.equal(joined.starts.length, items.length)
    for (const [index, start] of joined.starts.entries()) {
      assert.equal(joined.text.slice(start, start + items[index]!.str.length), items[index]!.str)
    }
  }
})

test('excerpt closes an ordinary word past the nominal right edge', () => {
  const text = `${'a'.repeat(115)} rest`
  const excerpt = searchResultExcerpt(text, 40, 1)
  assert.ok(excerpt.endsWith('aaaa…'))
  assert.equal(excerpt.includes(' rest'), false)
})
