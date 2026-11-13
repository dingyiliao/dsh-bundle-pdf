import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeHandleLease } from '../../../src/engine/host/handle-lease.ts'

function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { open, promise }
}

test('an active native handle lease completes before queued work and each waiting lane makes progress', async () => {
  const lease = createNativeHandleLease(), active = gate(), order: string[] = []
  const running = lease.run(async () => { order.push('active'); await active.promise })
  const normal = [1, 2].map(index => lease.run(async () => { order.push(`normal-${index}`) }))
  const tiles = [1, 2, 3, 4, 5, 6].map(index => lease.run(async () => { order.push(`tile-${index}`) }, undefined, true))
  await Promise.resolve()
  assert.deepEqual(order, ['active'])
  active.open()
  await Promise.all([running, ...normal, ...tiles])
  assert.deepEqual(order, ['active', 'tile-1', 'tile-2', 'tile-3', 'tile-4', 'normal-1', 'tile-5', 'tile-6', 'normal-2'])
})

test('cancellation removes a queued job and closing rejects waiters without interrupting the lease owner', async () => {
  const lease = createNativeHandleLease(), active = gate(), entered = gate()
  const never = async () => assert.fail('A cancelled or closed waiter must never run')
  const cancelled = new AbortController(), cancelReason = new Error('Page left the viewport')
  const closeReason = new Error('Service shut down')
  const running = lease.run(async () => { entered.open(); await active.promise; return 'done' })
  await entered.promise
  const obsolete = assert.rejects(lease.run(never, cancelled.signal, true), error => error === cancelReason)
  cancelled.abort(cancelReason)
  await obsolete
  const queued = assert.rejects(lease.run(never), error => error === closeReason)
  lease.close(closeReason)
  await queued
  await assert.rejects(lease.run(never), error => error === closeReason)
  active.open()
  assert.equal(await running, 'done')

  const admitted = createNativeHandleLease()
  const scheduled = assert.rejects(admitted.run(never), error => error === closeReason)
  admitted.close(closeReason)
  await scheduled
})
