import assert from 'node:assert/strict'
import test from 'node:test'
import { applyIfNoNewerNavigation } from '../src/client/reading-resume.ts'

test('a late stored position cannot replace a newer page jump', async () => {
  let finishLoad!: (page: number) => void
  const load = new Promise<number>(resolve => { finishLoad = resolve })
  let intent = 0
  const applied: number[] = []
  const pending = applyIfNoNewerNavigation(() => load, () => intent, new AbortController().signal,
    async page => { applied.push(page) })

  intent++ // The reader navigates to a different page before the Host responds.
  finishLoad(1)
  assert.equal(await pending, false)
  assert.deepEqual(applied, [])
})

test('an unchanged stored position is applied before resume completes', async () => {
  const applied: number[] = []
  let finishApply!: () => void
  const applying = new Promise<void>(resolve => { finishApply = resolve })
  let settled = false
  const pending = applyIfNoNewerNavigation(async () => 3, () => 0, new AbortController().signal,
    async page => { applied.push(page); await applying }).then(result => { settled = true; return result })

  await Promise.resolve()
  assert.deepEqual(applied, [3])
  assert.equal(settled, false)
  finishApply()
  assert.equal(await pending, true)
  assert.equal(settled, true)
})

test('an aborted restore does not apply the stored position', async () => {
  const controller = new AbortController()
  controller.abort()
  const applied: number[] = []
  assert.equal(await applyIfNoNewerNavigation(async () => 3, () => 0, controller.signal,
    async page => { applied.push(page) }), false)
  assert.deepEqual(applied, [])
})
