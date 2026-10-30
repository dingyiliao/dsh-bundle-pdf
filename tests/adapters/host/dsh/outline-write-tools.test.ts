import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { registerPdfModelWriteTools, questionDetail } from '../../../../src/adapters/host/dsh/model-write-tools.ts'
import { memoryWorkspace } from '../../../native-fixture.ts'

test('pdf_bookmark_edit is discoverable and writes only the session-owned, unsaved draft', async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage()
  const state = memoryWorkspace(new Uint8Array(await pdf.save()))
  const sessionId = 'outline-tool'
  const agent = { session: { id: sessionId, header: {} } }
  const signal = new AbortController().signal
  const definitions = new Map<string, { execute(raw: unknown, exec: unknown): Promise<unknown>; description: string }>()
  const context = { get() { throw new Error('A draft edit must not request save approval') }, tools: {
    register(definition: { name: string; execute(raw: unknown, exec: unknown): Promise<unknown>; description: string }) {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
  } } as unknown as Parameters<typeof registerPdfModelWriteTools>[0]
  const dispose = registerPdfModelWriteTools(context, state.workspaces)
  try {
    const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
    assert.ok('bytes' in opened)
    const tool = definitions.get('pdf_bookmark_edit')!
    assert.ok(tool)
    assert.match(tool.description, /outlineId/)
    const args = { documentId: opened.id, expectedRevision: opened.revision,
      operations: [{ type: 'outline-add', id: 'chapter', title: 'Chapter', page: 1 }] }
    await assert.rejects(tool.execute(args, { signal }), { code: 'pdf/session-required' })
    await assert.rejects(tool.execute({ ...args, confirmed: true }, { agent, signal }), /Unrecognized key/)
    const result = await tool.execute(args, { agent, signal }) as { savedToFile: boolean; revision: number }
    assert.equal(result.savedToFile, false)
    assert.equal(result.revision, opened.revision + 1)
    assert.equal(state.writes(), 0)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).document.outline?.[0].id, 'chapter')
    assert.match(questionDetail({ kind: 'save', documentId: opened.id, path: opened.path,
      revision: result.revision, dirty: true, saveChangeCount: 1, saveDiffText: '新增PDF内置书签' }), /最终变化/)
  } finally { dispose(); await state.workspaces.dispose() }
})
