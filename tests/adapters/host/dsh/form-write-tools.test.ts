import assert from 'node:assert/strict'
import test from 'node:test'
import { registerPdfModelWriteTools } from '../../../../src/adapters/host/dsh/model-write-tools.ts'
import { createFormInspectionRegistry, inspectFormPage, type FormValidationIssue } from '../../../../src/modules/forms/index.ts'
import type { ModelWritePort } from '../../../../src/modules/model-write/index.ts'
import { acroformFixture, duplicateFieldNamesFixture } from '../../../fixtures/acroform.ts'
import { formPageBatchesFixture } from '../../../fixtures/form-page-batches.ts'
import { memoryWorkspace, digest } from '../../../native-fixture.ts'

const sessionId = 'recover-form-tool', agent = { session: { id: sessionId, header: {} } }
const signal = new AbortController().signal
interface Tool {
  name: string
  parameters: { properties: Record<string, { type: string; items?: { properties: Record<string, unknown> } }> }
  execute(args: unknown, exec: unknown): Promise<unknown>
}
type Failure = { status: string; appliedCount: number; revision: number; code: string;
  issues: Array<Omit<FormValidationIssue, 'fieldId'> & { path: string; label?: string; sharedFieldKey?: string }>; recovery: { action: string } }

async function setup(source?: Uint8Array) {
  const state = memoryWorkspace(source ?? await acroformFixture())
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in opened)
  const tools = new Map<string, Tool>()
  const inspections = createFormInspectionRegistry()
  const dispose = registerPdfModelWriteTools({ get() { throw new Error('Draft writes must not ask for approval') },
    tools: { register(tool: Tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } } as never, state.workspaces, undefined, inspections)
  const inspection = inspectFormPage(opened.document, 1)
  const labels = Object.fromEntries(inspection.fields.map(field => [field.name, field.controls[0].label]))
  const refresh = (page = 1) => {
    const current = state.workspaces.readSnapshot(sessionId, opened.id)
    return inspections.issue({ sessionId, documentId: current.id, revision: current.revision,
      contentVersion: current.contentVersion, sourceDigest: digest(current.bytes) },
    inspectFormPage(current.document, page), current.document)
  }
  const inspectAll = () => opened.document.pages.map(page => refresh(page.page))
  return { state, opened, labels, inspection, refresh, inspectAll, inspectionId: refresh(), fill: tools.get('pdf_fill_form')!,
    async dispose() { dispose(); await state.workspaces.dispose() } }
}

test('wrong checkbox/text values report every repairable error; corrected atomic retry succeeds and undoes once', async () => {
  const env = await setup()
  try {
    assert.equal(env.fill.parameters.properties.fields.type, 'array')
    assert.ok(env.fill.parameters.properties.fields.items?.properties.value)
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision, inspectionId: env.inspectionId,
      fields: [{ label: env.labels.Text1, value: 'PRIVATE-OVERLONG' }, { label: env.labels.accepted, value: 'PRIVATE-YES' }] }
    const failed = await env.fill.execute(input, { agent, signal }) as Failure
    assert.equal(failed.status, 'validation_failed'); assert.equal(failed.appliedCount, 0)
    assert.equal(failed.revision, env.opened.revision)
    assert.equal(failed.recovery.action, 'correct_fields_and_retry')
    assert.deepEqual(failed.issues.map(issue => [issue.path, issue.code]),
      [['fields[0].value', 'value_too_long'], ['fields[1].value', 'value_type_mismatch']])
    assert.equal(failed.issues[1].label, env.labels.accepted)
    assert.equal(failed.issues[1].expected, 'boolean'); assert.equal(failed.issues[1].receivedType, 'string')
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|fieldId|pdf-field:/)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).canUndo, false)
    const updated = await env.fill.execute({ ...input, expectedRevision: failed.revision,
      fields: [{ label: env.labels.Text1, value: 'Alex' }, { label: env.labels.accepted, value: true }] },
    { agent, signal }) as { status: string; revision: number; appliedCount: number }
    assert.equal(updated.status, 'updated'); assert.equal(updated.appliedCount, 2)
    await env.state.workspaces.execute(sessionId, { action: 'undo', sessionId, id: env.opened.id,
      revision: updated.revision }, agent, signal)
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!.slice(0, 2)
      .map(field => field.value), ['Demo', false])
    assert.equal(env.state.writes(), 0)
    await assert.rejects(env.fill.execute({ ...input, fields: [{ label: env.labels.accepted, value: 1 }] }, { agent, signal }))
    await assert.rejects(env.fill.execute({ ...input, fields: [{ fieldId: 'pdf-field:1:0', value: true }] }, { agent, signal }))
  } finally { await env.dispose() }
})

