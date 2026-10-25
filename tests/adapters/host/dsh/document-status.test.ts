import assert from 'node:assert/strict'
import test from 'node:test'
import { documentCapabilities } from '../../../../src/adapters/host/dsh/document-status.ts'
import { registerPdfAgentTools } from '../../../../src/adapters/host/dsh/agent-tools.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.ts'

const signal = new AbortController().signal
function snapshot(): HostWorkspaceSnapshot {
  return { id: 'document', path: '/fixture.pdf', bytes: new Uint8Array([1, 2, 3]), revision: 3,
    sourceVersion: 'source', contentVersion: 'content', dirty: false, conflict: false, canUndo: false, canRedo: false,
    document: { pageCount: 1, pages: [], annotations: [], signed: false, encrypted: false,
      readOnly: false, outline: [], formKind: 'acroform', formFields: [{ id: 'field', name: 'field',
        type: 'text', value: '', widgets: [{ page: 1, rect: [0, 0, 100, 20] }], readOnly: false, required: false }] },
  }
}

test('capabilities report writable documents and a matching visible Reader, not mere service presence', async () => {
  const result = await documentCapabilities(snapshot(), 'session', { navigation: true, visible: true,
    ocr: { availability: async () => ({ status: 'unavailable', reason: 'Selected OCR model has no image input' }) },
    image: { availability: async () => ({ status: 'available', kind: 'direct-image' }) },
  }, signal)
  assert.equal(result.readOnly, false)
  assert.deepEqual(result.capabilities, { readText: true, searchText: true, findRelatedText: true,
    writeAnnotations: true, fillForms: true, editBookmarks: true, navigateVisibleReader: true,
    ocr: false, imageUnderstanding: true })
  assert.deepEqual(result.capabilityDetails.ocr, { supported: true, available: false,
    reason: 'Selected OCR model has no image input' })
})

test('read-only, signed, encrypted and conflicting documents never advertise currently writable tools', async () => {
  for (const flag of ['readOnly', 'signed', 'encrypted', 'conflict'] as const) {
    const state = snapshot()
    if (flag === 'conflict') state.conflict = true
    else state.document[flag] = true
    const result = await documentCapabilities(state, 'session', { navigation: true, visible: false }, signal)
    assert.equal(result.readOnly, flag !== 'conflict')
    for (const key of ['writeAnnotations', 'fillForms', 'editBookmarks'] as const) {
      assert.equal(result.capabilities[key], false, flag)
      assert.ok(result.capabilityDetails[key].reason)
    }
    assert.equal(result.capabilityDetails.navigateVisibleReader.supported, true)
    assert.equal(result.capabilities.navigateVisibleReader, false)
  }
})

test('document-level form and outline limitations stay distinct from write permission', async () => {
  const state = snapshot()
  state.document.formKind = 'xfa'
  state.document.outlineReadOnlyReason = 'Outline parent link is not safely editable'
  const result = await documentCapabilities(state, 'session', { navigation: false, visible: true }, signal)
  assert.equal(result.capabilities.writeAnnotations, true)
  assert.deepEqual(result.capabilityDetails.fillForms, { supported: false, available: false,
    reason: 'This PDF has no supported AcroForm' })
  assert.equal(result.capabilityDetails.editBookmarks.supported, false)
  assert.match(result.capabilityDetails.editBookmarks.reason!, /parent link/)
  assert.equal(result.capabilities.navigateVisibleReader, false)
  delete state.document.formKind
  delete state.document.outline
  delete state.document.outlineReadOnlyReason
  const absent = await documentCapabilities(state, 'session', { navigation: false, visible: false }, signal)
  assert.equal(absent.capabilities.editBookmarks, false)
  assert.match(absent.capabilityDetails.editBookmarks.reason!, /could not be inspected/)
  state.document.formKind = 'acroform'
  state.document.formFields![0]!.readOnly = true
  const noFields = await documentCapabilities(state, 'session', { navigation: false, visible: false }, signal)
  assert.equal(noFields.capabilityDetails.fillForms.supported, true)
  assert.equal(noFields.capabilities.fillForms, false)
  assert.match(noFields.capabilityDetails.fillForms.reason!, /no writable form fields/)
})

