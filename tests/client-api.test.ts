import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createPdfApi } from '../src/adapters/client/remote/pdf-api.ts'

test('accepts native snapshots without transferring PDF bytes or inventing a MediaBox', async () => {
  const bytesHash = `sha256:${createHash('sha256').update('native snapshot').digest('hex')}`
  const api = createPdfApi({ rpc: { async call(path, method) {
    assert.equal(path, '/api')
    assert.equal(method, 'pdf.dispatch.v2')
    return { ok: true, value: {
      id: 'native-pdf', path: 'D:/workspace/document.pdf', sourceVersion: 'source', contentVersion: 'content',
      revision: 0, dirty: false, canUndo: false, canRedo: false, conflict: false,
      reader: { bytesHash, generation: 1, protocolVersion: 1 },
      document: {
        pageCount: 1, signed: false, encrypted: false, readOnly: false,
        pages: [{ page: 1, cropBox: [0, 0, 200, 300], rotation: 0, userUnit: 1 }],
        annotations: [{ id: 'native-highlight', page: 1, subtype: 'Highlight', flags: 4,
          supported: true, editable: true }],
      },
    } }
  } } }, new AbortController().signal)
  const snapshot = await api.open('test-session', 'dsh-resource://file/session/test-session/D%3A/workspace/document.pdf')
  assert.equal('bytes' in snapshot, false)
  assert.equal(snapshot.reader.generation, 1)
  assert.equal(snapshot.document.encrypted, false)
  assert.equal(snapshot.document.readOnly, false)
  assert.equal(snapshot.document.pages[0].mediaBox, undefined)
  assert.equal(snapshot.document.annotations[0].editable, true)
})

test('the reading-position API sends only the stored shape and reports staleness', async () => {
  const calls: { method: string; payload: Record<string, unknown> }[] = []
  const position = { page: 3, x: 12, y: 34, scale: 1.25, fit: 'custom' as const, viewportAnchor: { x: 0.5, y: 0 } }
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    calls.push({ method, payload: payload as Record<string, unknown> })
    if ((payload as { action: string }).action === 'get') {
      return { ok: true, value: { position: { position, stale: 'content-changed', updatedAt: '2026-10-16T00:00:00.000Z' } } }
    }
    return { ok: true, value: { stored: true } }
  } } }, new AbortController().signal)

  // `documentVersion` belongs to one open document and must not be stored.
  await api.positions.set('session', 'doc-1', { ...position })
  assert.deepEqual(calls[0], { method: 'pdf.position',
    payload: { action: 'set', sessionId: 'session', id: 'doc-1', position } })
  assert.equal('documentVersion' in (calls[0]!.payload.position as object), false)

  const stored = await api.positions.get('session', 'doc-1')
  assert.equal(stored?.stale, 'content-changed')
  assert.deepEqual(stored?.position, position)
  assert.equal(stored?.updatedAt, '2026-10-16T00:00:00.000Z')
  assert.deepEqual(calls[1], { method: 'pdf.position', payload: { action: 'get', sessionId: 'session', id: 'doc-1' } })
})

test('an absent reading position reads as null rather than an error', async () => {
  const api = createPdfApi({ rpc: { async call() { return { ok: true, value: { position: null } } } } }, new AbortController().signal)
  assert.equal(await api.positions.get('session', 'doc-1'), null)
})

test('an external Host draft edit refreshes an already-open Reader snapshot', async () => {
  const lifetime = new AbortController()
  let revision = 0
  let wake!: (value: unknown) => void
  let watchStarted!: () => void
  const watching = new Promise<void>(resolve => { watchStarted = resolve })
  const api = createPdfApi({ rpc: { async call(_path, method) {
    if (method === 'pdf.watch') {
      watchStarted()
      return new Promise(resolve => { wake = resolve })
    }
    assert.equal(method, 'pdf.dispatch.v2')
    return { ok: true, value: {
      id: 'doc', path: '/document.pdf', sourceVersion: 'source', contentVersion: 'content', revision,
      dirty: revision > 0, canUndo: revision > 0, canRedo: false, conflict: false,
      reader: { bytesHash: `sha256:${'a'.repeat(64)}`, generation: 1, protocolVersion: 1 },
      document: { pageCount: 1, signed: false, encrypted: false, readOnly: false,
        pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }],
        annotations: revision ? [{ id: 'ai-edit', page: 1, subtype: 'Highlight', flags: 4,
          supported: true, editable: true }] : [] },
    } }
  } } }, lifetime.signal)
  try {
    const opened = await api.open('session', 'dsh-resource://file/session/session/document.pdf')
    assert.equal(opened.revision, 0)
    let refreshed!: (value: number) => void
    const received = new Promise<number>(resolve => { refreshed = resolve })
    const unsubscribe = api.subscribe(opened.id, value => { if (value.revision > 0) refreshed(value.revision) })
    await watching
    revision = 1
    wake({ ok: true, value: { revision } })
    assert.equal(await received, 1)
    unsubscribe()
  } finally { lifetime.abort() }
})

