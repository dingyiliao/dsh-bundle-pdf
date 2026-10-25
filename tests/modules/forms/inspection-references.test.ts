import assert from 'node:assert/strict'
import test from 'node:test'
import { createFormInspectionRegistry, inspectFormPage, modelFormInspectionFields,
  type FormInspectionIdentity } from '../../../src/modules/forms/index.ts'
import type { PdfDocumentInfo } from '../../../src/core/pdf-types.ts'

const document: PdfDocumentInfo = { pageCount: 2, signed: false, encrypted: false, readOnly: false,
  pages: [1, 2].map(page => ({ page, cropBox: [0, 0, 200, 300], userUnit: 1, rotation: 0 })), annotations: [],
  formFields: [1, 2].map(page => ({ id: `native-${page}`, name: 'same name', type: 'text', value: 'PRIVATE',
    required: false, readOnly: false, widgets: [{ page, rect: [10, 20, 80, 40] }] })) }
const identity: FormInspectionIdentity = { sessionId: 'session', documentId: 'document', revision: 2,
  contentVersion: 'version', sourceDigest: 'digest' }

test('one inspection scopes identical F01 labels to its physical page and exact originating identity', () => {
  const store = createFormInspectionRegistry()
  const first = inspectFormPage(document, 1), second = inspectFormPage(document, 2)
  const a = store.issue(identity, first, document), b = store.issue(identity, second, document)
  const bindings = store.resolve(a, identity, identity.revision)
  assert.equal(bindings.page, 1)
  assert.equal(bindings.get('F01').fieldId, 'native-1')
  assert.equal(bindings.get('F01').sharedFieldKey, 'G1')
  assert.equal(store.resolve(b, identity, identity.revision).get('F01').fieldId, 'native-2')
  assert.deepEqual(bindings.reference('native-1'), { page: 1, label: 'F01', fieldId: 'native-1', sharedFieldKey: 'G1' })
  assert.equal(bindings.reference('native-2'), undefined, 'ordinary references cannot escape the inspected page')
  assert.equal(bindings.reference('absent'), undefined)
  for (const replacement of [{ sessionId: 'foreign' }, { documentId: 'foreign' }, { revision: 3 },
    { contentVersion: 'different' }, { sourceDigest: 'changed' }]) {
    assert.throws(() => store.resolve(a, { ...identity, ...replacement }, identity.revision), { code: 'pdf/form-inspection-required' })
  }
  assert.throws(() => bindings.get('F02'), /Inspect every/)
  assert.throws(() => store.resolve('unknown', identity, identity.revision), /Inspect every/)
  assert.throws(() => store.resolve(a, identity, identity.revision + 1), /Inspect every/)
  const fields = modelFormInspectionFields(first, document)
  assert.equal(fields[0].controls[0].label, 'F01')
  assert.doesNotMatch(JSON.stringify(fields), /fieldId|native-1|PRIVATE/)
  assert.equal(first.fields[0].fieldId, 'native-1', 'projection does not alter the native mapping')
  store.deleteSession('foreign'); assert.ok(store.resolve(a, identity, identity.revision))
  store.deleteSession(identity.sessionId); assert.throws(() => store.resolve(a, identity, identity.revision), /Inspect every/)
  store.dispose()
})

test('inspection mappings expire, evict in bounded memory, snapshot targets and release on unload', () => {
  let now = 0
  const store = createFormInspectionRegistry({ limit: 1, now: () => now })
  const page = inspectFormPage(document, 1), a = store.issue(identity, page, document)
  page.fields[0].controls[0].fieldId = 'mutated'
  const bindings = store.resolve(a, identity, identity.revision)
  const target = bindings.get('F01'); target.fieldId = 'mutated copy'
  assert.equal(bindings.get('F01').fieldId, 'native-1')
  const b = store.issue(identity, inspectFormPage(document, 2), document)
  assert.throws(() => store.resolve(a, identity, identity.revision), /Inspect every/)
  now = 600_000
  assert.throws(() => store.resolve(b, identity, identity.revision), /Inspect every/)
  const c = store.issue(identity, inspectFormPage(document, 1), document)
  assert.ok(store.resolve(c, identity, identity.revision))
  const bad = inspectFormPage(document, 1); bad.fields[0].controls.push(bad.fields[0].controls[0])
  assert.throws(() => store.issue(identity, bad, document), /Inspect every/)
  const unknown = structuredClone(document); unknown.formFields = []
  assert.throws(() => store.issue(identity, inspectFormPage(document, 1), unknown), /Inspect every/)
  const mismatched = inspectFormPage(document, 1); mismatched.fields[0].controls[0].fieldId = 'native-2'
  assert.throws(() => store.issue(identity, mismatched, document), /Inspect every/)
  store.dispose()
  assert.throws(() => store.issue(identity, page, document), /Inspect every/)
  assert.throws(() => store.resolve(c, identity, identity.revision), /Inspect every/)
  assert.throws(() => createFormInspectionRegistry({ limit: 0 }), /limit/)
})

