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

function recoveryWire(id: string, revision: number) {
  return { ok: true, value: { ...testWire(id).value, path: '/document.pdf', revision } }
}

async function within<T>(promise: Promise<T>, milliseconds = 4000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for PDF recovery')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

test('a watch transport failure retries the same document and refreshes it without reopening', async () => {
  const lifetime = new AbortController()
  let opens = 0, watches = 0
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    const request = payload as Record<string, unknown>
    if (method === 'pdf.watch') {
      assert.equal(request.id, 'document')
      if (++watches === 1) throw new Error('Temporary transport failure')
      if (watches === 2) return { ok: true, value: { revision: 1 } }
      return new Promise(() => {})
    }
    if (request.action === 'open') {
      opens++
      return recoveryWire('document', 0)
    }
    if (request.action === 'refresh') {
      assert.equal(request.id, 'document')
      return recoveryWire('document', 1)
    }
    throw new Error(`Unexpected action ${String(request.action)}`)
  } } }, lifetime.signal)
  try {
    await api.open('session', 'dsh-resource://file/session/session/document.pdf', undefined, 'view-a')
    const updated = new Promise<void>(resolve => {
      api.subscribe('document', snapshot => { if (snapshot.revision === 1) resolve() })
    })
    await within(updated)
    assert.equal(opens, 1)
  } finally { lifetime.abort() }
})

test('a mounted Reader reacquires a new Host ID from an unknown watch and migrates its UI references', async () => {
  const lifetime = new AbortController()
  const calls: Array<{ method: string; request: Record<string, unknown> }> = []
  let opens = 0
  let watchingNew!: () => void
  const newWatch = new Promise<void>(resolve => { watchingNew = resolve })
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    const request = payload as Record<string, unknown>
    calls.push({ method, request })
    if (method === 'pdf.watch') {
      if (request.id === 'old') return { ok: false, error: { code: 'pdf/unknown-document', message: 'old ID lost' } }
      watchingNew()
      return new Promise(() => {})
    }
    if (request.action === 'release') return { ok: true, value: { status: 'released' } }
    if (request.action === 'open') return recoveryWire(++opens <= 2 ? 'old' : 'new', opens <= 2 ? 7 : 0)
    throw new Error(`Unexpected ${String(request.action)}`)
  } } }, lifetime.signal)
  try {
    const address = 'dsh-resource://file/session/session/document.pdf'
    await api.open('session', address, undefined, 'view-a')
    await api.open('session', address, undefined, 'view-b')
    let resolve!: (value: import('../src/shared/contracts.ts').WorkspaceSnapshot) => void
    const received = new Promise<import('../src/shared/contracts.ts').WorkspaceSnapshot>(accept => { resolve = accept })
    const stop = api.subscribe('old', value => { if (value.id === 'new') resolve(value) })
    const value = await received
    await newWatch
    assert.equal(value.id, 'new')
    assert.equal(value.revision, 0, 'a fresh Host can legitimately reset the revision')
    assert.deepEqual(calls.filter(call => call.request.action === 'open').slice(2).map(call => call.request.referenceId), ['view-a', 'view-b'])
    assert.equal(calls.filter(call => call.method === 'pdf.watch' && call.request.id === 'new').length, 1)
    await api.release('session', 'old', 'view-a')
    assert.deepEqual(calls.at(-1)?.request, { action: 'release', sessionId: 'session', id: 'new', referenceId: 'view-a' })
    stop() // the original unsubscribe must remove the migrated listener
    await api.release('session', 'old', 'view-b')
    assert.deepEqual(calls.at(-1)?.request, { action: 'release', sessionId: 'session', id: 'new', referenceId: 'view-b' })
  } finally { lifetime.abort() }
})