test('multiple UI references share updates and watch refresh never reopens a released view', async () => {
  const lifetime = new AbortController()
  const calls: Record<string, unknown>[] = []
  let revision = 0
  let wake!: (value: unknown) => void
  let watchSignal: AbortSignal | undefined
  let watchStarted!: () => void
  let watching = new Promise<void>(resolve => { watchStarted = resolve })
  const api = createPdfApi({ rpc: { async call(_path, method, payload, signal) {
    const request = payload as Record<string, unknown>
    calls.push(request)
    if (method === 'pdf.watch') {
      watchSignal = signal
      watchStarted()
      return new Promise(resolve => { wake = resolve })
    }
    if (request.action === 'release') return { ok: true, value: { released: true } }
    return { ok: true, value: {
      id: 'shared', path: '/form.pdf', sourceVersion: 'source', contentVersion: 'content', revision,
      dirty: revision > 0, canUndo: revision > 0, canRedo: false, conflict: false,
      reader: { bytesHash: `sha256:${'a'.repeat(64)}`, generation: 1, protocolVersion: 1 },
      document: { pageCount: 1, signed: false, encrypted: false, readOnly: false,
        pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }], annotations: [],
        formFields: [{ id: 'field', name: 'Name', type: 'text', value: revision ? 'Model edit' : '',
          widgets: [{ page: 1, rect: [0, 0, 50, 20] }], readOnly: false, required: false }] },
    } }
  } } }, lifetime.signal)
  try {
    const address = 'dsh-resource://file/session/session/form.pdf'
    await api.open('session', address, undefined, 'view-a')
    await api.open('session', address, undefined, 'view-b')
    let receive!: (snapshot: import('../src/shared/contracts.ts').WorkspaceSnapshot) => void
    const received = new Promise<import('../src/shared/contracts.ts').WorkspaceSnapshot>(resolve => { receive = resolve })
    const unsubscribe = api.subscribe('shared', value => { if (value.revision > 0) receive(value) })
    await watching
    await api.release('session', 'shared', 'view-a')
    assert.equal(watchSignal?.aborted, false, 'releasing one tab must retain another tab’s watch')
    revision = 1
    wake({ ok: true, value: { revision } })
    const updated = await received
    assert.equal(updated.document.formFields?.[0]?.value, 'Model edit')
    assert.deepEqual(calls.filter(call => call.action === 'refresh'), [{ action: 'refresh', sessionId: 'session', id: 'shared',
      knownBytesHash: `sha256:${'a'.repeat(64)}`, knownRevision: 0 }])
    assert.equal(calls.filter(call => call.action === 'open').length, 2, 'refresh must not acquire another lease')
    unsubscribe()
    watching = new Promise<void>(resolve => { watchStarted = resolve })
    await api.open('session', address, undefined, 'view-b')
    const stop = api.subscribe('shared', () => {})
    await watching
    await api.release('session', 'shared', 'view-b')
    assert.equal(watchSignal?.aborted, true, 'final occurrence release stops its watch')
    stop()
    assert.deepEqual(calls.filter(call => call.action === 'release').map(call => call.referenceId), ['view-a', 'view-b'])
  } finally { lifetime.abort() }
})

function testWire(id: string) {
  return { ok: true, value: {
    id, path: `/${id}.pdf`, sourceVersion: 'source', contentVersion: 'content', revision: 0,
    dirty: false, canUndo: false, canRedo: false, conflict: false,
    reader: { bytesHash: `sha256:${'a'.repeat(64)}`, generation: 1, protocolVersion: 1 },
    document: { pageCount: 1, signed: false, encrypted: false, readOnly: false,
      pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }], annotations: [] },
  } }
}

