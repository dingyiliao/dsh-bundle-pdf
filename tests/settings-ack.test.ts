import assert from 'node:assert/strict'
import test from 'node:test'
import { SETTINGS_ACK_TIMEOUT_MS, waitForSettingsAcknowledgement } from '../src/client/settings-ack.ts'
import type { ConfigForm, ConfigFormSnapshot } from '../src/client/Settings.tsx'
import { defaultSettings } from '../src/shared/contracts.ts'

function fixture() {
  let snapshot: ConfigFormSnapshot = { status: 'ready', value: { ...defaultSettings }, base: {}, user: {}, writable: true, revision: 1 }
  const listeners = new Set<() => void>()
  const form: ConfigForm = { getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }, mutate: async () => true }
  return { form, listeners, set(value: Partial<ConfigFormSnapshot>, notify = true) {
    snapshot = { ...snapshot, ...value }
    if (notify) for (const listener of [...listeners]) listener()
  } }
}

test('a fresh accepted snapshot needs no watch; a delayed publication owns a temporary watch only', async () => {
  const f = fixture()
  f.set({ revision: 2 })
  assert.equal((await waitForSettingsAcknowledgement(f.form, 1)).revision, 2)
  assert.equal(f.listeners.size, 0)
  const waiting = waitForSettingsAcknowledgement(f.form, 2)
  assert.equal(f.listeners.size, 1)
  const lateNotification = [...f.listeners][0]!
  f.set({ revision: 3 })
  assert.equal((await waiting).revision, 3)
  assert.equal(f.listeners.size, 0)
  lateNotification()
})

test('subscription installation rechecks a missed publication and releases synchronous notifications', async () => {
  for (const synchronous of [false, true]) {
    const f = fixture(), subscribe = f.form.subscribe
    f.form.subscribe = listener => {
      const off = subscribe(listener)
      f.set({ revision: 2 }, synchronous)
      return off
    }
    assert.equal((await waitForSettingsAcknowledgement(f.form, 1)).revision, 2)
    assert.equal(f.listeners.size, 0)
  }
})

test('unavailable connections, failed subscriptions and failed snapshot reads terminate the watch', async () => {
  const absent = fixture()
  absent.set({ status: 'unavailable' })
  await assert.rejects(waitForSettingsAcknowledgement(absent.form, 1), /connection is unavailable/)
  assert.equal(absent.listeners.size, 0)
  const disconnect = fixture(), waiting = waitForSettingsAcknowledgement(disconnect.form, 1)
  disconnect.set({ status: 'unavailable' })
  await assert.rejects(waiting, /connection is unavailable/)
  assert.equal(disconnect.listeners.size, 0)
  const failed = fixture()
  failed.form.subscribe = () => { throw new Error('form disposed') }
  await assert.rejects(waitForSettingsAcknowledgement(failed.form, 1), /form disposed/)
  const stale = fixture(), reading = waitForSettingsAcknowledgement(stale.form, 1)
  stale.form.getSnapshot = () => { throw new Error('connection closed') }
  stale.set({})
  await assert.rejects(reading, /connection closed/)
  assert.equal(stale.listeners.size, 0)
})

test('a disposed form that never publishes cannot retain a passive watcher indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const f = fixture(), waiting = waitForSettingsAcknowledgement(f.form, 1)
    const refused = assert.rejects(waiting, /have not synchronized/)
    t.mock.timers.tick(SETTINGS_ACK_TIMEOUT_MS)
    await refused
    assert.equal(f.listeners.size, 0)
  } finally { t.mock.timers.reset() }
})
