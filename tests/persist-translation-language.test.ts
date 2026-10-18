import assert from 'node:assert/strict'
import test from 'node:test'
import { persistTranslationLanguage } from '../src/client/persist-translation-language.ts'

test('translation target persistence returns the form decision and reports a rejected write', async () => {
  assert.equal(await persistTranslationLanguage(async () => true), true)
  assert.equal(await persistTranslationLanguage(async () => false), false)
  const failure = new Error('settings store is offline')
  const originalError = console.error
  const reports: unknown[][] = []
  console.error = (...args: unknown[]) => { reports.push(args) }
  try {
    assert.equal(await persistTranslationLanguage(async () => { throw failure }), false)
  } finally {
    console.error = originalError
  }
  assert.deepEqual(reports, [['[pdf] Failed to save translation target language', failure]])
})