test('tracked fills preserve independent page inspections but reject changed pages, shared fields and ABA writes', () => {
  const store = createFormInspectionRegistry()
  const a = store.issue(identity, inspectFormPage(document, 1), document)
  const b = store.issue(identity, inspectFormPage(document, 2), document)
  const resolved = store.resolve(a, identity, identity.revision)
  store.advance(identity, 3, ['native-1'])
  const revision3 = { ...identity, revision: 3 }
  assert.throws(() => store.resolve(a, revision3, identity.revision), /Inspect every/)
  assert.equal(resolved.get('F01').fieldId, 'native-1', 'committed result rendering keeps its validated target snapshot')
  const independent = store.resolve(b, revision3, identity.revision)
  assert.equal(independent.get('F01').fieldId, 'native-2')
  assert.throws(() => store.resolve(b, revision3, 3), /Inspect every/, 'caller must keep the token original revision')
  store.advance(revision3, 4, ['native-1'])
  assert.throws(() => store.resolve(a, { ...identity, revision: 4 }, identity.revision), /Inspect every/,
    'changing a value back never revives its inspection')
  assert.ok(store.resolve(b, { ...identity, revision: 4 }, identity.revision))

  const pdf = structuredClone(document)
  pdf.formFields![0].widgets.push({ page: 2, rect: [10, 100, 80, 120] })
  const shared = createFormInspectionRegistry()
  const first = shared.issue(identity, inspectFormPage(pdf, 1), pdf)
  const second = shared.issue(identity, inspectFormPage(pdf, 2), pdf)
  shared.advance(identity, 3, ['native-1'])
  for (const id of [first, second]) assert.throws(() => shared.resolve(id, revision3, 2), /Inspect every/,
    'a shared field edit invalidates every inspected page containing that native field')
})

test('unknown revision, source and content transitions cannot be silently rebased', () => {
  const store = createFormInspectionRegistry()
  const id = store.issue(identity, inspectFormPage(document, 2), document)
  assert.throws(() => store.resolve(id, { ...identity, revision: 3 }, 2), /Inspect every/)
  store.advance({ ...identity, revision: 3 }, 4, ['native-1'])
  assert.throws(() => store.resolve(id, { ...identity, revision: 4 }, 2), /Inspect every/,
    'a later known fill does not bridge an untracked UI/undo transition')
  for (const replacement of [{ sourceDigest: 'new digest' }, { contentVersion: 'new content' },
    { sessionId: 'another session' }, { documentId: 'another document' }]) {
    store.advance({ ...identity, ...replacement }, 3, ['native-1'])
    assert.throws(() => store.resolve(id, { ...identity, ...replacement, revision: 3 }, 2), /Inspect every/)
  }
  assert.ok(store.resolve(id, identity, 2), 'unrelated identity advances leave original records untouched')
  for (const revision of [2, 4, Number.NaN, 3.5]) assert.throws(() => store.advance(identity, revision, []), /Inspect every/)
  store.dispose()
  assert.doesNotThrow(() => store.advance(identity, 3, []), 'post-commit bookkeeping is harmless after unload')
  assert.throws(() => store.resolve(id, { ...identity, revision: 3 }, 2), /Inspect every/,
    'ignoring unloaded bookkeeping never restores any inspection')
})