test('React subscription handoff after Host ID recovery keeps the new watch baseline', { timeout: 6000 }, async () => {
  const lifetime = new AbortController()
  let opens = 0, newWatchCount = 0, revision = 0
  let secondWatchStarted!: () => void
  const watchingAgain = new Promise<void>(resolve => { secondWatchStarted = resolve })
  let wakeSecondWatch!: (value: unknown) => void
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    const request = payload as Record<string, unknown>
    if (method === 'pdf.watch') {
      if (request.id === 'old') return { ok: false, error: { code: 'pdf/unknown-document', message: 'Host restarted' } }
      assert.equal(request.id, 'new')
      assert.equal(request.knownRevision, 0, 'the replacement snapshot remains the watch baseline')
      if (++newWatchCount === 2) {
        secondWatchStarted()
        return new Promise(resolve => { wakeSecondWatch = resolve })
      }
      return new Promise(() => {})
    }
    if (request.action === 'open') return recoveryWire(++opens === 1 ? 'old' : 'new', opens === 1 ? 5 : 0)
    if (request.action === 'refresh') {
      assert.equal(request.id, 'new')
      return recoveryWire('new', revision)
    }
    if (request.action === 'release') return { ok: true, value: { status: 'released' } }
    throw new Error(`Unexpected ${String(request.action)}`)
  } } }, lifetime.signal)
  try {
    await api.open('session', 'dsh-resource://file/session/session/document.pdf', undefined, 'view-a')
    let onRecovered!: () => void
    const recovered = new Promise<void>(resolve => { onRecovered = resolve })
    const stopOld = api.subscribe('old', value => { if (value.id === 'new') onRecovered() })
    await within(recovered)
    stopOld() // React's old-ID effect cleans up before its new-ID effect subscribes.
    let onEdit!: (value: number) => void
    const edited = new Promise<number>(resolve => { onEdit = resolve })
    const stopNew = api.subscribe('new', value => { if (value.revision > 0) onEdit(value.revision) })
    await within(watchingAgain)
    revision = 1
    wakeSecondWatch({ ok: true, value: { revision } })
    assert.equal(await within(edited), 1)
    stopNew()
    await api.release('session', 'old', 'view-a')
  } finally { lifetime.abort() }
})

test('releasing one view during held reacquisition still recovers the surviving visible view', { timeout: 6000 }, async () => {
  const lifetime = new AbortController()
  const calls: Array<{ method: string; request: Record<string, unknown> }> = []
  let opens = 0
  let recoveryStarted!: () => void
  const started = new Promise<void>(resolve => { recoveryStarted = resolve })
  let deliverHeldOpen!: (value: unknown) => void
  let newWatchStarted!: () => void
  const newWatch = new Promise<void>(resolve => { newWatchStarted = resolve })
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    const request = payload as Record<string, unknown>
    calls.push({ method, request })
    if (method === 'pdf.watch') {
      if (request.id === 'old') return { ok: false, error: { code: 'pdf/unknown-document', message: 'Host restarted' } }
      newWatchStarted()
      return new Promise(() => {})
    }
    if (request.action === 'open') {
      opens++
      if (opens <= 2) return recoveryWire('old', 5)
      if (opens === 3) {
        recoveryStarted()
        return new Promise(resolve => { deliverHeldOpen = resolve })
      }
      return recoveryWire('new', 0)
    }
    if (request.action === 'release') return { ok: true, value: { status: 'released' } }
    throw new Error(`Unexpected ${String(request.action)}`)
  } } }, lifetime.signal)
  try {
    const address = 'dsh-resource://file/session/session/document.pdf'
    await api.open('session', address, undefined, 'view-a')
    await api.open('session', address, undefined, 'view-b')
    let publish!: (value: import('../src/shared/contracts.ts').WorkspaceSnapshot) => void
    const published = new Promise<import('../src/shared/contracts.ts').WorkspaceSnapshot>(resolve => { publish = resolve })
    const stop = api.subscribe('old', value => { if (value.id === 'new') publish(value) })
    await within(started)
    await api.release('session', 'old', 'view-a')
    deliverHeldOpen(recoveryWire('new', 0))
    assert.equal((await within(published)).id, 'new')
    await within(newWatch)
    assert.deepEqual(calls.filter(call => call.request.action === 'open').slice(2).map(call => call.request.referenceId),
      ['view-a', 'view-b'], 'late response for the closed view must not reacquire it again')
    assert.ok(calls.some(call => call.request.action === 'release'
      && call.request.id === 'new' && call.request.referenceId === 'view-a'),
    'the late Host lease of the closed view must be released')
    stop()
    await api.release('session', 'old', 'view-b')
    assert.equal(calls.at(-1)?.request.id, 'new', 'the surviving view releases its recovered Host ID')
  } finally { lifetime.abort() }
})

test('unknown Host ID followed by one transport failure retries only while the view remains visible', { timeout: 6000 }, async () => {
  const lifetime = new AbortController()
  let opens = 0, unknownWatches = 0
  let watchingNew!: () => void
  const newWatch = new Promise<void>(resolve => { watchingNew = resolve })
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    const request = payload as Record<string, unknown>
    if (method === 'pdf.watch') {
      if (request.id === 'old') {
        unknownWatches++
        return { ok: false, error: { code: 'pdf/unknown-document', message: 'Host restarted' } }
      }
      watchingNew()
      return new Promise(() => {})
    }
    if (request.action === 'open') {
      opens++
      if (opens === 1) return recoveryWire('old', 5)
      if (opens === 2) throw new Error('temporary transport failure')
      return recoveryWire('new', 0)
    }
    if (request.action === 'release') return { ok: true, value: { status: 'released' } }
    throw new Error(`Unexpected ${String(request.action)}`)
  } } }, lifetime.signal)
  try {
    await api.open('session', 'dsh-resource://file/session/session/document.pdf', undefined, 'view-a')
    let publish!: (value: import('../src/shared/contracts.ts').WorkspaceSnapshot) => void
    const published = new Promise<import('../src/shared/contracts.ts').WorkspaceSnapshot>(resolve => { publish = resolve })
    const stop = api.subscribe('old', value => { if (value.id === 'new') publish(value) })
    assert.equal((await within(published)).id, 'new')
    await within(newWatch)
    assert.equal(opens, 3, 'recovery retries once after the transient carrier failure')
    assert.equal(unknownWatches, 2, 'a fresh coded unknown-document watch, not the transport failure, authorizes another open')
    stop()
    await api.release('session', 'old', 'view-a')
  } finally { lifetime.abort() }
})

