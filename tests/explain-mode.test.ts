import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addExplanationExcerpt, addExplanationRegion, explanationPages, updateExplanationExcerptQuestion,
  MAX_EXPLANATION_CHARACTERS, MAX_EXPLANATION_EXCERPTS, MAX_EXPLANATION_ITEM_QUESTION_CHARACTERS,
  MAX_EXPLANATION_REGION_IMAGE_BYTES, MAX_EXPLANATION_REGION_IMAGES, sendExplanationPrompt,
  type CurrentSessionSource,
} from '../src/client/explain-mode.ts'
import type { ReaderSelection } from '../src/client/reader-selection.ts'

function selection(text: string, page: number): ReaderSelection {
  return { kind: 'text', revision: 1, text, fragments: [
    { page, rect: [1, 2, 3, 4], quadPoints: [1, 4, 3, 4, 1, 2, 3, 2] },
  ] }
}

function region(page: number): ReaderSelection {
  return { kind: 'region', revision: 1, text: '', fragments: [
    { page, rect: [1, 2, 3, 4], quadPoints: [] },
  ] }
}

function image(bytes = 4) {
  return { blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    width: 100, height: 200, mediaType: 'image/png' as const }
}

describe('ephemeral PDF explanation excerpts', () => {
  it('saves ordered selections only with their own questions without mutating the original selection', () => {
    const first = selection(' First passage ', 2)
    const added = addExplanationExcerpt([], first, 'one', ' Why does this matter? ')
    assert.equal(added.ok, true)
    if (!added.ok) return
    first.fragments[0].rect[0] = 99
    first.fragments[0].quadPoints[0] = 99
    assert.deepEqual(added.excerpts[0].fragments[0].rect, [1, 2, 3, 4])
    assert.equal(added.excerpts[0].fragments[0].quadPoints[0], 1)
    assert.equal(added.excerpts[0].kind, 'text')
    assert.equal(added.excerpts[0].question, 'Why does this matter?')
    const next = addExplanationExcerpt(added.excerpts, selection('Second passage', 5), 'two', 'How does it relate?')
    assert.equal(next.ok, true)
    if (!next.ok) return
    assert.deepEqual(next.excerpts.map(excerpt => excerpt.kind === 'text' ? excerpt.text : null),
      ['First passage', 'Second passage'])
    assert.deepEqual(next.excerpts.map(excerpt => excerpt.question),
      ['Why does this matter?', 'How does it relate?'])
  })

  it('does not count a selected passage until a nonblank question is saved', () => {
    assert.deepEqual(addExplanationExcerpt([], selection('Alpha', 2), 'one', ''), { ok: false, reason: 'question' })
    assert.deepEqual(addExplanationExcerpt([], selection('Alpha', 2), 'one', ' \n '), { ok: false, reason: 'question' })
  })

  it('keeps saved questions with stable passage IDs through edit and removal', () => {
    const first = addExplanationExcerpt([], selection('Alpha', 2), 'one', 'Why Alpha?')
    assert.equal(first.ok, true)
    if (!first.ok) return
    const second = addExplanationExcerpt(first.excerpts, selection('Beta', 5), 'two', 'How does Beta work?')
    assert.equal(second.ok, true)
    if (!second.ok) return
    const edited = updateExplanationExcerptQuestion(second.excerpts, 'two', ' Explain Beta differently. ')
    assert.equal(edited[0].question, 'Why Alpha?')
    assert.equal(edited[1].question, 'Explain Beta differently.')
    assert.equal(second.excerpts[1].question, 'How does Beta work?')
    assert.equal(updateExplanationExcerptQuestion(edited, 'two', ' \n ')[1].question, 'Explain Beta differently.')
    assert.deepEqual(edited.filter(excerpt => excerpt.id !== 'one').map(excerpt => excerpt.question),
      ['Explain Beta differently.'])
    assert.equal(updateExplanationExcerptQuestion(edited, 'two', 'x'.repeat(600))[1].question.length,
      MAX_EXPLANATION_ITEM_QUESTION_CHARACTERS)
  })

  it('preserves distinct cross-page locations in one excerpt', () => {
    const cross = selection('Across pages', 2)
    cross.fragments.push({ page: 3, rect: [2, 3, 4, 5], quadPoints: [] })
    const result = addExplanationExcerpt([], cross, 'cross', 'What connects these pages?')
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(explanationPages(result.excerpts[0]), [2, 3])
  })

  it('rejects empty and over-budget selections instead of silently truncating source text', () => {
    assert.deepEqual(addExplanationExcerpt([], selection('  ', 1), 'blank', 'Why?'), { ok: false, reason: 'empty' })
    assert.equal(addExplanationExcerpt([], selection('x'.repeat(MAX_EXPLANATION_CHARACTERS + 1), 1), 'long', 'Why?').ok, false)
    const full = Array.from({ length: MAX_EXPLANATION_EXCERPTS }, (_, index) => ({
      kind: 'text' as const, id: String(index), text: 'x', question: 'Why?', fragments: selection('x', index + 1).fragments,
    }))
    assert.deepEqual(addExplanationExcerpt(full, selection('last', 1), 'overflow', 'Why?'), { ok: false, reason: 'limit' })
  })

  it('stores one-page region pixels with their question, without mutating the selection', () => {
    const selected = region(7)
    const png = image()
    const result = addExplanationRegion([], selected, png, 'region-1', ' What does this chart show? ')
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.excerpts[0].kind, 'region')
    assert.equal(result.excerpts[0].question, 'What does this chart show?')
    assert.deepEqual(explanationPages(result.excerpts[0]), [7])
    selected.fragments[0].rect[0] = 99
    assert.deepEqual(result.excerpts[0].fragments[0].rect, [1, 2, 3, 4])
    if (result.excerpts[0].kind === 'region') assert.equal(result.excerpts[0].image.blob, png.blob)
    assert.deepEqual(addExplanationRegion([], region(7), png, 'region-2', '   '), { ok: false, reason: 'question' })
  })

  it('rejects invalid, excessive, or oversized regions without dropping existing text', () => {
    const selected = region(2)
    selected.fragments.push({ page: 3, rect: [1, 2, 3, 4], quadPoints: [] })
    assert.deepEqual(addExplanationRegion([], selected, image(), 'cross', 'Why?'), { ok: false, reason: 'region' })
    const invalid = region(2)
    invalid.fragments[0].rect = [3, 2, 1, 4]
    assert.deepEqual(addExplanationRegion([], invalid, image(), 'inverted', 'Why?'), { ok: false, reason: 'region' })
    assert.deepEqual(addExplanationRegion([], region(2), image(MAX_EXPLANATION_REGION_IMAGE_BYTES + 1), 'huge', 'Why?'),
      { ok: false, reason: 'image-size' })
    const text = addExplanationExcerpt([], selection('Alpha', 1), 'text', 'Explain this?')
    assert.equal(text.ok, true)
    if (!text.ok) return
    let excerpts = text.excerpts
    for (let index = 0; index < MAX_EXPLANATION_REGION_IMAGES; index++) {
      const result = addExplanationRegion(excerpts, region(index + 2), image(), `region-${index}`, 'Why?')
      assert.equal(result.ok, true)
      if (!result.ok) return
      excerpts = result.excerpts
    }
    assert.deepEqual(addExplanationRegion(excerpts, region(20), image(), 'extra', 'Why?'),
      { ok: false, reason: 'image-limit' })
    assert.equal(excerpts[0].kind, 'text')
    assert.equal(addExplanationExcerpt(excerpts, selection('Beta', 2), 'next', 'Why?').ok, true)
  })
})

