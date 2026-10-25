import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { AgentNavigationRequest, TextNavigationTarget } from '../../../src/contracts/navigation.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { navigateAgentRequest, textTargetPosition, type AgentTextNavigationOptions } from '../../../src/modules/viewer/controllers/agent-text-navigation.ts'
import { NativeViewport } from '../../../src/modules/viewer/rendering/viewport.ts'
import type { NativeDocument } from '../../../src/modules/viewer/rendering/document.ts'

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const text = 'same quote. more context. same quote.'
const second = text.lastIndexOf('same quote')
const target = (extra: Partial<TextNavigationTarget> = {}): TextNavigationTarget => ({ kind: 'text', refId: 'ref-2',
  revision: 4, sourceDigest: hash('bytes'), pageTextDigest: hash(text), startUtf16: second,
  endUtf16: second + 10, textSha256: hash('same quote'), rectPdf: [40, 100, 200, 220],
  quadPoints: [40, 220, 140, 220, 40, 210, 140, 210, 40, 110, 200, 110, 40, 100, 200, 100], ...extra })
const request = (extra: Partial<AgentNavigationRequest> = {}): AgentNavigationRequest => ({
  requestId: 'c67035c2-d404-4a67-9f28-5529ccdb19e0', documentId: 'doc', contentVersion: 'content', page: 2,
  target: target(), ...extra })

function fixture() {
  const snapshot = { id: 'doc', revision: 4, contentVersion: 'content', reader: { bytesHash: hash('bytes') },
    document: { pageCount: 3, pages: [1, 2, 3].map(page => ({ page, cropBox: [10, 20, 410, 620], userUnit: 1, rotation: 0 })) } } as WorkspaceSnapshot
  let reads = 0, jumps = 0
  const document = { snapshot, text: async () => { reads++; return { items: [{ str: text }] } } } as unknown as NativeDocument
  let current = { snapshot, document, visible: true, ready: true, viewportHeight: 600 }
  const listeners = new Set<() => void>()
  let lastPosition: unknown
  const options: AgentTextNavigationOptions = { current: () => current,
    subscribe: (_id, callback) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    jump: async (_page, position, _remember, guard) => { guard!.validate(); jumps++; lastPosition = position; return true },
    timeoutMs: 30,
  }
  return { snapshot, options, listeners, reads: () => reads, jumps: () => jumps, position: () => lastPosition,
    update: (change: Partial<typeof current>) => { current = { ...current, ...change }; listeners.forEach(callback => callback()) } }
}

test('exact navigation verifies the second repeated quote by UTF-16 offset and positions its first line', async () => {
  const f = fixture()
  assert.equal(await navigateAgentRequest(request(), new AbortController().signal, f.options), 'opened')
  assert.equal(f.reads(), 1)
  assert.equal(f.jumps(), 1)
  assert.deepEqual(f.position(), { x: 40, y: 220, viewportAnchor: { x: 0.08, y: 0.16999999999999998 } })
  assert.equal(f.listeners.size, 0)
  const invalidOffset = request({ target: target({ startUtf16: second + 1, endUtf16: second + 11 }) })
  assert.equal(await navigateAgentRequest(invalidOffset, new AbortController().signal, f.options), 'stale')
  assert.equal(f.jumps(), 1)
})

test('native viewport conversion handles crop offsets, UserUnit and all rotations without using the whole passage box', () => {
  const f = fixture()
  for (const rotation of [0, 90, 180, 270]) {
    const geometry = { ...f.snapshot.document.pages[1], rotation, userUnit: 2 }
    const snapshot = { ...f.snapshot, document: { ...f.snapshot.document, pages: [f.snapshot.document.pages[0], geometry] } }
    const point = textTargetPosition(snapshot, 2, target(), 600)
    const viewport = new NativeViewport(geometry, 1, rotation)
    const pixels = viewport.convertToViewportPoint(point.x!, point.y!)
    const glyph = [[40, 220], [140, 220], [40, 210], [140, 210]].map(([x, y]) => viewport.convertToViewportPoint(x, y))
    assert.deepEqual(pixels, [Math.min(...glyph.map(p => p[0])), Math.min(...glyph.map(p => p[1]))])
  }
})

test('a delayed watch revision is awaited and its listener is released before navigation', async () => {
  const f = fixture()
  f.update({ snapshot: { ...f.snapshot, revision: 3 } })
  const pending = navigateAgentRequest(request(), new AbortController().signal, f.options)
  assert.equal(f.jumps(), 0)
  assert.equal(f.listeners.size, 1)
  f.update({ snapshot: f.snapshot })
  assert.equal(await pending, 'opened')
  assert.equal(f.listeners.size, 0)
})

