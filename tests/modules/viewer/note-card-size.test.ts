import assert from 'node:assert/strict'
import test from 'node:test'
import { MIN_NOTE_CARD_HEIGHT, MIN_NOTE_CARD_WIDTH, noteCardSizeStorageKey,
  parseNoteCardSize, readNoteCardSize, saveNoteCardSize } from '../../../src/modules/viewer/model/note-card-size.ts'

test('note card sizing accepts one minimum and rejects corrupt saved values', () => {
  assert.deepEqual(parseNoteCardSize(JSON.stringify({ width: MIN_NOTE_CARD_WIDTH, height: MIN_NOTE_CARD_HEIGHT })),
    { width: MIN_NOTE_CARD_WIDTH, height: MIN_NOTE_CARD_HEIGHT })
  assert.deepEqual(parseNoteCardSize(JSON.stringify({ width: 1800, height: 1200 })),
    { width: 1800, height: 1200 }, 'there is no fixed UI maximum beyond the viewport')
  for (const stored of ['not JSON', 'null', '{}', '{"width":100,"height":300}', '{"width":300,"height":80}',
    '{"width":null,"height":300}', '{"width":300,"height":"250"}']) {
    assert.equal(parseNoteCardSize(stored), null)
  }
})

test('note card size is scoped to its document and annotation identity', () => {
  const values = new Map<string, string>()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  } })
  try {
    saveNoteCardSize('["/document.pdf","note-a"]', { width: 360, height: 240 })
    assert.deepEqual(readNoteCardSize('["/document.pdf","note-a"]'), { width: 360, height: 240 })
    assert.equal(readNoteCardSize('["/document.pdf","note-b"]'), null)
    assert.equal(readNoteCardSize('["/other.pdf","note-a"]'), null)
    assert.ok(values.has(noteCardSizeStorageKey('["/document.pdf","note-a"]')))
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
