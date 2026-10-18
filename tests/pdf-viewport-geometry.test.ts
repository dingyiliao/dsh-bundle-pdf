import assert from 'node:assert/strict'
import test from 'node:test'
import { pageAtPointer, suspendScrollAnchoring } from '../src/client/pdf-viewport-geometry.ts'
import { clearWindowLayout, setWindowLayout } from '../src/client/native/window-layout.ts'

class TestElement {
  dataset: { pageNumber?: string } = {}
  parent?: TestElement
  page?: TestElement
  wrappers: TestElement[] = []
  scrollTop = 0
  bounds = { top: 0, bottom: 0 }
  styleValues = new Map<string, { value: string; priority: string }>()
  style = {
    getPropertyValue: (key: string) => this.styleValues.get(key)?.value ?? '',
    getPropertyPriority: (key: string) => this.styleValues.get(key)?.priority ?? '',
    setProperty: (key: string, value: string, priority = '') => { this.styleValues.set(key, { value, priority }) },
    removeProperty: (key: string) => { this.styleValues.delete(key) },
  }
  get children() { return { length: this.wrappers.length, item: (index: number) => this.wrappers[index] } }
  closest(_selector: string) { return this.parent }
  contains(element: TestElement) { return this.wrappers.includes(element) }
  querySelector(selector: string): TestElement | null {
    if (selector === '[data-pdf-page]') return this.page ?? null
    const number = selector.match(/data-page-number="(\d+)"/)?.[1]
    return this.wrappers.find(wrapper => wrapper.dataset.pageNumber === number)?.page ?? null
  }
  getBoundingClientRect() { return this.bounds }
}

async function withElementGlobals(run: () => Promise<void> | void) {
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, 'Element')
  const originalHtmlElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: TestElement })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: TestElement })
  try { await run() } finally {
    for (const [name, original] of [['Element', originalElement], ['HTMLElement', originalHtmlElement]] as const) {
      if (original) Object.defineProperty(globalThis, name, original)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}

function fixture() {
  const root = new TestElement()
  root.bounds = { top: 50, bottom: 350 }
  root.wrappers = [0, 1, 2].map(index => {
    const wrapper = new TestElement()
    wrapper.dataset.pageNumber = String(index + 1)
    wrapper.bounds = { top: 50 + 100 * index, bottom: 150 + 100 * index }
    wrapper.page = new TestElement()
    return wrapper
  })
  return root
}

test('page lookup prefers a pointer-owned page and refuses wrappers outside the reader', async () => {
  await withElementGlobals(() => {
    const root = fixture()
    const target = new TestElement()
    target.parent = root.wrappers[1]
    assert.equal(pageAtPointer(root as unknown as HTMLElement, target as unknown as EventTarget, 60), root.wrappers[1].page)
    target.parent = new TestElement()
    assert.equal(pageAtPointer(root as unknown as HTMLElement, target as unknown as EventTarget, 260), root.wrappers[2].page)
  })
})

test('page lookup uses numeric virtual layout before falling back to binary-search DOM children', async () => {
  await withElementGlobals(() => {
    const root = fixture()
    root.scrollTop = 100
    setWindowLayout(root as unknown as HTMLElement, [1, 2, 3].map((page, index) =>
      ({ page, top: index * 100, width: 80, height: 90, outerHeight: 100, scale: 1 })))
    try {
      assert.equal(pageAtPointer(root as unknown as HTMLElement, null, 80), root.wrappers[1].page)
      assert.equal(pageAtPointer(root as unknown as HTMLElement, null, 180), root.wrappers[2].page)
    } finally { clearWindowLayout(root as unknown as HTMLElement) }
    assert.equal(pageAtPointer(root as unknown as HTMLElement, null, 160), root.wrappers[1].page)
    assert.equal(pageAtPointer(root as unknown as HTMLElement, null, 49), root.wrappers[0].page)
    assert.equal(pageAtPointer(root as unknown as HTMLElement, null, 400), root.wrappers[2].page)
    root.wrappers[1].dataset.pageNumber = undefined
    assert.equal(pageAtPointer(root as unknown as HTMLElement, null, 160), undefined)
    root.wrappers = []
    assert.equal(pageAtPointer(root as unknown as HTMLElement, null, 160), undefined)
  })
})

test('overlapping scroll gestures restore the original anchoring style only after the last release', () => {
  const root = new TestElement()
  root.style.setProperty('overflow-anchor', 'auto', 'important')
  const first = suspendScrollAnchoring(root as unknown as HTMLElement)
  const second = suspendScrollAnchoring(root as unknown as HTMLElement)
  assert.equal(root.style.getPropertyValue('overflow-anchor'), 'none')
  first()
  first()
  assert.equal(root.style.getPropertyValue('overflow-anchor'), 'none')
  second()
  assert.equal(root.style.getPropertyValue('overflow-anchor'), 'auto')
  assert.equal(root.style.getPropertyPriority('overflow-anchor'), 'important')

  root.style.removeProperty('overflow-anchor')
  const third = suspendScrollAnchoring(root as unknown as HTMLElement)
  third()
  assert.equal(root.style.getPropertyValue('overflow-anchor'), '')
})