test('stale revisions require reinspection; changed source requires reopening, never a blind write retry', async () => {
  const env = await setup()
  try {
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision, inspectionId: env.inspectionId,
      fields: [{ label: env.labels.accepted, value: true }] }
    const updated = await env.fill.execute(input, { agent, signal }) as { revision: number }
    const stale = await env.fill.execute(input, { agent, signal }) as Failure
    assert.equal(stale.status, 'inspection_required'); assert.equal(stale.code, 'pdf/form-inspection-required')
    assert.equal(stale.revision, updated.revision); assert.equal(stale.recovery.action, 'inspect_again')
    const newInspection = env.refresh()
    const source = env.state.current()
    await env.state.files.save(agent, env.opened.path, new Uint8Array([...source, 10]), digest(source))
    const conflict = await env.fill.execute({ ...input, expectedRevision: updated.revision, inspectionId: newInspection }, { agent, signal }) as Failure
    assert.equal(conflict.code, 'pdf/source-conflict'); assert.equal(conflict.recovery.action, 'reopen_document')
    assert.equal(conflict.appliedCount, 0); assert.equal(env.state.writes(), 1, 'Only the simulated external write occurred')
    await assert.rejects(env.fill.execute(input, { agent: { session: { id: 'foreign' } }, signal }), /session|belong/i)
  } finally { await env.dispose() }
})

test('conditional form failure is atomic and recoverable; a final Yes plus details is one undoable batch', async () => {
  const env = await setup()
  try {
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision, inspectionId: env.inspectionId,
      fields: [{ label: env.labels.Text1, value: 'Alex' }], conditions: [{ fields: [{ label: env.labels.Text1 }],
        when: { label: env.labels.accepted, equals: true }, evidence: { quote: 'If yes, provide details' } }] }
    const failed = await env.fill.execute(input, { agent, signal }) as Failure
    assert.equal(failed.status, 'condition_failed'); assert.equal(failed.appliedCount, 0)
    assert.equal(failed.issues[0].code, 'condition_not_met'); assert.equal(failed.issues[0].path, 'conditions[0]')
    assert.equal(failed.recovery.action, 'review_conditions_and_retry')
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).revision, env.opened.revision)
    const result = await env.fill.execute({ ...input, fields: [...input.fields, { label: env.labels.accepted, value: true }] },
      { agent, signal }) as { revision: number; appliedCount: number; conditionReview: { evaluated: number; source: string } }
    assert.equal(result.appliedCount, 2); assert.equal(result.conditionReview.evaluated, 1)
    assert.equal(result.conditionReview.source, 'model-supplied')
    await env.state.workspaces.execute(sessionId, { action: 'undo', sessionId, id: env.opened.id,
      revision: result.revision }, agent, signal)
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!.slice(0, 2)
      .map(field => field.value), ['Demo', false])
    assert.equal(env.state.writes(), 0)
  } finally { await env.dispose() }
})

test('missing credentials, unknown labels and changed target-page inspections cannot write', async () => {
  const env = await setup()
  try {
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision, inspectionId: env.inspectionId,
      fields: [{ label: env.labels.Text1, value: 'Alex' }, { label: env.labels.accepted, value: true }],
      conditions: [{ fields: [{ label: env.labels.accepted }],
        when: { label: env.labels.Text1, equals: 'Alex' }, evidence: { quote: 'Only if the name is provided' } }] }
    for (const changed of [
      { inspectionId: 'form-inspect_00000000-0000-0000-0000-000000000000' },
      { fields: [{ label: 'F99', value: 'Alex' }] },
    ]) {
      const failure = await env.fill.execute({ ...input, ...changed }, { agent, signal }) as Failure
      assert.equal(failure.status, 'inspection_required'); assert.equal(failure.appliedCount, 0)
      assert.equal(failure.recovery.action, 'inspect_again')
    }
    const result = await env.fill.execute(input, { agent, signal }) as { status: string; revision: number;
      page: number; inspectionId: string; updatedFields: Array<{ label: string }>; conditionReview: { evaluated: number } }
    assert.equal(result.status, 'updated'); assert.equal(result.conditionReview.evaluated, 1)
    assert.equal(result.page, 1); assert.equal(result.inspectionId, env.inspectionId)
    assert.deepEqual(result.updatedFields, [{ label: env.labels.Text1 }, { label: env.labels.accepted }])
    assert.doesNotMatch(JSON.stringify(result), /fieldId|pdf-field:/)
    const obsolete = await env.fill.execute({ ...input, expectedRevision: result.revision }, { agent, signal }) as Failure
    assert.equal(obsolete.status, 'inspection_required')
    assert.equal(obsolete.appliedCount, 0)
    await env.state.workspaces.execute(sessionId, { action: 'undo', sessionId, id: env.opened.id,
      revision: result.revision }, agent, signal)
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!.slice(0, 2)
      .map(field => field.value), ['Demo', false])
  } finally { await env.dispose() }
})