test('cross-page dependency keys require an inspected proof from the same original snapshot and current revision', () => {
  const store = createFormInspectionRegistry()
  const page2 = store.issue(identity, inspectFormPage(document, 2), document)
  let bindings = store.resolve(page2, identity, 2)
  assert.deepEqual(bindings.getShared('G2'), { page: 2, label: 'F01', fieldId: 'native-2', sharedFieldKey: 'G2' })
  assert.throws(() => bindings.getShared('G1'), /Inspect every/, 'the canonical G key alone is not inspection proof')
  for (const other of [{ ...identity, revision: 1 }, { ...identity, sessionId: 'foreign' },
    { ...identity, sourceDigest: 'foreign' }]) store.issue(other, inspectFormPage(document, 1), document)
  assert.throws(() => bindings.getShared('G1'), /Inspect every/)
  store.issue(identity, inspectFormPage(document, 1), document)
  const dependency = bindings.getShared('G1')
  assert.deepEqual(dependency, { page: 1, label: 'F01', fieldId: 'native-1', sharedFieldKey: 'G1' })
  dependency.fieldId = 'tampered'
  assert.equal(bindings.getShared('G1').fieldId, 'native-1')
  assert.deepEqual(bindings.reference('native-1'), { page: 1, label: 'F01', fieldId: 'native-1', sharedFieldKey: 'G1' })
  store.advance(identity, 3, ['native-1'])
  assert.equal(bindings.getShared('G1').fieldId, 'native-1', 'already resolved dependencies remain available for result diagnostics')
  bindings = store.resolve(page2, { ...identity, revision: 3 }, 2)
  assert.throws(() => bindings.getShared('G1'), /Inspect every/, 'a changed dependency permanently revokes its old proof')
  store.issue({ ...identity, revision: 3 }, inspectFormPage(document, 1), document)
  assert.throws(() => bindings.getShared('G1'), /Inspect every/, 'newer inspections cannot be mixed with old snapshot dependencies')
  assert.equal(bindings.getShared('G2').page, 2)
})

test('unchanged dependency fields remain usable when other fields on their inspected page change', () => {
  const pdf = structuredClone(document)
  pdf.formFields!.push({ id: 'controller', name: 'controller', type: 'checkbox', value: false,
    required: false, readOnly: false, widgets: [{ page: 1, rect: [100, 20, 120, 40] }] })
  const store = createFormInspectionRegistry()
  const page1 = store.issue(identity, inspectFormPage(pdf, 1), pdf)
  const page2 = store.issue(identity, inspectFormPage(pdf, 2), pdf)
  store.advance(identity, 3, ['native-1'])
  assert.throws(() => store.resolve(page1, { ...identity, revision: 3 }, 2), /Inspect every/,
    'the page itself cannot be written again from its old inspection')
  const dependencies = store.resolve(page2, { ...identity, revision: 3 }, 2)
  assert.deepEqual(dependencies.getShared('G3'), { page: 1, label: 'F02', fieldId: 'controller', sharedFieldKey: 'G3' },
    'an unrelated field on the controller page does not invalidate the controller evidence')
  assert.throws(() => dependencies.getShared('G1'), /Inspect every/, 'changed fields on that same page remain revoked')

  store.advance({ ...identity, revision: 3 }, 4, ['controller'])
  assert.throws(() => store.resolve(page2, { ...identity, revision: 4 }, 2).getShared('G3'), /Inspect every/,
    'changed controller evidence must be rejected even though its source page was already invalidated')
  store.advance({ ...identity, revision: 4 }, 5, ['controller'])
  assert.throws(() => store.resolve(page2, { ...identity, revision: 5 }, 2).getShared('G3'), /Inspect every/,
    'returning the controller to its original value never revives stale dependency proof')
  assert.equal(dependencies.getShared('G3').fieldId, 'controller', 'resolved diagnostics preserve their validated snapshot')
})

test('partially changed dependency pages cannot bridge an untracked UI revision', () => {
  const pdf = structuredClone(document)
  pdf.formFields!.push({ id: 'controller', name: 'controller', type: 'checkbox', value: false,
    required: false, readOnly: false, widgets: [{ page: 1, rect: [100, 20, 120, 40] }] })
  const store = createFormInspectionRegistry()
  store.issue(identity, inspectFormPage(pdf, 1), pdf)
  const page2 = store.issue(identity, inspectFormPage(pdf, 2), pdf)
  store.advance(identity, 3, ['native-1'])
  // Revision 4 represents an unknown UI edit or undo; its field changes were not observed.
  store.advance({ ...identity, revision: 4 }, 5, ['native-1'])
  assert.throws(() => store.resolve(page2, { ...identity, revision: 5 }, 2), /Inspect every/)
})

test('cross-page proof expiration and eviction cannot be bypassed, and primary controls win for shared fields', () => {
  let now = 0
  const store = createFormInspectionRegistry({ now: () => now, limit: 2 })
  store.issue(identity, inspectFormPage(document, 1), document)
  now = 1
  const id = store.issue(identity, inspectFormPage(document, 2), document)
  now = 600_000
  assert.throws(() => store.resolve(id, identity, 2).getShared('G1'), /Inspect every/)
  now = 600_001
  assert.throws(() => store.resolve(id, identity, 2), /Inspect every/)
  const current = store.issue(identity, inspectFormPage(document, 2), document)
  store.issue({ ...identity, documentId: 'unrelated' }, inspectFormPage(document, 1), document)
  assert.throws(() => store.resolve(current, identity, 2).getShared('G1'), /Inspect every/)
  const pdf = structuredClone(document)
  pdf.formFields![0].widgets.push({ page: 2, rect: [10, 100, 80, 120] })
  const shared = createFormInspectionRegistry()
  shared.issue(identity, inspectFormPage(pdf, 1), pdf)
  const primary = shared.issue(identity, inspectFormPage(pdf, 2), pdf)
  assert.equal(shared.resolve(primary, identity, 2).getShared('G1').page, 2)
})

