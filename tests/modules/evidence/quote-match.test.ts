import assert from 'node:assert/strict'
import test from 'node:test'
import { matchEvidenceQuote } from '../../../src/modules/evidence/quote-match.ts'

test('exact remains the default and whitespace-only differences offer a scoped explicit retry', () => {
  const parent = 'A😀 result\r\n\t uses\u00a0evidence.'
  assert.deepEqual(matchEvidenceQuote(parent, '😀'), { startUtf16: 1, endUtf16: 3 })
  assert.throws(() => matchEvidenceQuote(parent, 'result uses evidence.', undefined, 'parent-ref'), error => {
    assert.equal((error as { code: string }).code, 'pdf/quote-whitespace-mismatch')
    assert.deepEqual((error as { retryHint: unknown }).retryHint, { quoteMatch: 'whitespace-normalized',
      refId: 'parent-ref', instruction: 'Retry the same quote and parent refId with whitespace-normalized matching; only whitespace runs are collapsed.' })
    return true
  })
  const match = matchEvidenceQuote(parent, 'result uses evidence.', 'whitespace-normalized')
  assert.deepEqual(match, { startUtf16: 4, endUtf16: parent.length })
  assert.equal(parent.slice(match.startUtf16, match.endUtf16), 'result\r\n\t uses\u00a0evidence.')
})

test('whitespace-normalized matching counts every occurrence and never repairs wording or Unicode', () => {
  assert.throws(() => matchEvidenceQuote('a b and a\n\tb', 'a b', 'whitespace-normalized'),
    { code: 'pdf/ambiguous-text-target' })
  for (const [source, quote] of [['Result is 5.', 'result is 5.'], ['Result is 5.', 'Result is 5!'],
    ['co-\noperate', 'cooperate'], ['é', 'e\u0301'], ['a\u200bb', 'a b'], ['different', 'equivalent']] as const) {
    assert.throws(() => matchEvidenceQuote(source, quote, 'whitespace-normalized'), { code: 'pdf/text-not-found' })
  }
})

test('normalization maps only within the provided parent and rejects split Unicode and empty quotes', () => {
  const full = 'outside\n  A😀\tB  tail', from = full.indexOf('A'), through = full.indexOf('  tail')
  const parent = full.slice(from, through)
  const match = matchEvidenceQuote(parent, 'A😀 B', 'whitespace-normalized')
  assert.equal(from + match.startUtf16, from)
  assert.equal(from + match.endUtf16, through)
  assert.throws(() => matchEvidenceQuote(parent, 'outside A😀 B', 'whitespace-normalized'), { code: 'pdf/text-not-found' })
  for (const half of ['😀'.slice(0, 1), '😀'.slice(1)]) {
    assert.throws(() => matchEvidenceQuote(parent, half, 'whitespace-normalized'), { code: 'pdf/invalid-text-range' })
  }
  assert.throws(() => matchEvidenceQuote(parent, '\t\n', 'whitespace-normalized'), { code: 'pdf/invalid-text-range' })
})
