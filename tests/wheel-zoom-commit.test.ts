import assert from 'node:assert/strict'
import test from 'node:test'
import { createBoundedFrameRetry, createWheelZoomCommit, type ZoomCommitClock, type ZoomFrameClock } from '../src/client/wheel-zoom-commit.js'

function fakeClock() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; callback(): void }>()
  const clock: ZoomCommitClock = {
    set(callback, delay) {
      const id = nextId++
      timers.set(id, { at: now + delay, callback })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clear(handle) { timers.delete(handle as unknown as number) },
  }
  return {
    clock,
    get count() { return timers.size },
    advance(ms: number) {
      now += ms
      for (;;) {
        const due = [...timers].find(([, timer]) => timer.at <= now)
        if (!due) return
        timers.delete(due[0])
        due[1].callback()
      }
    },
  }
}

test('a high-frequency pinch commits only the final scale after settling', () => {
  const time = fakeClock()
  const scales: number[] = []
  const gesture = createWheelZoomCommit(scale => scales.push(scale), 160, time.clock)
  for (let index = 0; index < 100; index++) {
    gesture.schedule(1 + index / 100)
    time.advance(4)
  }
  assert.deepEqual(scales, [])
  assert.equal(time.count, 1)
  time.advance(155)
  assert.deepEqual(scales, [])
  time.advance(1)
  assert.deepEqual(scales, [1.99])
})

test('document switch cancels the old gesture and releases its timer', () => {
  const time = fakeClock()
  const scales: number[] = []
  const gesture = createWheelZoomCommit(scale => scales.push(scale), 160, time.clock)
  gesture.schedule(1.5)
  gesture.cancel()
  assert.equal(time.count, 0)
  time.advance(1000)
  assert.deepEqual(scales, [])
  gesture.schedule(2)
  time.advance(160)
  assert.deepEqual(scales, [2])
})

test('pointer interaction flushes the pending zoom exactly once', () => {
  const time = fakeClock()
  const scales: number[] = []
  const gesture = createWheelZoomCommit(scale => scales.push(scale), 160, time.clock)
  gesture.schedule(1.2)
  gesture.schedule(1.4)
  gesture.flush()
  assert.deepEqual(scales, [1.4])
  assert.equal(time.count, 0)
  time.advance(1000)
  gesture.flush()
  assert.deepEqual(scales, [1.4])
})

test('anchor restoration retries a late render and has a finite cleanup bound', () => {
  let nextId = 1
  const frames = new Map<number, () => void>()
  const clock: ZoomFrameClock = {
    request(callback) { const id = nextId++; frames.set(id, callback); return id },
    cancel(handle) { frames.delete(handle) },
  }
  const step = () => {
    const [id, callback] = [...frames][0]
    frames.delete(id)
    callback()
  }
  let calls = 0
  let retry: ReturnType<typeof createBoundedFrameRetry>
  retry = createBoundedFrameRetry(() => {
    calls++
    if (calls < 3) assert.equal(retry.schedule(), calls < 3)
  }, 3, clock)
  assert.equal(retry.schedule(), true)
  assert.equal(retry.schedule(), true)
  assert.equal(frames.size, 1)
  step(); step(); step()
  assert.equal(calls, 3)
  assert.equal(retry.schedule(), false)
  retry.reset()
  assert.equal(retry.schedule(), true)
  retry.reset()
  assert.equal(frames.size, 0)
})