describe('explanation prompt admission', () => {
  it('queues exactly one text prompt to the owning selected Session', async () => {
    const calls: unknown[][] = []
    const source: CurrentSessionSource = { getSnapshot: () => ({ key: 'session-a', hooks: { session: {
      prompt: async (...args) => { calls.push(args); return { ok: true, value: { accepted: true } } },
    } } }) }
    await sendExplanationPrompt(source, 'session-a', 'Explain two passages')
    assert.deepEqual(calls, [[[ { type: 'text', text: 'Explain two passages' } ], 'queue', undefined]])
  })

  it('queues mixed text and image parts to the same Session without dropping the image', async () => {
    const calls: unknown[][] = []
    const source: CurrentSessionSource = { getSnapshot: () => ({ key: 'session-a', hooks: { session: {
      prompt: async (...args) => { calls.push(args); return { ok: true, value: { accepted: true } } },
    } } }) }
    const parts = [{ type: 'text' as const, text: 'Explain this region' },
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQID' }]
    await sendExplanationPrompt(source, 'session-a', parts)
    assert.deepEqual(calls, [[parts, 'queue', undefined]])
  })

  it('refuses a stale or different active Session and surfaces admission failures', async () => {
    let count = 0
    const source: CurrentSessionSource = { getSnapshot: () => ({ key: 'session-b', hooks: { session: {
      prompt: async () => { count++; return { ok: false, error: { code: 'denied', message: 'Unavailable' } } },
    } } }) }
    await assert.rejects(() => sendExplanationPrompt(source, 'session-a', 'x'), /no longer the active conversation/)
    assert.equal(count, 0)
    await assert.rejects(() => sendExplanationPrompt(source, 'session-b', 'x'), /denied: Unavailable/)
    assert.equal(count, 1)
  })
})
