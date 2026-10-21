import assert from 'node:assert/strict'
import test from 'node:test'
import { rankRelatedText } from '../../../src/modules/evidence/related-text.ts'

test('related-text candidates are exact page substrings ranked by expanded concepts', () => {
  const page = 'Introduction to unrelated work.\n'.repeat(20)
    + 'The later chapter explains causal identification through a difference in differences design.\n'
    + 'Appendix material follows.'
  const hits = rankRelatedText(page, '前面讨论的因果识别有没有说明', ['causal identification', 'difference in differences'])
  assert.ok(hits.length > 0)
  assert.ok(hits[0]!.matchedTerms.includes('causal'))
  assert.match(hits[0]!.quote, /causal identification/)
  assert.equal(page.slice(hits[0]!.startUtf16, hits[0]!.endUtf16), hits[0]!.quote)
})

test('related-text candidate generator makes no match without shared terms', () => {
  assert.deepEqual(rankRelatedText('A theorem about matrices and eigenspaces.', '关于鸟类迁徙的问题'), [])
  assert.deepEqual(rankRelatedText('', 'causal effect'), [])
})

test('mixed Chinese and Latin questions find separately written terms', () => {
  const text = '本章在 PDF 中详细说明了卷积神经网络的训练过程。'
  const hits = rankRelatedText(text, 'PDF里的卷积神经网络怎么训练？')
  assert.ok(hits.length > 0)
  assert.ok(hits[0]!.matchedTerms.includes('pdf'))
  assert.equal(text.slice(hits[0]!.startUtf16, hits[0]!.endUtf16), hits[0]!.quote)
})

test('matched terms never claim a word outside the returned excerpt', () => {
  const text = `causal ${'x'.repeat(290)} identification ${'x'.repeat(100)}`
  const hits = rankRelatedText(text, 'causal identification', [], 4)
  assert.ok(hits.length > 0)
  for (const hit of hits) {
    for (const term of hit.matchedTerms) assert.ok(hit.quote.toLowerCase().includes(term))
  }
})
