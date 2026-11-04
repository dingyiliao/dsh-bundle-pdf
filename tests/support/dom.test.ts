import assert from 'node:assert/strict'
import test from 'node:test'
import { createDom } from './dom.ts'

test('DOM fixtures restore original global descriptors and remove newly installed globals', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const fixture = createDom()
  assert.equal(globalThis.document, fixture.dom.document)
  fixture.install({ __pdfDomFixture: 'first' })
  fixture.install({ __pdfDomFixture: 'second' })
  fixture.restore()
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'document'), original)
  assert.equal(Object.hasOwn(globalThis, '__pdfDomFixture'), false)
  fixture.restore()
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'document'), original)
})

test('DOM fixtures leave scenario-specific globals under the test owner’s control', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  class Observer { observe() {} disconnect() {} }
  const fixture = createDom('<div id="custom"></div>', { globals: [], values: { ResizeObserver: Observer } })
  try {
    assert.equal(globalThis.ResizeObserver, Observer)
    assert.ok(fixture.dom.document.getElementById('custom'))
  } finally { fixture.restore() }
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'), original)
})

test('a failing scenario can restore its window and extra globals from finally', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  assert.throws(() => {
    const fixture = createDom()
    try {
      fixture.install({ __pdfDomFailure: true })
      throw new Error('scenario failed')
    } finally { fixture.restore() }
  }, /scenario failed/)
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'window'), original)
  assert.equal(Object.hasOwn(globalThis, '__pdfDomFailure'), false)
})

test('window-close failures cannot leave the test globals installed', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const fixture = createDom()
  const close = fixture.dom.close.bind(fixture.dom)
  fixture.dom.close = () => { close(); throw new Error('window close failed') }
  assert.throws(() => fixture.restore(), /window close failed/)
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'document'), original)
  fixture.restore()
})
