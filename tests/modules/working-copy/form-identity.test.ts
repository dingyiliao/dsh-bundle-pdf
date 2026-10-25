import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelWriteService } from '../../../src/modules/model-write/index.ts'
import { formFieldId, inspectFormPage } from '../../../src/modules/forms/index.ts'
import { loadPdfDocument } from '../../../src/adapters/host/pdf-lib/pdf-document.ts'
import { createWorkspaces } from '../../../src/host/workspaces.ts'
import { workingCopyOperationSchema } from '../../../src/contracts/rpc/requests.ts'
import { memoryWorkspace } from '../../native-fixture.ts'
import { duplicateFieldNamesFixture } from '../../fixtures/acroform.ts'

const sessionId = 'same-name-form'
const agent = { session: { id: sessionId, header: {} } }
const signal = new AbortController().signal
const open = { action: 'open', sessionId, address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }

test('same-name controls have independent IDs; draft/undo/recovery/save preserve the exact chosen object', async () => {
  const source = await duplicateFieldNamesFixture(), state = memoryWorkspace(source)
  let service = state.workspaces, writes = createModelWriteService(service)
  try {
    const opened = await service.execute(sessionId, open, agent, signal)
    assert.ok('bytes' in opened)
    const fields = opened.document.formFields!, boxes = fields.filter(field => field.name === 'same-name')
    assert.equal(boxes.length, 3); assert.equal(new Set(boxes.map(formFieldId)).size, 3)
    const text = fields.find(field => field.name === 'unique-text')!
    const inspected = inspectFormPage(opened.document, 1, 1024)
    assert.deepEqual(inspected.fields.filter(field => field.name === 'same-name').map(field => field.fieldId), boxes.map(formFieldId))
    const shared = fields.find(field => field.name === 'repeated-widget')!
    assert.equal(shared.widgets.length, 2, 'multiple widgets of one canonical field retain one ID')
    const edited = await writes.fillForm(sessionId, { documentId: opened.id, expectedRevision: opened.revision,
      fields: [{ fieldId: formFieldId(boxes[1]), value: true }, { fieldId: formFieldId(text), value: 'fixture' }] }, agent, signal)
    const boxValues = () => service.readSnapshot(sessionId, opened.id).document.formFields!
      .filter(field => field.name === 'same-name').map(field => field.value)
    assert.deepEqual(boxValues(), [false, true, false])
    const undone = await service.execute(sessionId, { action: 'undo', sessionId, id: opened.id, revision: edited.revision }, agent, signal)
    assert.ok('bytes' in undone); assert.deepEqual(boxValues(), [false, false, false])
    await service.execute(sessionId, { action: 'redo', sessionId, id: opened.id, revision: undone.revision }, agent, signal)
    assert.deepEqual(boxValues(), [false, true, false])
    assert.equal(state.writes(), 0); assert.deepEqual(state.current(), source)
    writes.dispose(); await service.dispose()
    service = createWorkspaces(state.files, state.drafts); writes = createModelWriteService(service)
    const restored = await service.execute(sessionId, open, agent, signal)
    assert.ok('bytes' in restored)
    assert.deepEqual(restored.document.formFields!.filter(field => field.name === 'same-name').map(field => field.value), [false, true, false])
    assert.equal(restored.document.formFields!.find(field => field.name === 'unique-text')!.value, 'fixture')
    const saved = await writes.save(sessionId, { documentId: restored.id, expectedRevision: restored.revision }, agent, signal,
      async review => { assert.equal(review.saveChangeCount, 2); return true })
    assert.equal(saved.dirty, false); assert.equal(state.writes(), 1)
    const reloaded = await loadPdfDocument(state.current())
    assert.deepEqual(reloaded.formFields!.map(formFieldId), fields.map(formFieldId), 'object IDs survive serialization')
    assert.deepEqual(reloaded.formFields!.filter(field => field.name === 'same-name').map(field => field.value), [false, true, false])
  } finally { writes.dispose(); await service.dispose() }
})

test('legacy name targets are allowed only when unique; unrelated duplicate names do not lock the document', async () => {
  const state = memoryWorkspace(await duplicateFieldNamesFixture())
  try {
    const opened = await state.workspaces.execute(sessionId, open, agent, signal)
    assert.ok('bytes' in opened)
    const changed = await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id, revision: opened.revision,
      operations: [{ type: 'set-field', name: 'unique-text', value: 'legacy' }] }, agent, signal)
    assert.ok('bytes' in changed)
    assert.equal(changed.document.formFields!.find(field => field.name === 'unique-text')!.value, 'legacy')
    await assert.rejects(state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id, revision: changed.revision,
      operations: [{ type: 'set-field', name: 'same-name', value: true }] }, agent, signal), /Ambiguous/)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, changed.revision)
    const id = changed.document.formFields![0].id!
    assert.equal(workingCopyOperationSchema.safeParse({ type: 'set-field', fieldId: id, name: 'unique-text', value: 'unsafe' }).success, false)
    await assert.rejects(state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id, revision: changed.revision,
      operations: [{ type: 'set-field', fieldId: id, value: 'one' }, { type: 'set-field', name: 'unique-text', value: 'two' }] }, agent, signal), /Duplicate/)
    assert.equal(state.writes(), 0)
  } finally { await state.workspaces.dispose() }
})