test('permission denial during unknown-ID reacquisition does not retry or acquire another view', { timeout: 4000 }, async () => {
  const lifetime = new AbortController()
  let opens = 0, watches = 0
  let denied!: () => void
  const denial = new Promise<void>(resolve => { denied = resolve })
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    const request = payload as Record<string, unknown>
    if (method === 'pdf.watch') {
      watches++
      return { ok: false, error: { code: 'pdf/unknown-document', message: 'Host restarted' } }
    }
    if (request.action === 'open') {
      if (++opens === 1) return recoveryWire('old', 0)
      denied()
      return { ok: false, error: { code: 'pdf/forbidden', message: 'Permission denied' } }
    }
    if (request.action === 'release') return { ok: true, value: { status: 'released' } }
    throw new Error(`Unexpected ${String(request.action)}`)
  } } }, lifetime.signal)
  try {
    await api.open('session', 'dsh-resource://file/session/session/document.pdf', undefined, 'view-a')
    const stop = api.subscribe('old', () => {})
    await within(denial)
    await new Promise<void>(resolve => setTimeout(resolve, 700))
    assert.equal(opens, 2, 'permission denial must not be treated as a retryable carrier failure')
    assert.equal(watches, 1, 'a forbidden recovery must stop automatic unknown-ID polling')
    stop()
    await api.release('session', 'old', 'view-a')
  } finally { lifetime.abort() }
})

test('an explicit refresh shares reacquisition and does not reuse an old Host revision', async () => {
  const lifetime = new AbortController()
  const calls: Record<string, unknown>[] = []
  let opens = 0
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    const request = payload as Record<string, unknown>
    calls.push(request)
    if (method === 'pdf.watch') return new Promise(() => {})
    if (request.action === 'open') return recoveryWire(++opens === 1 ? 'old' : 'new', opens === 1 ? 9 : 0)
    if (request.action === 'refresh') return { ok: false, error: { code: 'pdf/unknown-document', message: 'Host restarted' } }
    if (request.action === 'release') return { ok: true, value: { status: 'released' } }
    throw new Error('Unexpected action')
  } } }, lifetime.signal)
  try {
    await api.open('session', 'dsh-resource://file/session/session/document.pdf', undefined, 'view-a')
    const stop = api.subscribe('old', () => {})
    const [first, second] = await Promise.all([api.refresh('session', 'old'), api.refresh('session', 'old')])
    assert.equal(first.id, 'new')
    assert.equal(first.revision, 0)
    assert.equal(second.id, 'new')
    assert.equal(opens, 2, 'concurrent refreshes must share one open')
    assert.deepEqual(calls.filter(call => call.action === 'open')[1], {
      action: 'open', sessionId: 'session', address: 'dsh-resource://file/session/session/document.pdf', referenceId: 'view-a',
    })
    stop()
    await api.release('session', 'old', 'view-a')
  } finally { lifetime.abort() }
})

test('closing a view during reacquisition releases its late Host reference without publishing it', async () => {
  const lifetime = new AbortController()
  let deliverOpen!: (value: unknown) => void
  let recoveryStarted!: () => void
  const started = new Promise<void>(resolve => { recoveryStarted = resolve })
  let cleanupDone!: () => void
  const cleaned = new Promise<void>(resolve => { cleanupDone = resolve })
  const calls: Record<string, unknown>[] = []
  let opens = 0
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    const request = payload as Record<string, unknown>
    calls.push(request)
    if (method === 'pdf.watch') return { ok: false, error: { code: 'pdf/unknown-document', message: 'Host restarted' } }
    if (request.action === 'open') {
      if (++opens === 1) return recoveryWire('old', 5)
      recoveryStarted()
      return new Promise(resolve => { deliverOpen = resolve })
    }
    if (request.action === 'release') {
      if (request.id === 'new') cleanupDone()
      return { ok: true, value: { status: 'released' } }
    }
    throw new Error('Unexpected action')
  } } }, lifetime.signal)
  try {
    await api.open('session', 'dsh-resource://file/session/session/document.pdf', undefined, 'view-a')
    const received: string[] = []
    const stop = api.subscribe('old', value => { received.push(value.id) })
    await started
    await api.release('session', undefined, 'view-a')
    stop()
    deliverOpen(recoveryWire('new', 0))
    await cleaned
    assert.deepEqual(received, [])
    assert.deepEqual(calls.filter(call => call.action === 'release').map(call => call.id), [undefined, 'new'])
  } finally { lifetime.abort() }
})