test('per-document fill queues serialize checks and writes while separate documents can run concurrently', async () => {
  const store = createFormInspectionRegistry()
  const events: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const a = store.enqueue('s', 'one', undefined, async () => { events.push('a:start'); await gate; events.push('a:end'); return 1 })
  const b = store.enqueue('s', 'one', undefined, async () => { events.push('b'); return 2 })
  const c = store.enqueue('s', 'two', undefined, async () => { events.push('c'); return 3 })
  assert.equal(await c, 3)
  assert.deepEqual(events, ['a:start', 'c'])
  release()
  assert.deepEqual(await Promise.all([a, b]), [1, 2])
  assert.deepEqual(events, ['a:start', 'c', 'a:end', 'b'])
})

test('a rejected or cancelled queued fill never runs and never poisons later writes', async () => {
  const store = createFormInspectionRegistry()
  const failure = new Error('write failed')
  const first = store.enqueue('s', 'doc', undefined, async () => { throw failure })
  const controller = new AbortController()
  let cancelledRan = false
  const cancelled = store.enqueue('s', 'doc', controller.signal, async () => { cancelledRan = true })
  controller.abort()
  const third = store.enqueue('s', 'doc', undefined, async () => 3)
  await assert.rejects(first, error => error === failure)
  await assert.rejects(cancelled, { name: 'AbortError' })
  assert.equal(cancelledRan, false)
  assert.equal(await third, 3)
  assert.equal(await store.enqueue('s', 'doc', undefined, async () => 4), 4)
})

test('session disposal and registry unload revoke queued tasks before they start', async () => {
  for (const action of ['session', 'registry'] as const) {
    const store = createFormInspectionRegistry()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const running = store.enqueue('s', 'doc', undefined, async () => { await gate })
    await Promise.resolve()
    let queuedRan = false
    const queued = store.enqueue('s', 'doc', undefined, async () => { queuedRan = true })
    if (action === 'session') store.deleteSession('s')
    else store.dispose()
    release()
    await running
    await assert.rejects(queued, { code: 'pdf/form-inspection-required' })
    assert.equal(queuedRan, false)
    if (action === 'registry') await assert.rejects(store.enqueue('s', 'doc', undefined, async () => 1),
      { code: 'pdf/form-inspection-required' })
    else assert.equal(await store.enqueue('s', 'doc', undefined, async () => 2), 2)
  }
})

test('model inspection explicitly exposes only numbered controls, value types and real field constraints', () => {
  const pdf = structuredClone(document)
  Object.assign(pdf.formFields![0], { description: 'PRIVATE AUTHOR HINT', required: true, maxLength: 32,
    multiline: false })
  const inspection = inspectFormPage(pdf, 1)
  Object.assign(inspection.fields[0], { privateDebugState: 'PRIVATE DEBUG VALUE' })
  Object.assign(inspection.fields[0].controls[0], { privateControlState: 'PRIVATE GEOMETRY' })
  const fields = modelFormInspectionFields(inspection, pdf)
  assert.deepEqual(fields, [{ sharedFieldKey: 'G1', type: 'text', valueType: 'string', required: true,
    maxLength: 32, multiline: false, controls: [{ label: 'F01' }] }])
  assert.doesNotMatch(JSON.stringify(fields), /PRIVATE|name|fieldId|valueContract|examples|hint|rect|linkedWidgets|nativeRadioGroup/)
  assert.deepEqual(inspection.fields[0].controls[0].rectPdf, [10, 20, 80, 40], 'geometry remains in the native raster mapping')
  const withValues = modelFormInspectionFields(inspectFormPage(pdf, 1, 512, true), pdf)
  assert.equal(withValues[0].value, 'PRIVATE')
  const missing = structuredClone(pdf); missing.formFields = []
  assert.throws(() => modelFormInspectionFields(inspection, missing), { code: 'pdf/form-inspection-required' })
})