test('numbered radio options reject a different choice, duplicate linked controls and preserve typed values', async () => {
  const env = await setup()
  try {
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision, inspectionId: env.inspectionId,
      fields: [{ label: env.labels.contact, value: 'phone' }] }
    const mismatch = await env.fill.execute(input, { agent, signal }) as Failure
    assert.equal(mismatch.status, 'validation_failed'); assert.equal(mismatch.issues[0].code, 'invalid_option')
    assert.equal(mismatch.issues[0].label, env.labels.contact)
    const wrongType = await env.fill.execute({ ...input, fields: [{ label: env.labels.contact, value: true }] }, { agent, signal }) as Failure
    assert.equal(wrongType.status, 'validation_failed'); assert.equal(wrongType.issues[0].code, 'value_type_mismatch')
    const radioControls = env.inspection.fields.find(field => field.name === 'contact')!.controls
    const duplicate = await env.fill.execute({ ...input,
      fields: radioControls.map(control => ({ label: control.label, value: control.option })) }, { agent, signal }) as Failure
    assert.equal(duplicate.issues[0].code, 'duplicate_field'); assert.equal(duplicate.issues[0].path, 'fields[1].label')
    assert.equal(duplicate.issues[0].label, radioControls[1].label)
    assert.doesNotMatch(JSON.stringify(duplicate), /fieldId|pdf-field:/)
    const result = await env.fill.execute({ ...input, fields: [{ label: env.labels.contact, value: 'email' }] },
      { agent, signal }) as { status: string; appliedCount: number }
    assert.equal(result.status, 'updated'); assert.equal(result.appliedCount, 1)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!.find(field => field.name === 'contact')!.value, 'email')
  } finally { await env.dispose() }
})

test('dropdown fill accepts only the inspected scalar value type and normalizes selections into the existing draft model', async () => {
  const env = await setup()
  try {
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision, inspectionId: env.inspectionId,
      fields: [{ label: env.labels.choice, value: ['first'] }] }
    const invalid = await env.fill.execute(input, { agent, signal }) as Failure
    assert.equal(invalid.status, 'validation_failed'); assert.equal(invalid.appliedCount, 0)
    assert.equal(invalid.issues[0].code, 'value_type_mismatch'); assert.equal(invalid.issues[0].expected, 'string')
    assert.equal(invalid.issues[0].label, env.labels.choice)
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .find(field => field.type === 'dropdown')!.value, [])
    const selected = await env.fill.execute({ ...input, fields: [{ label: env.labels.choice, value: 'first' }] },
      { agent, signal }) as { status: string; revision: number }
    assert.equal(selected.status, 'updated')
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .find(field => field.type === 'dropdown')!.value, ['first'])
    const cleared = await env.fill.execute({ ...input, expectedRevision: selected.revision, inspectionId: env.refresh(),
      fields: [{ label: env.labels.choice, value: '' }] }, { agent, signal }) as { status: string; revision: number }
    assert.equal(cleared.status, 'updated')
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .find(field => field.type === 'dropdown')!.value, [])
    await env.state.workspaces.execute(sessionId, { action: 'undo', sessionId, id: env.opened.id,
      revision: cleared.revision }, agent, signal)
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .find(field => field.type === 'dropdown')!.value, ['first'])
    assert.equal(env.state.writes(), 0)
  } finally { await env.dispose() }
})

test('invalid numbered conditions, missing sessions and canceled calls do not write or expose canonical IDs', async () => {
  const env = await setup()
  try {
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision, inspectionId: env.inspectionId,
      fields: [{ label: env.labels.accepted, value: true }],
      conditions: [{ fields: [{ label: env.labels.accepted }], when: { label: env.labels.accepted, equals: true },
        evidence: { quote: 'If yes' } }] }
    const result = await env.fill.execute(input, { agent, signal }) as Failure
    assert.equal(result.status, 'condition_failed'); assert.equal(result.issues[0].code, 'invalid_condition')
    assert.match(result.issues[0].hint, /label|reference/)
    assert.doesNotMatch(JSON.stringify(result), /fieldId|pdf-field:/)
    await assert.rejects(env.fill.execute(input, { signal }), { code: 'pdf/session-required' })
    const canceled = new AbortController(); canceled.abort()
    await assert.rejects(env.fill.execute(input, { agent, signal: canceled.signal }), /abort/i)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).revision, env.opened.revision)
    assert.equal(env.state.writes(), 0)
  } finally { await env.dispose() }
})

