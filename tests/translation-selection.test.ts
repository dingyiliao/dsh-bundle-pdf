import assert from 'node:assert/strict'
import test from 'node:test'
import { currentTranslationSelection } from '../src/client/translation-selection.ts'
import { TranslationError } from '../src/translation/types.ts'

test('a captured translation selection belongs to its reader and source document', () => {
  const selection = { owner: 7, documentId: 'pdf-a', contentVersion: 'v1', text: 'hello' }
  const document = { id: 'pdf-a', contentVersion: 'v1' }
  assert.equal(currentTranslationSelection(selection, 7, document), selection)

  const stale = (source: typeof selection | null | undefined, owner: number,
    current: typeof document | null | undefined) => assert.throws(
    () => currentTranslationSelection(source, owner, current),
    error => error instanceof TranslationError && error.code === 'stale-result',
  )
  stale(null, 7, document)
  stale(undefined, 7, document)
  stale(selection, 8, document)
  stale(selection, 7, { id: 'pdf-b', contentVersion: 'v1' })
  stale(selection, 7, { id: 'pdf-a', contentVersion: 'v2' })
  stale(selection, 7, null)
  stale(selection, 7, undefined)
})