test('native shared fields and radio options keep their identity across pages without merging independent checkboxes', () => {
  const pdf = structuredClone(document)
  pdf.formFields = [
    { id: 'shared-native-id', name: 'PRIVATE SHARED NAME', type: 'text', value: '', required: false, readOnly: false,
      widgets: [1, 2].map(page => ({ page, rect: [10, 250, 80, 275] as [number, number, number, number] })) },
    { id: 'radio-native-id', name: 'PRIVATE RADIO NAME', type: 'radio', value: 'B', required: false, readOnly: false,
      options: ['A', 'B'], widgets: [{ page: 1, option: 'A', rect: [10, 200, 35, 225] },
        { page: 1, option: 'B', rect: [60, 200, 85, 225] }] },
    ...[1, 2].map((index): NonNullable<PdfDocumentInfo['formFields']>[number] => ({
      id: `independent-${index}`, name: 'same visible name', type: 'checkbox', value: false,
      required: false, readOnly: false, widgets: [{ page: 1, option: 'Yes', rect: [10 + index * 50, 150, 35 + index * 50, 175] }],
    })),
  ]
  const firstInspection = inspectFormPage(pdf, 1, 512, true)
  const first = modelFormInspectionFields(firstInspection, pdf)
  const second = modelFormInspectionFields(inspectFormPage(pdf, 2, 512, true), pdf)
  assert.equal(first[0].sharedFieldKey, second[0].sharedFieldKey)
  assert.deepEqual(first.map(field => field.sharedFieldKey), ['G1', 'G2', 'G3', 'G4'])
  assert.deepEqual(first[1], { sharedFieldKey: 'G2', type: 'radio', valueType: 'string', required: false,
    options: ['A', 'B'], value: 'B', controls: [{ label: 'F02', option: 'A' }, { label: 'F03', option: 'B' }] })
  assert.deepEqual(first[2].controls, [{ label: 'F04' }], 'checkbox export appearances do not become string-valued options')
  assert.deepEqual(first[3].controls, [{ label: 'F05' }])
  const store = createFormInspectionRegistry(), id = store.issue(identity, firstInspection, pdf)
  const targets = store.resolve(id, identity, identity.revision)
  assert.equal(targets.get('F02').fieldId, targets.get('F03').fieldId)
  assert.notEqual(targets.get('F04').fieldId, targets.get('F05').fieldId)
  first[1].options!.push('changed projection')
  assert.deepEqual(firstInspection.fields[1].options, ['A', 'B'], 'projection does not mutate input options')
  store.dispose()
})

test('model values preserve empty typed values and clone option-list arrays without leaking omitted values', () => {
  const pdf = structuredClone(document)
  pdf.formFields = (['text', 'checkbox', 'radio', 'dropdown', 'option-list'] as const).map((type, index) => ({
    id: `private-${type}`, name: `private ${type}`, type, required: false, readOnly: false,
    value: type === 'checkbox' ? false : type === 'dropdown' || type === 'option-list' ? [] : '',
    ...(type === 'dropdown' || type === 'radio' || type === 'option-list' ? { options: ['A', 'B'] } : {}),
    ...(type === 'option-list' ? { multiple: true } : {}),
    widgets: [{ page: 1, rect: [10, 10 + index * 50, 80, 35 + index * 50] }],
  }))
  const omitted = modelFormInspectionFields(inspectFormPage(pdf, 1), pdf)
  assert.ok(omitted.every(field => !Object.hasOwn(field, 'value')))
  const values = modelFormInspectionFields(inspectFormPage(pdf, 1, 512, true), pdf)
  assert.deepEqual(values.map(field => field.value), ['', false, '', '', []])
  assert.deepEqual(values.map(field => field.valueType), ['string', 'boolean', 'string', 'string', 'string[]'])
  assert.equal(values[4].multiple, true)
  const inspection = inspectFormPage(pdf, 1, 512, true)
  const projected = modelFormInspectionFields(inspection, pdf)
  ;(projected[4].value as string[]).push('A')
  assert.deepEqual(inspection.fields[4].value, [], 'returned arrays do not mutate inspection or draft values')
  assert.deepEqual(pdf.formFields[4].value, [])
})

test('dropdown inspection fails instead of silently truncating multiple selections or inventing valid options', () => {
  for (const value of [['A', 'B'], ['absent'], 'absent', false]) {
    const pdf = structuredClone(document)
    Object.assign(pdf.formFields![0], { type: 'dropdown', options: ['A', 'B'], value })
    const inspection = inspectFormPage(pdf, 1, 512, true)
    assert.throws(() => modelFormInspectionFields(inspection, pdf), { code: 'pdf/form-inspection-unavailable' })
    assert.deepEqual(pdf.formFields![0].value, value)
    assert.ok(!Object.hasOwn(modelFormInspectionFields(inspectFormPage(pdf, 1), pdf)[0], 'value'))
  }
})