test('an annotation-only save waits for both newer source bytes and a matching native attachment in either order', async () => {
  for (const order of ['snapshot-first', 'native-first']) {
    const f = fixture()
    f.options.timeoutMs = 250
    const next = { ...f.snapshot, reader: { ...f.snapshot.reader, bytesHash: hash('saved bytes') } }
    const old = { ...f.snapshot, revision: 3 }
    let newReads = 0
    const native = { snapshot: next, text: async () => { newReads++; return { items: [{ str: text }] } } } as unknown as NativeDocument
    f.update({ snapshot: old })
    const pending = navigateAgentRequest(request({ target: target({ sourceDigest: next.reader.bytesHash }) }), new AbortController().signal, f.options)
    assert.equal(f.listeners.size, 1, order)
    assert.equal(f.jumps(), 0, order)
    if (order === 'snapshot-first') {
      f.update({ snapshot: next })
      await Promise.resolve()
      assert.equal(f.reads(), 0, 'new snapshot must not read the still-attached old native document')
      assert.equal(f.jumps(), 0)
      assert.equal(f.listeners.size, 1)
      // Native attachment does not emit a workspace watch notification. The
      // bounded attachment poll must observe it independently.
      f.options.current().document = native
    } else {
      f.update({ document: native })
      await Promise.resolve()
      assert.equal(newReads, 0, 'new native bytes must not bypass the old UI draft revision')
      assert.equal(f.jumps(), 0)
      f.update({ snapshot: next })
    }
    assert.equal(await pending, 'opened', order)
    assert.equal(f.reads(), 0, order)
    assert.equal(newReads, 1, order)
    assert.equal(f.jumps(), 1, order)
    assert.equal(f.listeners.size, 0, order)
  }
})

test('a mismatched native attachment stays bounded and cannot navigate after timeout or cancellation', async () => {
  for (const finish of ['timeout', 'cancel']) {
    const f = fixture(), controller = new AbortController()
    const next = { ...f.snapshot, reader: { ...f.snapshot.reader, bytesHash: hash('saved bytes') } }
    f.update({ snapshot: next })
    const pending = navigateAgentRequest(request({ target: target({ sourceDigest: next.reader.bytesHash }) }), controller.signal, f.options)
    assert.equal(f.listeners.size, 1)
    if (finish === 'cancel') controller.abort()
    assert.equal(await pending, finish === 'cancel' ? 'unavailable' : 'stale')
    assert.equal(f.reads(), 0)
    assert.equal(f.jumps(), 0)
    assert.equal(f.listeners.size, 0)
  }
})

test('an ahead revision, replaced source, background-only or hidden reader cannot jump', async () => {
  for (const variant of ['ahead', 'source', 'background', 'hidden', 'version']) {
    const f = fixture()
    if (variant === 'ahead') f.update({ snapshot: { ...f.snapshot, revision: 5 } })
    if (variant === 'source') f.update({ snapshot: { ...f.snapshot, reader: { ...f.snapshot.reader, bytesHash: hash('replaced') } } })
    if (variant === 'background') f.update({ snapshot: null as unknown as WorkspaceSnapshot })
    if (variant === 'hidden') f.update({ visible: false })
    if (variant === 'version') f.update({ snapshot: { ...f.snapshot, contentVersion: 'new' } })
    assert.equal(await navigateAgentRequest(request(), new AbortController().signal, f.options), 'stale', variant)
    assert.equal(f.jumps(), 0, variant)
  }
})

test('watch timeout, abort and an intervening edit clean up without touching navigation history', async () => {
  const timeout = fixture()
  timeout.update({ snapshot: { ...timeout.snapshot, revision: 3 } })
  assert.equal(await navigateAgentRequest(request(), new AbortController().signal, timeout.options), 'stale')
  assert.equal(timeout.listeners.size, 0)
  const cancelled = fixture(), controller = new AbortController()
  cancelled.update({ snapshot: { ...cancelled.snapshot, revision: 3 } })
  const pending = navigateAgentRequest(request(), controller.signal, cancelled.options)
  controller.abort()
  assert.equal(await pending, 'unavailable')
  assert.equal(cancelled.listeners.size, 0)
  const changed = fixture()
  const read = changed.options.current().document!
  const original = read.text.bind(read)
  read.text = async (...args) => { const result = await original(...args); changed.update({ snapshot: { ...changed.snapshot, revision: 5 } }); return result }
  assert.equal(await navigateAgentRequest(request(), new AbortController().signal, changed.options), 'stale')
  assert.equal(changed.jumps(), 0)
})

test('the navigation guard catches changes during viewport positioning and preserves cancellation', async () => {
  const f = fixture()
  f.options.jump = async (_page, _position, _remember, guard) => {
    assert.ok(guard)
    f.update({ snapshot: { ...f.snapshot, revision: 5 } })
    guard.validate()
    return true
  }
  assert.equal(await navigateAgentRequest(request(), new AbortController().signal, f.options), 'stale')
  assert.equal(f.jumps(), 0)
})
