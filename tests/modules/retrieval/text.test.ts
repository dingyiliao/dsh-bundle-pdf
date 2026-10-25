import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkPage, tokenizeRetrievalText } from '../../../src/modules/retrieval/text.ts'

test('chunks retain original UTF-16 ranges, whitespace and distinct repeated occurrences', () => {
  const repeated = '  A repeated paragraph with exact spelling.\n'.repeat(40)
  const text = `\n 😀 ＰＤＦ e\u0301 \n${repeated}\nEnd.  `
  const chunks = chunkPage(3, text)
  assert.ok(chunks.length > 1)
  assert.equal(new Set(chunks.map(chunk => chunk.id)).size, chunks.length)
  for (const chunk of chunks) {
    assert.equal(chunk.text, text.slice(chunk.startUtf16, chunk.endUtf16))
    assert.equal(chunk.page, 3)
    assert.ok(chunk.text.length <= 1200)
    assert.equal(chunk.source, 'pdf-text')
  }
  assert.deepEqual(chunkPage(3, text), chunks)
  assert.notEqual(chunkPage(4, text)[0]!.id, chunks[0]!.id)
  assert.notEqual(chunkPage(3, text, 'ocr')[0]!.id, chunks[0]!.id)
  assert.notEqual(chunkPage(3, `${text} changed`)[0]!.pageTextDigest, chunks[0]!.pageTextDigest)
})

test('boundaries prefer paragraphs and lines without changing their extraction order', () => {
  const first = 'A'.repeat(650)
  const second = 'B'.repeat(700)
  const text = `${first}\n\n${second}\n${'C'.repeat(700)}`
  const chunks = chunkPage(1, text)
  assert.equal(chunks[0]!.text, first)
  assert.equal(chunks[0]!.endUtf16, first.length)
  // Columns/semantic paragraph order cannot be inferred from plain text. Retain
  // the exact input, including its potentially interleaved column text.
  const columns = 'left heading    right heading\nleft text    right text'
  assert.equal(chunkPage(1, columns)[0]!.text, columns)
  assert.equal(chunks[1]!.startUtf16, first.length + 2,
    'overlap must not absorb a previous paragraph')
  for (let index = 2; index < chunks.length; index++) {
    assert.ok(chunks[index]!.startUtf16 < chunks[index - 1]!.endUtf16)
    assert.ok(chunks[index]!.endUtf16 > chunks[index - 1]!.endUtf16)
  }
})

test('short paragraphs are separate exact evidence units even when their whole page fits one size window', () => {
  const paragraphs = ['Heading', 'A wrapped explanation starts here\nand finishes on this line.', 'Another topic.', 'Footer']
  const text = paragraphs.join('\n\n')
  const chunks = chunkPage(1, text)
  assert.deepEqual(chunks.map(chunk => chunk.text), paragraphs)
  for (const chunk of chunks) assert.equal(text.slice(chunk.startUtf16, chunk.endUtf16), chunk.text)
  assert.equal(new Set(chunks.map(chunk => chunk.pageTextDigest)).size, 1)
})

test('positioned paragraph starts split single-newline page text without overlapping adjacent paragraphs', () => {
  const first = '  😀 Exact first paragraph.\nIts wrapped second line.'
  const second = '第二段保持原来的字形范围。'
  const text = `${first}\n${second}\nFooter`
  const breaks = [first.length + 1, first.length + second.length + 2]
  const chunks = chunkPage(4, text, 'pdf-text', { paragraphBreaks: breaks })
  assert.deepEqual(chunks.map(chunk => chunk.text), [first.trim(), second, 'Footer'])
  assert.deepEqual(chunks.map(chunk => chunk.startUtf16), [2, ...breaks])
  for (const chunk of chunks) assert.equal(chunk.text, text.slice(chunk.startUtf16, chunk.endUtf16))
  const long = `${'Long body text. '.repeat(100)}\n\nA separate ending.`
  const bounded = chunkPage(1, long, 'pdf-text', { maxCharacters: 128 })
  assert.equal(bounded.at(-1)!.text, 'A separate ending.')
  assert.ok(bounded.slice(0, -1).every(chunk => !chunk.text.includes('separate ending')))
})