test('permission and transport errors never trigger an implicit reopen', async () => {
  for (const problem of [{ ok: false, error: { code: 'pdf/forbidden', message: 'Forbidden' } }, new Error('offline')]) {
    const lifetime = new AbortController()
    const calls: Record<string, unknown>[] = []
    let opened = false
    const api = createPdfApi({ rpc: { async call(_path, method, payload) {
      const request = payload as Record<string, unknown>
      calls.push(request)
      if (method === 'pdf.watch') return new Promise(() => {})
      if (request.action === 'open') { opened = true; return recoveryWire('old', 0) }
      if (request.action === 'refresh') {
        if (problem instanceof Error) throw problem
        return problem
      }
      if (request.action === 'release') return { ok: true, value: { status: 'released' } }
      throw new Error('Unexpected action')
    } } }, lifetime.signal)
    try {
      await api.open('session', 'dsh-resource://file/session/session/document.pdf', undefined, 'view-a')
      const stop = api.subscribe('old', () => {})
      await assert.rejects(api.refresh('session', 'old'))
      assert.equal(opened, true)
      assert.equal(calls.filter(call => call.action === 'open').length, 1)
      stop()
      await api.release('session', 'old', 'view-a')
    } finally { lifetime.abort() }
  }
})

test('reacquisition rejects a changed source path and releases the new reference', async () => {
  const lifetime = new AbortController()
  const calls: Record<string, unknown>[] = []
  let opens = 0
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    const request = payload as Record<string, unknown>
    calls.push(request)
    if (method === 'pdf.watch') return new Promise(() => {})
    if (request.action === 'open') {
      const wire = recoveryWire(++opens === 1 ? 'old' : 'foreign', 0)
      if (opens > 1) wire.value.path = '/other.pdf'
      return wire
    }
    if (request.action === 'refresh') return { ok: false, error: { code: 'pdf/unknown-document', message: 'Host restarted' } }
    if (request.action === 'release') return { ok: true, value: { status: 'released' } }
    throw new Error('Unexpected action')
  } } }, lifetime.signal)
  try {
    await api.open('session', 'dsh-resource://file/session/session/document.pdf', undefined, 'view-a')
    const stop = api.subscribe('old', () => {})
    await assert.rejects(api.refresh('session', 'old'), /different source/)
    assert.deepEqual(calls.filter(call => call.action === 'release')[0], {
      action: 'release', sessionId: 'session', id: 'foreign', referenceId: 'view-a',
    })
    stop()
    await api.release('session', 'old', 'view-a')
  } finally { lifetime.abort() }
})

test('reacquisition rejects an ID already owned by another session even when the source path matches', async () => {
  const lifetime = new AbortController()
  const releases: Record<string, unknown>[] = []
  let opens = 0
  const api = createPdfApi({ rpc: { async call(_path, method, payload) {
    const request = payload as Record<string, unknown>
    if (method === 'pdf.watch') return new Promise(() => {})
    if (request.action === 'open') return recoveryWire(++opens === 1 ? 'old' : 'other', 0)
    if (request.action === 'refresh') return { ok: false, error: { code: 'pdf/unknown-document', message: 'Host restarted' } }
    if (request.action === 'release') {
      releases.push(request)
      return { ok: true, value: { status: 'released' } }
    }
    throw new Error(`Unexpected action ${String(request.action)}`)
  } } }, lifetime.signal)
  try {
    await api.open('session', 'dsh-resource://file/session/session/document.pdf', undefined, 'view-a')
    await api.open('other-session', 'dsh-resource://file/session/other-session/document.pdf', undefined, 'view-b')
    const received: string[] = []
    const stop = api.subscribe('old', value => received.push(value.id))
    await assert.rejects(api.refresh('session', 'old'), /crossed source ownership/)
    assert.ok(received.every(id => id === 'old'))
    assert.deepEqual(releases, [{ action: 'release', sessionId: 'session', id: 'other', referenceId: 'view-a' }])
    stop()
    await api.release('other-session', 'other', 'view-b')
    assert.deepEqual(releases.at(-1), { action: 'release', sessionId: 'other-session', id: 'other', referenceId: 'view-b' })
  } finally { lifetime.abort() }
})

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
