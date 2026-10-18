import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { sessionFile } from '../src/shared/address.ts'

test('PDF session addresses use DSH component encoding and preserve absolute paths', () => {
  const address = sessionFileAddress('session #1', '/books/Chapter 1 # intro?.pdf')
  assert.deepEqual(sessionFile(address), { sessionId: 'session #1', path: '/books/Chapter 1 # intro?.pdf' })
  assert.deepEqual(parseFileAddress(address), {
    scope: 'session', sessionId: 'session #1', path: '/books/Chapter 1 # intro?.pdf',
  })
  assert.deepEqual(sessionFile(`${address}?download=1#section`), {
    sessionId: 'session #1', path: '/books/Chapter 1 # intro?.pdf',
  })
  assert.equal(sessionFileAddress('s', 'D:\\books\\paper.pdf'), 'dsh-resource://file/session/s/D:/books/paper.pdf')
})

test('PDF rejects non-session, empty, malformed and NUL-bearing addresses', () => {
  assert.throws(() => sessionFile('dsh-resource://file/absolute/books/paper.pdf'), /session file address/)
  for (const address of [
    'dsh-resource://file/session//paper.pdf',
    'dsh-resource://file/session/s/',
    'dsh-resource://file/session/s/%',
    'dsh-resource://file/session/s/%00.pdf',
  ]) assert.throws(() => sessionFile(address), /Invalid PDF address/)
})
