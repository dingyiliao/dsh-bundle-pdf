import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useReaderFormCommits, type ReaderFormCommitOptions } from '../../../src/modules/viewer/rendering/FormCommitContext.tsx'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close(): void } }
}

test('the active form owner reports a rejected write through the latest handler and retains the draft for retry', async () => {
  const dom = new JSDOM('<div id="root"></div>').window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  const error = new Error('field write rejected'), reported: unknown[] = []
  const writes: [string, string | boolean | string[]][] = []
  let rejectWrite!: (error: unknown) => void
  let current!: ReturnType<typeof useReaderFormCommits>
  let options: ReaderFormCommitOptions = {
    identity: 'session:document:content:editable',
    commit: (id, value) => {
      writes.push([id, value])
      return new Promise<boolean>((_resolve, reject) => { rejectWrite = reject })
    },
    onError: () => { assert.fail('a same-document rerender must replace the error handler') },
  }
  const Harness = () => {
    current = useReaderFormCommits(options)
    return React.createElement('output', null, current.pending ? 'pending' : 'clean')
  }
  try {
    await act(async () => root.render(React.createElement(Harness)))
    const owner = current.owner
    let result!: Promise<boolean>
    await act(async () => {
      owner.stage('name', 'edited name', 'original name')
      result = owner.commit('name')
      await Promise.resolve()
    })
    assert.equal(current.pending, true)
    assert.deepEqual(writes, [['name', 'edited name']])

    options = { ...options, onError: value => reported.push(value), commit: async (id, value) => {
      writes.push([id, value]); return true
    } }
    await act(async () => root.render(React.createElement(Harness)))
    assert.equal(current.owner, owner, 'ordinary rerenders keep the staged field owner')
    await act(async () => { rejectWrite(error); assert.equal(await result, false) })
    assert.deepEqual(reported, [error])
    assert.equal(owner.value('name'), 'edited name', 'a failed write retains the exact input for retry')
    assert.equal(current.pending, true)

    await act(async () => { assert.equal(await current.flush(), true) })
    assert.deepEqual(writes, [['name', 'edited name'], ['name', 'edited name']])
    assert.deepEqual(reported, [error], 'retry success does not duplicate the error notification')
    assert.equal(owner.value('name'), undefined)
    assert.equal(current.pending, false)
    assert.equal(dom.document.querySelector('output')?.textContent, 'clean')
  } finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