test('missing or broken selected backends report safe reasons and preserve cancellation', async () => {
  const missing = await documentCapabilities(snapshot(), 'session', { navigation: false, visible: false }, signal)
  assert.equal(missing.capabilityDetails.ocr.supported, false)
  assert.match(missing.capabilityDetails.ocr.reason!, /not installed/)
  const broken = await documentCapabilities(snapshot(), 'session', { navigation: false, visible: false,
    ocr: { availability: async () => { throw new Error('private backend details') } },
  }, signal)
  assert.equal(broken.capabilityDetails.ocr.supported, true)
  assert.match(broken.capabilityDetails.ocr.reason!, /could not be verified/)
  assert.doesNotMatch(JSON.stringify(broken), /private backend details/)
  const controller = new AbortController()
  await assert.rejects(documentCapabilities(snapshot(), 'session', { navigation: false, visible: false,
    ocr: { availability: async () => { controller.abort(new Error('cancel capability probe')); throw controller.signal.reason } },
  }, controller.signal), /cancel capability probe/)
})

function statusTool(services: Record<string, unknown> = {}) {
  let current = snapshot()
  let released = 0
  let visible = true
  let execute: (raw: unknown, exec: unknown) => Promise<unknown> = async () => { throw new Error('not registered') }
  const workspaces = { readSnapshot(session: string, id: string) {
    assert.equal(session, 'session'); assert.equal(id, current.id); return current
  }, async acquire() { return () => { released++ } }, onIdle() { return () => {} }, touch() {}, listDocuments() { return [] } }
  const ctx = { get: (name: string) => services[name], tools: { register(definition: { name: string; execute: typeof execute }) {
    if (definition.name === 'pdf_status') execute = definition.execute
    return () => {}
  } } }
  const dispose = registerPdfAgentTools(ctx as never, workspaces as never, {} as never,
    { current: () => visible ? [{ tabId: 'tab', documentId: current.id, contentVersion: current.contentVersion, page: 1 }] : [] })
  return { dispose, released: () => released,
    replace() { current = { ...current, revision: current.revision + 1 } },
    conflict() { current = { ...current, conflict: true } },
    hide() { visible = false },
    run: () => execute({ documentId: current.id }, { signal, agent: { session: { id: 'session', header: {} } } }),
  }
}

test('registered pdf_status probes PDF-configured engines and serializes supported/available details', async () => {
  const calls: unknown[] = []
  const h = statusTool({ pdfAiSettings: () => ({ ocrEngine: 'custom-ocr', imageEngine: 'custom-vision',
    engineConfigurations: {} }),
    ocr: { availability: async (session: string, _signal: AbortSignal, binding: unknown) => {
      calls.push(['ocr', session, binding]); return { status: 'unavailable', reason: 'Configure OCR credentials' }
    } }, imageUnderstanding: { availability: async (session: string, _signal: AbortSignal,
      binding: unknown, ocrBinding: unknown) => {
      calls.push(['image', session, binding, ocrBinding]); return { status: 'available', kind: 'direct-image' }
    } },
  })
  try {
    const result = await h.run() as Awaited<ReturnType<typeof documentCapabilities>> & { visibleInReader: boolean }
    assert.equal(result.visibleInReader, true)
    assert.equal(result.capabilities.navigateVisibleReader, false, 'visible hint is not an installed navigation service')
    assert.equal(result.capabilities.ocr, false)
    assert.equal(result.capabilities.imageUnderstanding, true)
    assert.match(JSON.stringify(calls), /custom-ocr/)
    assert.match(JSON.stringify(calls), /custom-vision/)
    assert.equal(h.released(), 1)
  } finally { await h.dispose() }
})

test('registered pdf_status refuses a report invalidated while probing an engine', async () => {
  const h = statusTool({ ocr: { availability: async () => { h.replace(); return { status: 'available' } } } })
  try {
    await assert.rejects(h.run(), { code: 'pdf/stale-reader' })
    assert.equal(h.released(), 1)
  } finally { await h.dispose() }
})

test('status rejects same-revision conflict, visibility or selected-engine changes during availability probes', async () => {
  for (const change of ['conflict', 'visibility', 'engine'] as const) {
    let selected = 'first-ocr'
    const h = statusTool({ pdfAiSettings: () => ({ ocrEngine: selected }),
      ocr: { availability: async () => {
        if (change === 'conflict') h.conflict()
        if (change === 'visibility') h.hide()
        if (change === 'engine') selected = 'another-ocr'
        return { status: 'available' }
      } },
    })
    try { await assert.rejects(h.run(), { code: 'pdf/stale-reader' }) }
    finally { await h.dispose() }
  }
})
