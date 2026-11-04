import { createRequire } from 'node:module'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

interface DomOptions {
  url?: string
  globals?: readonly string[]
  values?: Record<string, unknown>
}

/** Each test owns its window and restores the exact globals it temporarily installs. */
export function createDom(html = '<!doctype html><div id="root"></div>', options: DomOptions = {}) {
  const dom = new JSDOM(html, { url: options.url ?? 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  let restored = false
  const install = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
      if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, { configurable: true, value })
    }
  }
  const restore = () => {
    if (restored) return
    restored = true
    try { dom.close() } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    }
  }
  try {
    const keys = options.globals ?? ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
    const values = { ...Object.fromEntries(keys.map(key => [key, key === 'window' ? dom
      : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : (dom as unknown as Record<string, unknown>)[key]])), ...options.values }
    install(values)
  } catch (error) { restore(); throw error }
  return { dom, restore, install }
}