test('malformed or excessive paragraph boundaries cannot enter retrieval evidence', () => {
  const text = 'A😀B\nAnother line.'
  for (const paragraphBreaks of [[0], [text.length], [-1], [2], [4, 3], [1, 1], [1.5], [NaN], [Infinity],
    Array.from({ length: 10_001 }, (_, index) => index + 1)]) {
    assert.throws(() => chunkPage(1, text, 'pdf-text', { paragraphBreaks }), /paragraph breaks/)
  }
  assert.throws(() => chunkPage(1, 'A\n\n'.repeat(10_002)), { code: 'pdf/retrieval-budget' })
})

test('chunking handles long unbroken Unicode text without splitting surrogate pairs or losing characters', () => {
  const text = `${'x'.repeat(1199)}😀${'𠮷汉😀'.repeat(1000)}`
  const chunks = chunkPage(1, text)
  let coveredEnd = 0
  for (const chunk of chunks) {
    assert.ok(chunk.startUtf16 <= coveredEnd)
    assert.ok(!/^[\uDC00-\uDFFF]/u.test(chunk.text))
    assert.ok(!/[\uD800-\uDBFF]$/u.test(chunk.text))
    assert.ok(chunk.text.length <= 1200)
    assert.equal(chunk.text, text.slice(chunk.startUtf16, chunk.endUtf16))
    coveredEnd = chunk.endUtf16
  }
  assert.equal(coveredEnd, text.length)
})

test('empty pages produce no chunks and invalid page numbers fail', () => {
  assert.deepEqual(chunkPage(1, ''), [])
  assert.deepEqual(chunkPage(1, ' \n\t'.repeat(5000)), [])
  assert.throws(() => chunkPage(0, 'content'), /positive integers/)
  assert.throws(() => chunkPage(1.5, 'content'), /positive integers/)
})

test('normalization is confined to scoring and tokenization supports mixed Latin and CJK', () => {
  const text = 'ＰＤＦ里的卷积神经网络 e\u0301 中文 한글 カタカナ 𠮷祥'
  const tokens = tokenizeRetrievalText(text)
  assert.ok(tokens.includes('pdf'))
  assert.ok(tokens.includes('卷积'))
  assert.ok(tokens.includes('网络'))
  assert.ok(tokens.includes('é'))
  assert.ok(tokens.includes('한글'))
  assert.ok(tokens.includes('カタ'))
  assert.ok(tokens.includes('𠮷祥'))
  assert.equal(chunkPage(1, text)[0]!.text, text)
  assert.deepEqual(tokenizeRetrievalText('---'), [])
})

test('small model input budgets change boundaries while preserving exact source coverage', () => {
  const text = 'Sample 😀 Unicode 中文 text.\n'.repeat(60)
  const chunks = chunkPage(2, text, 'ocr', { maxCharacters: 128 })
  let coveredEnd = 0
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 128)
    assert.ok(!text.slice(coveredEnd, chunk.startUtf16).trim())
    assert.equal(chunk.text, text.slice(chunk.startUtf16, chunk.endUtf16))
    assert.equal(chunk.source, 'ocr')
    coveredEnd = chunk.endUtf16
  }
  assert.ok(!text.slice(coveredEnd).trim())
  assert.ok(chunks.length > chunkPage(2, text).length)
  assert.throws(() => chunkPage(1, text, 'pdf-text', { maxCharacters: 63 }), /chunk length/)
  assert.throws(() => chunkPage(1, text, 'pdf-text', { maxCharacters: 128, overlapCharacters: 64 }), /overlap/)
  const unbroken = '😀'.repeat(400)
  const contiguous = chunkPage(1, unbroken, 'pdf-text', { maxCharacters: 65, overlapCharacters: 0 })
  assert.equal(contiguous.map(chunk => chunk.text).join(''), unbroken)
})
