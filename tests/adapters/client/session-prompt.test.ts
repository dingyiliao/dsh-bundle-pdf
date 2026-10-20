import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sendExplanationPrompt, type CurrentSessionSource } from '../../../src/adapters/client/dsh/index.ts'

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

  it('does not inspect or submit a Session after cancellation', async () => {
    let inspected = false
    const source: CurrentSessionSource = { getSnapshot: () => {
      inspected = true
      return { key: 'session-a', hooks: {} }
    } }
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await assert.rejects(() => sendExplanationPrompt(source, 'session-a', 'Explain this', controller.signal), /cancelled/)
    assert.equal(inspected, false)
  })
})
