import assert from 'node:assert/strict'
import test from 'node:test'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createDocumentToolContext, type PdfToolContext } from '../../../../src/adapters/host/dsh/document-tools.ts'

const agent = { session: { id: 'session' } }
const signal = new AbortController().signal

function fixture(acquire: Parameters<typeof createDocumentToolContext>[1]['acquire']) {
  const definitions = new Map<string, ToolDefinition>()
  const ctx = { get: () => undefined, tools: { register(definition: ToolDefinition) {
    definitions.set(definition.name, definition)
    return () => { definitions.delete(definition.name) }
  } } }
  const wrapped = createDocumentToolContext(ctx as PdfToolContext, { acquire })
  function register(name: string, execute: (raw: unknown, exec: Parameters<ToolDefinition['execute']>[1]) => Promise<Record<string, string>>) {
    return wrapped.tools.register(defineTool({ name, description: 'Lifecycle fixture',
      parameters: { documentId: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute }))
  }
  return { definitions, register, lifecycle: wrapped }
}

test('document operations hold one pin across the whole tool, including approval-like waits', async () => {
  let pinned = 0, acquired = 0
  const f = fixture(async (sessionId, documentId, caller, callerSignal) => {
    assert.equal(sessionId, 'session'); assert.equal(documentId, 'document')
    assert.equal(caller, agent); assert.equal(callerSignal.aborted, false)
    acquired++; pinned++
    return () => { pinned-- }
  })
  for (const name of ['pdf_read_page', 'pdf_form_inspect_page', 'pdf_fill_form', 'pdf_save']) {
    let continueOperation!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    const pause = new Promise<void>(resolve => { continueOperation = resolve })
    const unregister = f.register(name, async () => {
      assert.equal(pinned, 1)
      started()
      await pause
      assert.equal(pinned, 1, 'the document must remain pinned after the awaited operation')
      return { status: 'complete' }
    })
    const result = f.definitions.get(name)!.execute({ documentId: 'document' }, { agent, signal } as never)
    await waiting
    assert.equal(pinned, 1, 'neither cache pressure nor a pending close may retire this copy yet')
    continueOperation()
    assert.deepEqual(await result, { status: 'complete' })
    assert.equal(pinned, 0)
    unregister()
    assert.equal(f.definitions.has(name), false, 'registration ownership is preserved')
  }
  assert.equal(acquired, 4)
})

test('tool errors and cancellation release pins, while rejected acquisition never executes the body', async () => {
  let pinned = 0, calls = 0, rejected = false
  const f = fixture(async () => {
    if (rejected) throw Object.assign(new Error('Missing document'), { code: 'pdf/unknown-document' })
    pinned++
    return () => { pinned-- }
  })
  const controller = new AbortController()
  f.register('pdf_read_page', async (_raw, exec) => {
    calls++
    controller.abort(new Error('Cancelled during native read'))
    exec.signal.throwIfAborted()
    return {}
  })
  const tool = f.definitions.get('pdf_read_page')!
  await assert.rejects(tool.execute({ documentId: 'document' }, { agent, signal: controller.signal } as never), /Cancelled/)
  assert.equal(pinned, 0); assert.equal(calls, 1)
  rejected = true
  await assert.rejects(tool.execute({ documentId: 'document' }, { agent, signal } as never), { code: 'pdf/unknown-document' })
  assert.equal(pinned, 0); assert.equal(calls, 1)
  await assert.rejects(tool.execute({ documentId: 'document' }, { agent, signal: controller.signal } as never), /Cancelled/)
  assert.equal(calls, 1)
})

test('open, close and visible metadata do not acquire pins; invalid arguments retain tool validation', async () => {
  let acquired = 0, executed = 0
  const f = fixture(async () => { acquired++; return () => {} })
  for (const name of ['pdf_open', 'pdf_close', 'pdf_current', 'pdf_read_page']) {
    f.register(name, async () => { executed++; return {} })
    const tool = f.definitions.get(name)!
    if (name !== 'pdf_read_page') await tool.execute({ documentId: 'document' }, { agent, signal } as never)
    else {
      for (const raw of [undefined, {}, { documentId: 42 }]) {
        await assert.rejects(tool.execute(raw, { agent, signal } as never), { code: 'INVALID_ARGS' })
      }
      for (const documentId of ['', 'x'.repeat(513)]) await tool.execute({ documentId }, { agent, signal } as never)
      await tool.execute({ documentId: 'document' }, { signal } as never)
    }
  }
  assert.equal(acquired, 0)
  assert.equal(executed, 6)
})

test('session detach cancels and drains reads and opens before allowing a fresh runtime generation', async () => {
  let pinned = 0, completed = 0
  const f = fixture(async () => { pinned++; return () => { pinned-- } })
  for (const name of ['pdf_open', 'pdf_save']) {
    f.register(name, async (_raw, exec) => {
      try {
        await new Promise<void>((_resolve, reject) => {
          exec.signal.addEventListener('abort', () => { reject(exec.signal.reason) }, { once: true })
        })
        return {}
      } finally { completed++ }
    })
  }
  const calls = ['pdf_open', 'pdf_save'].map(name => f.definitions.get(name)!.execute({ documentId: 'document' }, { agent, signal } as never))
  const settled = Promise.allSettled(calls)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(pinned, 1, 'open is tracked for cancellation without taking a second document pin')
  await f.lifecycle.cancelSession('session')
  const results = await settled
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') assert.equal(result.reason.code, 'pdf/session-disposed')
  }
  assert.equal(pinned, 0); assert.equal(completed, 2)
  f.register('pdf_status', async () => ({ status: 'fresh' }))
  assert.deepEqual(await f.definitions.get('pdf_status')!.execute({ documentId: 'document' }, { agent, signal } as never), { status: 'fresh' })
  await f.lifecycle.dispose()
  assert.equal(pinned, 0)
  await assert.rejects(f.definitions.get('pdf_status')!.execute({ documentId: 'document' }, { agent, signal } as never), { code: 'pdf/unavailable' })
  await f.lifecycle.dispose()
})

