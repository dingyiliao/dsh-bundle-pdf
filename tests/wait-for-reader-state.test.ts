import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForReaderState } from '../src/client/wait-for-reader-state.js'

class TrackedTarget extends EventTarget {
  listeners = 0

  override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    super.addEventListener(...args)
    this.listeners++
  }

  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    super.removeEventListener(...args)
    this.listeners--
  }
}

test('returns an already available value without subscribing', async () => {
  const target = new TrackedTarget()
  const value = await waitForReaderState(target, 'ready', () => 0, new AbortController().signal, 100)
  assert.equal(value, 0)
  assert.equal(target.listeners, 0)
})

test('resolves when the requested event reports a ready value', async () => {
  const target = new TrackedTarget()
  let value: string | undefined
  const waiting = waitForReaderState(target, 'ready', () => value, new AbortController().signal, 100)
  assert.equal(target.listeners, 1)
  value = 'page'
  target.dispatchEvent(new Event('ready'))
  assert.equal(await waiting, 'page')
  assert.equal(target.listeners, 0)
})

test('reads again after subscribing so a change between checks is not lost', async () => {
  const target = new TrackedTarget()
  let value: string | undefined
  let reads = 0
  const result = await waitForReaderState(target, 'ready', () => {
    reads++
    if (reads === 1) value = 'page'
    return reads === 1 ? undefined : value
  }, new AbortController().signal, 100)
  assert.equal(result, 'page')
  assert.equal(reads, 2)
  assert.equal(target.listeners, 0)
})

test('ignores unrelated events and notifications without a value', async () => {
  const target = new TrackedTarget()
  let value: string | undefined
  let reads = 0
  const waiting = waitForReaderState(target, 'ready', () => {
    reads++
    return value
  }, new AbortController().signal, 100)
  assert.equal(reads, 2)
  target.dispatchEvent(new Event('other'))
  assert.equal(reads, 2)
  target.dispatchEvent(new Event('ready'))
  assert.equal(reads, 3)
  value = 'page'
  target.dispatchEvent(new Event('ready'))
  assert.equal(await waiting, 'page')
  assert.equal(target.listeners, 0)
})

test('abort rejects with its reason and removes the listener', async () => {
  const target = new TrackedTarget()
  const controller = new AbortController()
  const reason = new Error('cancelled')
  const waiting = waitForReaderState(target, 'ready', () => undefined, controller.signal, 100)
  controller.abort(reason)
  await assert.rejects(waiting, error => error === reason)
  assert.equal(target.listeners, 0)
})

test('timeout rejects with TimeoutError and removes the listener', async () => {
  const target = new TrackedTarget()
  const waiting = waitForReaderState(target, 'ready', () => undefined, new AbortController().signal, 5)
  await assert.rejects(waiting, { name: 'TimeoutError' })
  assert.equal(target.listeners, 0)
})

test('read errors reject and remove the listener', async () => {
  const target = new TrackedTarget()
  const reason = new Error('read failed')
  let reads = 0
  const waiting = waitForReaderState(target, 'ready', () => {
    if (++reads === 3) throw reason
    return undefined
  }, new AbortController().signal, 100)
  target.dispatchEvent(new Event('ready'))
  await assert.rejects(waiting, error => error === reason)
  assert.equal(target.listeners, 0)
})
