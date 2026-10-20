import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ReaderSelection } from '../../../src/modules/viewer/model/reader-selection.ts'
import type { PdfAnnotation } from '../../../src/core/pdf-types.ts'
import { namedPageActionTarget, readerPagePins } from '../../../src/modules/viewer/index.ts'

const selected: ReaderSelection = { revision: 1, kind: 'text', text: 'selected', fragments: [
  { page: 2, rect: [0, 0, 10, 10], quadPoints: [] },
  { page: 3, rect: [0, 0, 10, 10], quadPoints: [] },
] }
const annotation: PdfAnnotation = { id: 'mark', page: 8, subtype: 'Highlight', flags: 0,
  supported: true, editable: true }

test('page window pins selected text, active annotation, and distant navigation targets', () => {
  const result = readerPagePins(selected, annotation, { page: 25 })
  assert.deepEqual([...result.selectedPages], [2, 3])
  assert.deepEqual([...result.pinnedPages], [2, 3, 8, 25])
  assert.deepEqual([...result.selectedTextPages], [2, 3, 25])
})

test('region selection does not unnecessarily retain text layers', () => {
  const region: ReaderSelection = { ...selected, kind: 'region' }
  const result = readerPagePins(region, undefined, null)
  assert.deepEqual([...result.pinnedPages], [2, 3])
  assert.deepEqual([...result.selectedTextPages], [])
})

test('named page actions resolve to one-based navigation targets', () => {
  assert.equal(namedPageActionTarget(30, 'FirstPage', 100), 1)
  assert.equal(namedPageActionTarget(30, 'LastPage', 100), 100)
  assert.equal(namedPageActionTarget(30, 'NextPage', 100), 31)
  assert.equal(namedPageActionTarget(30, 'PreviousPage', 100), 29)
})