test('unchanged numbered fields and retained inactive values return only public local labels', async () => {
  const env = await setup()
  try {
    const result = await env.fill.execute({ documentId: env.opened.id, expectedRevision: env.opened.revision,
      inspectionId: env.inspectionId, fields: [{ label: env.labels.accepted, value: false }],
      conditions: [{ fields: [{ label: env.labels.Text1 }], when: { label: env.labels.accepted, equals: true },
        evidence: { quote: 'If yes, give the name' }, onInactive: 'preserve' }] }, { agent, signal }) as { status: string;
      unchangedFields: unknown[]; conditionReview: { retainedInactiveFields: unknown[] } }
    assert.equal(result.status, 'no_changes')
    assert.deepEqual(result.unchangedFields, [{ label: env.labels.accepted }])
    assert.deepEqual(result.conditionReview.retainedInactiveFields, [{ label: env.labels.Text1 }])
    assert.doesNotMatch(JSON.stringify(result), /fieldId|pdf-field:/)
  } finally { await env.dispose() }
})

test('independent checkbox alternatives are atomic, account for existing selections, and report only numbered references', async () => {
  const env = await setup(await duplicateFieldNamesFixture())
  try {
    const refs = env.opened.document.formFields!.filter(field => field.type === 'checkbox').map(field => ({
      label: env.inspection.fields.find(candidate => candidate.fieldId === field.id)!.controls[0].label }))
    const groups = [{ fields: refs, evidence: { quote: 'Choose one option only' } }]
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision, inspectionId: env.inspectionId,
      choiceGroups: groups, fields: refs.slice(0, 2).map(ref => ({ ...ref, value: true })) }
    const rejected = await env.fill.execute(input, { agent, signal }) as Failure
    assert.equal(rejected.status, 'choice_failed'); assert.equal(rejected.appliedCount, 0)
    assert.equal(rejected.recovery.action, 'review_choices_and_retry')
    assert.deepEqual(rejected.issues.map(issue => issue.label), refs.slice(0, 2).map(ref => ref.label))
    assert.doesNotMatch(JSON.stringify(rejected), /fieldId|pdf-field:/)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).revision, env.opened.revision)
    const selected = await env.fill.execute({ ...input, fields: [{ ...refs[0], value: true }] }, { agent, signal }) as { revision: number;
      choiceReview: { source: string; evaluated: number } }
    assert.equal(selected.choiceReview.evaluated, 1); assert.equal(selected.choiceReview.source, 'model-supplied')
    const currentInput = { ...input, expectedRevision: selected.revision, inspectionId: env.refresh(),
      fields: [{ ...refs[1], value: true }] }
    const existingConflict = await env.fill.execute(currentInput, { agent, signal }) as Failure
    assert.equal(existingConflict.status, 'choice_failed', 'Unsubmitted existing checked boxes still count')
    assert.equal(existingConflict.appliedCount, 0)
    const switched = await env.fill.execute({ ...currentInput, fields: [...currentInput.fields, { ...refs[0], value: false }] },
      { agent, signal }) as { status: string; revision: number }
    assert.equal(switched.status, 'updated')
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .filter(field => field.type === 'checkbox').map(field => field.value), [false, true, false])
    await env.state.workspaces.execute(sessionId, { action: 'undo', sessionId, id: env.opened.id, revision: switched.revision }, agent, signal)
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .filter(field => field.type === 'checkbox').map(field => field.value), [true, false, false])
    assert.equal(env.state.writes(), 0)
  } finally { await env.dispose() }
})

test('invalid choice groups and uninspected members reject before any draft change', async () => {
  const env = await setup()
  try {
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision, inspectionId: env.inspectionId,
      fields: [{ label: env.labels.accepted, value: true }],
      choiceGroups: [{ fields: [{ label: env.labels.accepted }, { label: env.labels.Text1 }],
        evidence: { quote: 'Choose one option' } }] }
    const invalid = await env.fill.execute(input, { agent, signal }) as Failure
    assert.equal(invalid.status, 'choice_failed'); assert.equal(invalid.issues[0].code, 'invalid_choice_group')
    const uninspected = await env.fill.execute({ ...input, choiceGroups: [{ ...input.choiceGroups[0],
      fields: [{ label: env.labels.accepted }, { label: 'F99' }] }] }, { agent, signal }) as Failure
    assert.equal(uninspected.status, 'inspection_required')
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).revision, env.opened.revision)
  } finally { await env.dispose() }
})

