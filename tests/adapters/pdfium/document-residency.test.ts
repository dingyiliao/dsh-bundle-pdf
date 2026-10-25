import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createPdfService } from '../../../src/adapters/host/pdfium/index.ts'
import { createBackgroundDocuments } from '../../../src/modules/working-copy/index.ts'
import { memoryWorkspace } from '../../native-fixture.ts'
import { acroformFixture } from '../../fixtures/acroform.ts'
import { nativeTestSubprocess } from '../../native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const skip = !existsSync(executable)

test('real native residency suspends/reacquires the shared dirty form and UI takeover sees model values', { skip }, async () => {
  const state = memoryWorkspace(await acroformFixture())
  const pdf = createPdfService(state.workspaces, { executable, subprocess: nativeTestSubprocess })
  let offset = 0
  const policy = createBackgroundDocuments(state.workspaces, pdf, { now: () => Date.now() + offset, schedule: false })
  const sessionId = 'native-document-residency', agent = { session: { id: sessionId, header: {} } }
  const signal = new AbortController().signal
  const address = `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`
  try {
    const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId, address, owner: 'agent' }, agent, signal)
    assert.ok('bytes' in opened)
    await policy.adopt(sessionId, opened.id, opened.bytes.length)
    const unpin = await state.workspaces.acquire(sessionId, opened.id, agent, signal)
    try {
      await pdf.renderFormPage(sessionId, opened.id, 1, 1024, true, signal)
      assert.equal(pdf.diagnostics().documents, 1)
      await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id, revision: opened.revision,
        operations: [{ type: 'set-field', fieldId: opened.document.formFields![0].id!, value: 'Shared' }] }, agent, signal)
      offset = 11 * 60_000
      await policy.sweep()
      assert.equal(state.workspaces.listDocuments()[0].resident, true, 'Active inspection/write cannot lose its working set')
      assert.equal(await policy.close(sessionId, opened.id), 'retained-operation')
    } finally { unpin() }
    await policy.sweep()
    assert.equal(pdf.diagnostics().documents, 0, 'Native handle is actually released')
    assert.equal(state.workspaces.listDocuments()[0].resident, false)
    assert.equal(state.workspaces.listDocuments()[0].id, opened.id)
    const ui = await pdf.dispatch(sessionId, { action: 'open', sessionId, address, referenceId: 'takeover' }, agent, signal) as {
      id: string; dirty: boolean; revision: number; document: { formFields: { value: unknown }[] }
    }
    assert.equal(ui.id, opened.id)
    assert.equal(ui.dirty, true)
    assert.equal(ui.document.formFields[0].value, 'Shared')
    assert.equal(ui.revision, opened.revision + 1)
    assert.equal(pdf.diagnostics().documents, 1)
    await pdf.dispatch(sessionId, { action: 'release', sessionId, referenceId: 'takeover' }, agent, signal)
    await policy.sweep()
    assert.equal(pdf.diagnostics().documents, 0)
    assert.equal(state.workspaces.listDocuments().length, 1)
    assert.equal(state.writes(), 0, 'No implicit save to the source file')
    assert.ok(state.records.size > 0, 'Unsaved form draft still exists')
  } finally { await policy.dispose(); await pdf.dispose(); await state.workspaces.dispose() }
})
