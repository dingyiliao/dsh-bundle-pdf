import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { createModelWriteService, modelFillFormSchema } from '../../../src/modules/model-write/index.ts'
import { memoryWorkspace } from '../../native-fixture.ts'
import { acroformFixture } from '../../fixtures/acroform.ts'

const sessionId = 'model-forms'
const agent = { session: { id: sessionId, header: {} } }
const signal = new AbortController().signal
async function fixture() {
  const source = await acroformFixture(), state = memoryWorkspace(source)
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in opened)
  const ids = Object.fromEntries(opened.document.formFields!.map(field => [field.name, field.id!]))
  return { source, state, opened, ids, writes: createModelWriteService(state.workspaces) }
}

test('model form batches share Reader drafts, one-step undo/redo and approved Unicode save/clear', async () => {
  const { source, state, opened, ids, writes } = await fixture()
  try {
    const edited = await writes.fillForm(sessionId, { documentId: opened.id, expectedRevision: opened.revision, fields: [
      { fieldId: ids.Text1, value: '测试' }, { fieldId: ids.accepted, value: true }, { fieldId: ids.contact, value: 'phone' },
      { fieldId: ids.choice, value: 'second' }, { fieldId: ids.list, value: ['one'] },
    ] }, agent, signal)
    assert.equal(edited.savedToFile, false); assert.equal(edited.dirty, true); assert.equal(edited.canUndo, true)
    assert.equal(edited.revision, opened.revision + 1)
    assert.equal('values' in edited, false)
    assert.deepEqual(state.current(), source); assert.equal(state.writes(), 0)
    const current = () => state.workspaces.readSnapshot(sessionId, opened.id)
    assert.deepEqual(current().document.formFields!.slice(0, 5).map(field => field.value), ['测试', true, 'phone', ['second'], ['one']])
    await state.workspaces.execute(sessionId, { action: 'undo', sessionId, id: opened.id, revision: current().revision }, agent, signal)
    assert.deepEqual(current().document.formFields!.slice(0, 5).map(field => field.value), ['Demo', false, '', [], []])
    await state.workspaces.execute(sessionId, { action: 'redo', sessionId, id: opened.id, revision: current().revision }, agent, signal)
    await assert.rejects(writes.save(sessionId, { documentId: opened.id, expectedRevision: current().revision }, agent, signal,
      async review => { assert.equal(review.saveChangeCount, 5); assert.match(review.saveDiffText!, /测试/); return false }),
    { code: 'pdf/approval-rejected' })
    assert.equal(state.writes(), 0)
    const saved = await writes.save(sessionId, { documentId: opened.id, expectedRevision: current().revision }, agent, signal, async () => true)
    assert.equal(saved.dirty, false); assert.equal(state.writes(), 1)
    const form = (await PDFDocument.load(state.current())).getForm()
    assert.equal(form.getTextField('Text1').getText(), '测试')
    assert.equal(form.getRadioGroup('contact').getSelected(), 'phone')
    assert.equal(form.getCheckBox('accepted').isChecked(), true)
    await writes.fillForm(sessionId, { documentId: opened.id, expectedRevision: current().revision,
      fields: [{ fieldId: ids.Text1, value: '' }] }, agent, signal)
    await writes.save(sessionId, { documentId: opened.id, expectedRevision: current().revision }, agent, signal, async () => true)
    assert.equal((await PDFDocument.load(state.current())).getForm().getTextField('Text1').getText(), '')
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('invalid form batches never partially update valid fields or write the file', async () => {
  const { state, opened, ids, writes } = await fixture()
  try {
    const invalid = [
      { fieldId: 'F01', value: 'value' }, { fieldId: 'missing', value: 'value' },
      { fieldId: ids.locked, value: 'value' }, { fieldId: ids.Text1, value: true },
      { fieldId: ids.hidden, value: 'value' },
      { fieldId: ids.Text1, value: 'too long' }, { fieldId: ids.contact, value: 'wrong' },
      { fieldId: ids.choice, value: ['first'] }, { fieldId: ids.list, value: ['one', 'two'] },
    ]
    for (const field of invalid) {
      await assert.rejects(writes.fillForm(sessionId, { documentId: opened.id, expectedRevision: opened.revision,
        fields: [{ fieldId: ids.accepted, value: true }, field] }, agent, signal))
      assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
      assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).document.formFields![1].value, false)
    }
    await assert.rejects(writes.fillForm(sessionId, { documentId: opened.id, expectedRevision: opened.revision,
      fields: [{ fieldId: ids.Text1, value: 'one' }, { fieldId: ids.Text1, value: 'two' }] }, agent, signal), /Duplicate/)
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('form writes fence revision, session, source, cancellation, disposal and input limits', async () => {
  const { state, opened, ids, writes } = await fixture()
  const input = { documentId: opened.id, expectedRevision: opened.revision, fields: [{ fieldId: ids.Text1, value: 'value' }] }
  try {
    await assert.rejects(writes.fillForm('another-session', input, agent, signal), /session|belong/i)
    const abort = new AbortController(); abort.abort()
    await assert.rejects(writes.fillForm(sessionId, input, agent, abort.signal), /abort/i)
    const staleSource = createModelWriteService({ readSnapshot: state.workspaces.readSnapshot,
      async execute(owner, request, caller, abort) {
        return request.action === 'inspectTarget' ? { version: 'changed' }
          : state.workspaces.execute(owner, request, caller, abort)
      } })
    try { await assert.rejects(staleSource.fillForm(sessionId, input, agent, signal), { code: 'pdf/source-conflict' }) }
    finally { staleSource.dispose() }
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    await writes.fillForm(sessionId, input, agent, signal)
    await assert.rejects(writes.fillForm(sessionId, input, agent, signal), { code: 'pdf/stale-revision' })
    assert.equal(state.writes(), 0)
    assert.equal(modelFillFormSchema.safeParse({ ...input, confirmed: true }).success, false)
    assert.equal(modelFillFormSchema.safeParse({ ...input, fields: [] }).success, false)
    assert.equal(modelFillFormSchema.safeParse({ ...input, fields: Array.from({ length: 101 }, () => input.fields[0]) }).success, false)
    assert.equal(modelFillFormSchema.safeParse({ ...input, fields: [{ fieldId: 'Text1', value: 'x'.repeat(8001) }] }).success, false)
    writes.dispose()
    await assert.rejects(writes.fillForm(sessionId, input, agent, signal), { code: 'pdf/write-unavailable' })
  } finally { writes.dispose(); await state.workspaces.dispose() }
})