test('reference cleanup uses a fresh bounded transport after Client lifetime aborts', async () => {
  const lifetime = new AbortController()
  const calls: Array<{ payload: object; signal: AbortSignal | undefined }> = []
  const api = createPdfApi({ rpc: { async call(_path, _method, payload, signal) {
    calls.push({ payload, signal })
    return { ok: true, value: { status: 'released' } }
  } } }, lifetime.signal)
  lifetime.abort()
  await api.release('session', undefined, 'view-a')
  assert.deepEqual(calls[0]?.payload, { action: 'release', sessionId: 'session', referenceId: 'view-a' })
  assert.notEqual(calls[0]?.signal, lifetime.signal)
  assert.equal(calls[0]?.signal?.aborted, false)
  await assert.rejects(api.open('session', 'dsh-resource://file/session/session/a.pdf', undefined, 'view-a'), { name: 'AbortError' })
  assert.equal(calls.length, 1)
})

test('terminal reference cleanup covers multiple documents but preserves other views', async () => {
  const lifetime = new AbortController()
  const watches = new Map<string, AbortSignal | undefined>()
  const calls: Record<string, unknown>[] = []
  const api = createPdfApi({ rpc: { async call(_path, method, payload, signal) {
    const request = payload as Record<string, unknown>
    calls.push(request)
    if (method === 'pdf.watch') {
      watches.set(String(request.id), signal)
      return new Promise(() => {})
    }
    if (request.action === 'release') return { ok: true, value: { status: 'released' } }
    return testWire(String(request.address).endsWith('a.pdf') ? 'a' : 'b')
  } } }, lifetime.signal)
  try {
    await api.open('session', 'dsh-resource://file/session/session/a.pdf', undefined, 'shared-tab')
    await api.open('session', 'dsh-resource://file/session/session/b.pdf', undefined, 'shared-tab')
    await api.open('session', 'dsh-resource://file/session/session/a.pdf', undefined, 'other-tab')
    const stopA = api.subscribe('a', () => {})
    const stopB = api.subscribe('b', () => {})
    await api.release('session', undefined, 'shared-tab')
    assert.equal(watches.get('a')?.aborted, false)
    assert.equal(watches.get('b')?.aborted, true)
    await api.release('session', undefined, 'other-tab')
    assert.equal(watches.get('a')?.aborted, true)
    stopA(); stopB()
    assert.equal(calls.filter(call => call.action === 'release').every(call => !('id' in call)), true)
  } finally { lifetime.abort() }
})

test('an open response arriving after terminal close cannot reactivate the view reference', async () => {
  let deliver!: (value: unknown) => void
  let opened!: () => void
  const openingStarted = new Promise<void>(resolve => { opened = resolve })
  const lifetime = new AbortController()
  let openCalls = 0
  const api = createPdfApi({ rpc: { async call(_path, _method, payload) {
    if ((payload as { action: string }).action === 'release') return { ok: true, value: { status: 'released' } }
    openCalls++
    opened()
    return new Promise(resolve => { deliver = resolve })
  } } }, lifetime.signal)
  const address = 'dsh-resource://file/session/session/a.pdf'
  const pending = api.open('session', address, undefined, 'ended-view')
  await openingStarted
  await api.release('session', undefined, 'ended-view')
  deliver(testWire('late-document'))
  await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(api.open('session', address, undefined, 'ended-view'), { name: 'AbortError' })
  assert.equal(openCalls, 1)
  lifetime.abort()
})

test('cleanup times out even when the carrier ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let transportSignal: AbortSignal | undefined
  const api = createPdfApi({ rpc: { async call(_path, _method, _payload, signal) {
    transportSignal = signal
    return new Promise(() => {})
  } } }, new AbortController().signal)
  const release = api.release('session', undefined, 'blocked-view')
  const failed = assert.rejects(release, { name: 'TimeoutError' })
  await Promise.resolve()
  t.mock.timers.tick(5000)
  await failed
  assert.equal(transportSignal?.aborted, true)
})
