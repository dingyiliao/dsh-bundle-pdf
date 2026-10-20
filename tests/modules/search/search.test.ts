import assert from 'node:assert/strict'
import test from 'node:test'
import { excerptAround, findExactInPage, findNormalizedInPage } from '../../../src/modules/search/index.ts'

test('exact search is case-sensitive, bounded, and keeps overlapping UTF-16 offsets', () => {
  const first = findExactInPage('Banana banana', 'ana', 0, 2)
  assert.deepEqual(first.matches.map(hit => [hit.offset, hit.endOffset]), [[1, 4], [3, 6]])
  assert.equal(first.nextOffset, 4)
  assert.deepEqual(findExactInPage('Banana banana', 'ana', first.nextOffset!, 2).matches
    .map(hit => hit.offset), [8, 10])
  assert.deepEqual(findExactInPage('Alpha alpha', 'Alpha', 0, 2).matches.map(hit => hit.offset), [0])
})

test('normalized search folds case and whitespace but locates the original text', () => {
  const text = 'A\n  B and a\tB'
  const matches = findNormalizedInPage(text, 'a b', 0, 5).matches
  assert.deepEqual(matches.map(hit => [hit.offset, hit.endOffset]), [[0, 5], [10, 13]])
  assert.match(matches[0]!.excerpt, /^A\n  B/)
  assert.deepEqual(findNormalizedInPage('İ test', 'i̇ test', 0, 5).matches.map(hit => hit.offset), [0])
  assert.deepEqual(findNormalizedInPage(text, 'a b', 5, 5).matches.map(hit => hit.offset), [10])
})

test('search excerpts never split supplementary characters at their boundaries', () => {
  const text = '😀'.repeat(40) + 'target' + '𝌆'.repeat(50)
  const excerpt = excerptAround(text, 80, 6)
  assert.doesNotMatch(excerpt, /^[\uDC00-\uDFFF]/u)
  assert.doesNotMatch(excerpt, /[\uD800-\uDBFF]$/u)
  assert.throws(() => findExactInPage('abc', 'a', 5, 1), { code: 'pdf/invalid-window' })
  assert.throws(() => findNormalizedInPage('abc', 'a', 5, 1), { code: 'pdf/invalid-window' })
  assert.throws(() => findNormalizedInPage('abc', ' ', 0, 1), { code: 'pdf/invalid-window' })
})