test('strict inactive branches cannot retain old data silently; clearing requires a fresh inspection before refill', async () => {
  const env = await setup()
  try {
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision, inspectionId: env.inspectionId,
      fields: [{ label: env.labels.accepted, value: false }],
      conditions: [{ fields: [{ label: env.labels.Text1 }], when: { label: env.labels.accepted, equals: true },
        onInactive: 'require-empty', evidence: { quote: 'Only if accepted, provide name' } }] }
    const blocked = await env.fill.execute(input, { agent, signal }) as Failure
    assert.equal(blocked.status, 'condition_failed'); assert.equal(blocked.issues[0].label, env.labels.Text1)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields![0].value, 'Demo')
    const cleared = await env.fill.execute({ ...input, fields: [{ label: env.labels.Text1, value: '' }] }, { agent, signal }) as {
      revision: number }
    const stale = await env.fill.execute({ ...input, expectedRevision: cleared.revision,
      fields: [{ label: env.labels.Text1, value: 'Alex' }, { label: env.labels.accepted, value: true }] },
    { agent, signal }) as Failure
    assert.equal(stale.status, 'inspection_required')
    const refilled = await env.fill.execute({ ...input, expectedRevision: cleared.revision, inspectionId: env.refresh(),
      fields: [{ label: env.labels.Text1, value: 'Alex' }, { label: env.labels.accepted, value: true }] },
    { agent, signal }) as { status: string }
    assert.equal(refilled.status, 'updated'); assert.equal(env.state.writes(), 0)
  } finally { await env.dispose() }
})

test('batch-inspected independent pages queue concurrently against their original revisions without losing writes', async () => {
  const env = await setup(await formPageBatchesFixture())
  try {
    const ids = env.inspectAll(), originalRevision = env.opened.revision
    const inputs = ids.map((inspectionId, index) => ({ documentId: env.opened.id, expectedRevision: originalRevision,
      inspectionId, fields: [{ label: 'F01', value: `Page ${index + 1}` }] }))
    const results = await Promise.all(inputs.map(input => env.fill.execute(input, { agent, signal }))) as Array<{
      status: string; page: number; inspectionId: string; revision: number; appliedCount: number }>
    assert.deepEqual(results.map(result => result.status), ['updated', 'updated', 'updated'])
    assert.deepEqual(results.map(result => result.page), [1, 2, 3])
    assert.deepEqual(results.map(result => result.inspectionId), ids)
    assert.deepEqual(results.map(result => result.revision), [originalRevision + 1, originalRevision + 2, originalRevision + 3])
    const current = env.state.workspaces.readSnapshot(sessionId, env.opened.id)
    assert.deepEqual(current.document.formFields!.filter(field => field.name.startsWith('page-')).map(field => field.value),
      ['Page 1', 'Page 2', 'Page 3'])
    assert.equal(current.document.formFields!.find(field => field.name === 'shared')!.value, '')
    assert.equal(env.state.writes(), 0)
    await env.state.workspaces.execute(sessionId, { action: 'undo', sessionId, id: env.opened.id,
      revision: current.revision }, agent, signal)
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .filter(field => field.name.startsWith('page-')).map(field => field.value), ['Page 1', 'Page 2', ''])
  } finally { await env.dispose() }
})

test('a changed shared field invalidates another page inspection even when its submitted target is independent', async () => {
  const env = await setup(await formPageBatchesFixture())
  try {
    const ids = env.inspectAll(), input = { documentId: env.opened.id, expectedRevision: env.opened.revision }
    const result = await env.fill.execute({ ...input, inspectionId: ids[0],
      fields: [{ label: env.labels.shared, value: 'Shared change' }] }, { agent, signal }) as { status: string }
    assert.equal(result.status, 'updated')
    const conflict = await env.fill.execute({ ...input, inspectionId: ids[1],
      fields: [{ label: 'F01', value: 'Must not write' }] }, { agent, signal }) as Failure
    assert.equal(conflict.status, 'inspection_required'); assert.equal(conflict.appliedCount, 0)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .find(field => field.name === 'page-2')!.value, '')
  } finally { await env.dispose() }
})

test('cross-page dependency references require original-snapshot inspection and reject changed controlling fields', async () => {
  const env = await setup(await formPageBatchesFixture())
  try {
    const ids = env.inspectAll(), input = { documentId: env.opened.id, expectedRevision: env.opened.revision }
    const controllerIndex = env.opened.document.formFields!.findIndex(field => field.name === 'controller')
    const condition = { fields: [{ label: 'F01' }], when: { sharedFieldKey: `G${controllerIndex + 1}`, equals: false },
      evidence: { quote: 'Provide details only when the controlling option is not checked' } }
    const changed = await env.fill.execute({ ...input, inspectionId: ids[0],
      fields: [{ label: env.labels.controller, value: true }] }, { agent, signal }) as { status: string }
    assert.equal(changed.status, 'updated')
    const conflict = await env.fill.execute({ ...input, inspectionId: ids[1], conditions: [condition],
      fields: [{ label: 'F01', value: 'Must not write' }] }, { agent, signal }) as Failure
    assert.equal(conflict.status, 'inspection_required'); assert.equal(conflict.appliedCount, 0)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .find(field => field.name === 'page-2')!.value, '')
  } finally { await env.dispose() }
})