test('session retirement keeps admission closed until native release and inspection cleanup finish', async () => {
  for (const previouslyUsed of [false, true]) {
    const f = fixture(async () => () => {})
    const inspectionMappings = new Map<string, string>([['session', 'old-generation']])
    f.register('pdf_form_inspect_page', async () => {
      inspectionMappings.set('session', 'new-generation')
      return { status: 'inspected' }
    })
    const inspect = () => f.definitions.get('pdf_form_inspect_page')!.execute({ documentId: 'document' }, { agent, signal } as never)
    if (previouslyUsed) await inspect()
    inspectionMappings.set('session', 'old-generation')
    let startCleanup!: () => void, finishCleanup!: () => void, cleanupCalls = 0
    const cleaning = new Promise<void>(resolve => { startCleanup = resolve })
    const nativeRelease = new Promise<void>(resolve => { finishCleanup = resolve })
    const retiring = f.lifecycle.cancelSession('session', async () => {
      cleanupCalls++; startCleanup()
      await nativeRelease
      inspectionMappings.delete('session')
    })
    const duplicate = f.lifecycle.cancelSession('session', async () => { throw new Error('Duplicate cleanup must not run') })
    assert.equal(duplicate, retiring, 'duplicate detach shares one retirement promise')
    await cleaning
    await assert.rejects(inspect(), { code: 'pdf/session-disposed' })
    assert.equal(inspectionMappings.get('session'), 'old-generation', 'the new inspection cannot race with old native cleanup')
    finishCleanup()
    await retiring
    assert.equal(cleanupCalls, 1); assert.equal(inspectionMappings.has('session'), false)
    await inspect()
    assert.equal(inspectionMappings.get('session'), 'new-generation', 'old cleanup cannot delete the newly admitted mapping')
    await f.lifecycle.dispose()
  }
})
