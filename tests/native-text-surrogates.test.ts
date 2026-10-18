import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { NativeWorker } from '../src/engine/native-worker.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'
import { supplementaryTextPdf } from './native-fixture.ts'
import { searchResultExcerpt } from '../src/client/reader-search.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native text tests require a built helper')

test('PDFium text decodes supplementary Unicode without replacement characters', { skip: !existsSync(executable) }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'supplementary-text' }, supplementaryTextPdf())
    const content = (await worker.request({ command: 'text', documentId: 'supplementary-text', pageIndex: 0 })).value as {
      items: { str: string; width: number }[]
    }
    assert.equal(content.items.map(item => item.str).join(''), '\u{1D445}\u{1D45D}')
    assert.ok(content.items.some(item => item.width > 0))
  } finally { await worker.dispose() }
})

test('search excerpts keep astral characters intact and hide invalid text markers', () => {
  const text = `${'x'.repeat(29)}\u{1D445}${'y'.repeat(29)}target\uFFFD\uFFFDend`
  const excerpt = searchResultExcerpt(text, text.indexOf('target'), 6)
  assert.ok(excerpt.startsWith('…'), 'leading context removed from the excerpt is marked')
  assert.ok(excerpt.includes(`\u{1D445}${'y'.repeat(29)}target…end`))
  assert.equal(searchResultExcerpt(`target${'z'.repeat(64)}\u{1D45D}`, 0, 1).endsWith('\u{1D45D}'), true)
  assert.equal(searchResultExcerpt('a\ud835b\udc45c', 1, 1), 'a…b…c')
})

test('search excerpts mark truncation and cut at English word boundaries', () => {
  const text = Array.from({ length: 36 }, (_, index) => `term${String(index).padStart(2, '0')}`).join(' ')
  const match = 'term18'
  const excerpt = searchResultExcerpt(text, text.indexOf(match), match.length)
  assert.ok(excerpt.startsWith('…'), `expected a leading ellipsis: ${excerpt}`)
  assert.ok(excerpt.endsWith('…'), `expected a trailing ellipsis: ${excerpt}`)
  assert.ok(excerpt.includes(match), 'the matching word remains visible')

  const visibleText = excerpt.slice(1, -1).trim()
  const visibleStart = text.indexOf(visibleText)
  assert.ok(visibleStart > 0, `excerpt must preserve a contiguous source span: ${excerpt}`)
  assert.equal(text[visibleStart - 1], ' ', 'the leading cut does not begin inside a word')
  assert.equal(text[visibleStart + visibleText.length], ' ', 'the trailing cut does not end inside a word')
})