test('unchanged cross-page dependencies remain usable after another independent page changes', async () => {
  const env = await setup(await formPageBatchesFixture())
  try {
    const ids = env.inspectAll(), input = { documentId: env.opened.id, expectedRevision: env.opened.revision }
    const controllerIndex = env.opened.document.formFields!.findIndex(field => field.name === 'controller')
    await env.fill.execute({ ...input, inspectionId: ids[2], fields: [{ label: 'F01', value: 'Third' }] }, { agent, signal })
    const result = await env.fill.execute({ ...input, inspectionId: ids[1], fields: [{ label: 'F01', value: 'Second' }],
      conditions: [{ fields: [{ label: 'F01' }], when: { sharedFieldKey: `G${controllerIndex + 1}`, equals: false },
        evidence: { quote: 'Provide details only when the controlling option is not checked' } }] },
    { agent, signal }) as { status: string; conditionReview: { evaluated: number } }
    assert.equal(result.status, 'updated'); assert.equal(result.conditionReview.evaluated, 1)
    assert.equal(env.state.writes(), 0)
  } finally { await env.dispose() }
})

test('an unrelated field change on a dependency page does not invalidate an unchanged controlling field', async () => {
  const env = await setup(await formPageBatchesFixture())
  try {
    const ids = env.inspectAll(), input = { documentId: env.opened.id, expectedRevision: env.opened.revision }
    const controllerIndex = env.opened.document.formFields!.findIndex(field => field.name === 'controller')
    await env.fill.execute({ ...input, inspectionId: ids[0], fields: [{ label: 'F01', value: 'First' }] }, { agent, signal })
    const result = await env.fill.execute({ ...input, inspectionId: ids[1], fields: [{ label: 'F01', value: 'Second' }],
      conditions: [{ fields: [{ label: 'F01' }], when: { sharedFieldKey: `G${controllerIndex + 1}`, equals: false },
        evidence: { quote: 'Provide details only when the controlling option is not checked' } }] },
    { agent, signal }) as { status: string; conditionReview: { evaluated: number } }
    assert.equal(result.status, 'updated'); assert.equal(result.conditionReview.evaluated, 1)
    assert.equal(env.state.writes(), 0)
  } finally { await env.dispose() }
})

test('single-page writes reject old multi-page/native inputs and never infer another page from F labels', async () => {
  const env = await setup(await formPageBatchesFixture())
  try {
    const ids = env.inspectAll(), input = { documentId: env.opened.id, expectedRevision: env.opened.revision,
      inspectionId: ids[1], fields: [{ label: 'F01', value: 'Only second' }] }
    for (const changed of [
      { inspectionIds: ids }, { page: 2 },
      { fields: [{ page: 1, label: 'F01', value: 'Forbidden' }] },
      { fields: [{ sharedFieldKey: 'G1', value: 'Forbidden' }] },
      { fields: [{ fieldId: 'pdf-field:1:0', value: 'Forbidden' }] },
    ]) await assert.rejects(env.fill.execute({ ...input, ...changed }, { agent, signal }))
    const result = await env.fill.execute(input, { agent, signal }) as { status: string; page: number }
    assert.equal(result.status, 'updated'); assert.equal(result.page, 2)
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .filter(field => field.name.startsWith('page-')).map(field => field.value), ['', 'Only second', ''])
  } finally { await env.dispose() }
})

test('an untracked Reader edit invalidates batch inspections even when it touched another page', async () => {
  const env = await setup(await formPageBatchesFixture())
  try {
    const ids = env.inspectAll()
    await env.state.workspaces.execute(sessionId, { action: 'change', sessionId, id: env.opened.id,
      revision: env.opened.revision, operations: [{ type: 'set-field', name: 'page-1', value: 'Reader edit' }] }, agent, signal)
    const result = await env.fill.execute({ documentId: env.opened.id, expectedRevision: env.opened.revision,
      inspectionId: ids[2], fields: [{ label: 'F01', value: 'Must not write' }] }, { agent, signal }) as Failure
    assert.ok(['conflict', 'inspection_required'].includes(result.status)); assert.equal(result.appliedCount, 0)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .find(field => field.name === 'page-3')!.value, '')
  } finally { await env.dispose() }
})

test('uninspected cross-page keys and changed cross-page choice-group members never authorize a write', async () => {
  const env = await setup(await formPageBatchesFixture())
  try {
    const secondChoiceIndex = env.opened.document.formFields!.findIndex(field => field.name === 'alternative-2')
    const firstChoiceIndex = env.opened.document.formFields!.findIndex(field => field.name === 'alternative-1')
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision }
    const uninspected = await env.fill.execute({ ...input, inspectionId: env.inspectionId,
      fields: [{ label: 'F01', value: 'Forbidden' }], conditions: [{ fields: [{ label: 'F01' }],
        when: { sharedFieldKey: `G${secondChoiceIndex + 1}`, equals: false }, evidence: { quote: 'If option is clear' } }] },
    { agent, signal }) as Failure
    assert.equal(uninspected.status, 'inspection_required'); assert.equal(uninspected.appliedCount, 0)
    const ids = env.inspectAll()
    const selected = await env.fill.execute({ ...input, inspectionId: ids[0],
      fields: [{ label: env.labels['alternative-1'], value: true }] }, { agent, signal }) as { status: string }
    assert.equal(selected.status, 'updated')
    const page2Choice = inspectFormPage(env.opened.document, 2).fields.find(field => field.name === 'alternative-2')!.controls[0].label
    const conflict = await env.fill.execute({ ...input, inspectionId: ids[1],
      fields: [{ label: page2Choice, value: true }], choiceGroups: [{ fields: [
        { label: page2Choice }, { sharedFieldKey: `G${firstChoiceIndex + 1}` }], evidence: { quote: 'Choose only one option' } }] },
    { agent, signal }) as Failure
    assert.equal(conflict.status, 'inspection_required'); assert.equal(conflict.appliedCount, 0)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields![secondChoiceIndex].value, false)
  } finally { await env.dispose() }
})

test('a validation failure or canceled queued caller does not poison later independent page fills', async () => {
  const env = await setup(await formPageBatchesFixture())
  try {
    const ids = env.inspectAll(), input = { documentId: env.opened.id, expectedRevision: env.opened.revision }
    const canceled = new AbortController(); canceled.abort()
    const results = await Promise.allSettled([
      env.fill.execute({ ...input, inspectionId: ids[0], fields: [{ label: 'F01', value: true }] }, { agent, signal }),
      env.fill.execute({ ...input, inspectionId: ids[1], fields: [{ label: 'F01', value: 'Second' }] }, { agent, signal }),
      env.fill.execute({ ...input, inspectionId: ids[2], fields: [{ label: 'F01', value: 'Canceled' }] },
        { agent, signal: canceled.signal }),
      env.fill.execute({ ...input, inspectionId: ids[2], fields: [{ label: 'F01', value: 'Third' }] }, { agent, signal }),
    ])
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled'])
    assert.equal((results[0] as PromiseFulfilledResult<{ status: string }>).value.status, 'validation_failed')
    assert.equal((results[1] as PromiseFulfilledResult<{ status: string }>).value.status, 'updated')
    assert.equal((results[3] as PromiseFulfilledResult<{ status: string }>).value.status, 'updated')
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .filter(field => field.name.startsWith('page-')).map(field => field.value), ['', 'Second', 'Third'])
    assert.equal(env.state.writes(), 0)
  } finally { await env.dispose() }
})

test('undo is not a known fill transition and invalidates untouched batch page inspections', async () => {
  const env = await setup(await formPageBatchesFixture())
  try {
    const ids = env.inspectAll(), input = { documentId: env.opened.id, expectedRevision: env.opened.revision }
    const first = await env.fill.execute({ ...input, inspectionId: ids[0], fields: [{ label: 'F01', value: 'First' }] },
      { agent, signal }) as { revision: number }
    await env.state.workspaces.execute(sessionId, { action: 'undo', sessionId, id: env.opened.id,
      revision: first.revision }, agent, signal)
    const conflict = await env.fill.execute({ ...input, inspectionId: ids[2], fields: [{ label: 'F01', value: 'Forbidden' }] },
      { agent, signal }) as Failure
    assert.equal(conflict.status, 'inspection_required'); assert.equal(conflict.appliedCount, 0)
    assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .filter(field => field.name.startsWith('page-')).map(field => field.value), ['', '', ''])
    assert.equal(env.state.writes(), 0)
  } finally { await env.dispose() }
})

test('a newer dependency inspection cannot replace evidence from the batch original snapshot', async () => {
  const env = await setup(await formPageBatchesFixture())
  try {
    const ids = env.inspectAll(), input = { documentId: env.opened.id, expectedRevision: env.opened.revision }
    const controllerIndex = env.opened.document.formFields!.findIndex(field => field.name === 'controller')
    await env.fill.execute({ ...input, inspectionId: ids[0],
      fields: [{ label: env.labels.controller, value: true }] }, { agent, signal })
    env.refresh(1)
    const conflict = await env.fill.execute({ ...input, inspectionId: ids[1], fields: [{ label: 'F01', value: 'Forbidden' }],
      conditions: [{ fields: [{ label: 'F01' }], when: { sharedFieldKey: `G${controllerIndex + 1}`, equals: true },
        evidence: { quote: 'Complete details only when the controlling option is checked' } }] },
    { agent, signal }) as Failure
    assert.equal(conflict.status, 'inspection_required'); assert.equal(conflict.appliedCount, 0)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .find(field => field.name === 'page-2')!.value, '')
  } finally { await env.dispose() }
})

for (const teardown of ['unload', 'delete-session'] as const) test(`${teardown} after a committed draft write preserves its success response and clears every inspection`, async () => {
  const env = await setup(), inspections = createFormInspectionRegistry(), tools = new Map<string, Tool>()
  let unload = () => {}, unloaded = false
  const port: ModelWritePort = {
    readSnapshot: env.state.workspaces.readSnapshot,
    async execute(owner, input, caller, abort) {
      const result = await env.state.workspaces.execute(owner, input, caller, abort)
      if (input.action === 'change') {
        if (teardown === 'unload') unload()
        else inspections.deleteSession(sessionId)
        unloaded = true
      }
      return result
    },
  }
  unload = registerPdfModelWriteTools({ get() { throw new Error('Draft writes must not ask for approval') },
    tools: { register(tool: Tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } } as never,
  port, undefined, inspections)
  const identity = { sessionId, documentId: env.opened.id, revision: env.opened.revision,
    contentVersion: env.opened.contentVersion, sourceDigest: digest(env.opened.bytes) }
  const inspectionId = inspections.issue(identity, env.inspection, env.opened.document)
  const fill = tools.get('pdf_fill_form')!
  try {
    const result = await fill.execute({ documentId: env.opened.id, expectedRevision: env.opened.revision,
      inspectionId, fields: [{ label: env.labels.accepted, value: true }] }, { agent, signal }) as {
        status: string; revision: number; appliedCount: number; dirty: boolean }
    assert.equal(unloaded, true, 'The test invalidates inspections only after the real draft commit and before delivery')
    assert.equal(result.status, 'updated'); assert.equal(result.appliedCount, 1)
    assert.equal(result.dirty, true); assert.equal(result.revision, env.opened.revision + 1)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .find(field => field.name === 'accepted')!.value, true)
    assert.throws(() => inspections.resolve(inspectionId, { ...identity, revision: result.revision }, identity.revision),
      { code: 'pdf/form-inspection-required' })
    if (teardown === 'unload') assert.throws(() => inspections.issue(identity, env.inspection, env.opened.document),
      { code: 'pdf/form-inspection-required' })
    assert.equal(env.state.writes(), 0)
  } finally { unload(); await env.dispose() }
})

test('a Reader edit while source inspection is pending wins CAS and invalidates untouched batch inspections', async () => {
  const env = await setup(await formPageBatchesFixture()), inspections = createFormInspectionRegistry()
  const tools = new Map<string, Tool>()
  let interleaved = false
  const port: ModelWritePort = {
    readSnapshot: env.state.workspaces.readSnapshot,
    async execute(owner, input, caller, abort) {
      const result = await env.state.workspaces.execute(owner, input, caller, abort)
      if (input.action === 'inspectTarget' && !interleaved) {
        interleaved = true
        const current = env.state.workspaces.readSnapshot(sessionId, env.opened.id)
        await env.state.workspaces.execute(sessionId, { action: 'change', sessionId, id: current.id,
          revision: current.revision, operations: [{ type: 'set-field', name: 'page-1', value: 'Reader wins' }] }, agent, signal)
      }
      return result
    },
  }
  const unload = registerPdfModelWriteTools({ get() { throw new Error('Draft writes must not ask for approval') },
    tools: { register(tool: Tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } } as never,
  port, undefined, inspections)
  const identity = { sessionId, documentId: env.opened.id, revision: env.opened.revision,
    contentVersion: env.opened.contentVersion, sourceDigest: digest(env.opened.bytes) }
  const ids = env.opened.document.pages.map(page => inspections.issue(identity,
    inspectFormPage(env.opened.document, page.page), env.opened.document))
  const fill = tools.get('pdf_fill_form')!, input = { documentId: env.opened.id, expectedRevision: env.opened.revision }
  try {
    const failed = await fill.execute({ ...input, inspectionId: ids[0], fields: [{ label: 'F01', value: 'Model loses' }] },
      { agent, signal }) as Failure
    assert.equal(interleaved, true)
    assert.equal(failed.status, 'conflict'); assert.equal(failed.code, 'pdf/stale-revision'); assert.equal(failed.appliedCount, 0)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .find(field => field.name === 'page-1')!.value, 'Reader wins')
    const untouched = await fill.execute({ ...input, inspectionId: ids[2], fields: [{ label: 'F01', value: 'Forbidden' }] },
      { agent, signal }) as Failure
    assert.equal(untouched.status, 'inspection_required'); assert.equal(untouched.appliedCount, 0)
    assert.equal(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
      .find(field => field.name === 'page-3')!.value, '')
    assert.equal(env.state.writes(), 0)
  } finally { unload(); await env.dispose() }
})
