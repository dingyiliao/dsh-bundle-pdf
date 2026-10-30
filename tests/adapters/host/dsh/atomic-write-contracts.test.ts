import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { registerPdfModelWriteTools } from '../../../../src/adapters/host/dsh/model-write-tools.ts'
import { memoryWorkspace } from '../../../native-fixture.ts'

interface Tool {
  name: string
  parameters: { properties: Record<string, { type?: string; items?: unknown; oneOf?: unknown[] }> }
  execute(raw: unknown, execution: unknown): Promise<unknown>
}

async function fixture() {
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400])
  const state = memoryWorkspace(await pdf.save())
  const agent = { session: { id: 'atomic-write-tools', header: {} } }
  const execution = { agent, signal: new AbortController().signal }
  const tools = new Map<string, Tool>()
  const disposeTools = registerPdfModelWriteTools({ get() { throw new Error('Draft edits must not request confirmation') },
    tools: { register(tool: Tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  } as never, state.workspaces)
  const opened = await state.workspaces.execute(agent.session.id, { action: 'open', sessionId: agent.session.id,
    address: `dsh-resource://file/session/${agent.session.id}//fixtures/native.pdf` }, agent, execution.signal)
  assert.ok('bytes' in opened)
  return { tools, execution, state, opened,
    async dispose() { disposeTools(); await state.workspaces.dispose() } }
}

test('model annotation creation rejects embedded text discovery and requires a resolved reference or note region', async () => {
  const env = await fixture()
  try {
    assert.ok(env.tools.has('pdf_annotation_create'))
    assert.ok(!env.tools.has('pdf_annotate'))
    assert.ok(env.tools.has('pdf_form_fill'))
    assert.ok(!env.tools.has('pdf_fill_form'))
    const tool = env.tools.get('pdf_annotation_create')!
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision, subtype: 'Highlight' }
    for (const target of [
      { kind: 'pdf-text', page: 1, quote: 'Find this text' },
      { kind: 'pdf-text-range', start: { page: 1, quote: 'Start' }, end: { page: 1, quote: 'End' } },
      { kind: 'reference', refId: 'known-ref', quote: 'Narrow inside this write' },
    ]) await assert.rejects(tool.execute({ ...input, target }, env.execution))
    assert.equal(env.state.workspaces.readSnapshot(env.execution.agent.session.id, env.opened.id).revision, env.opened.revision)
    assert.equal(env.state.writes(), 0)
  } finally { await env.dispose() }
})

test('renamed annotation tools perform create, update and delete through the shared unsaved draft', async () => {
  const env = await fixture()
  try {
    const created = await env.tools.get('pdf_annotation_create')!.execute({ documentId: env.opened.id,
      expectedRevision: env.opened.revision, subtype: 'Text', target: { kind: 'pdf-region', page: 1, rectPdf: [30, 40, 60, 70] },
      comment: 'First note',
    }, env.execution) as { revision: number; annotationId: string; savedToFile: boolean }
    assert.equal(created.savedToFile, false)
    const updated = await env.tools.get('pdf_annotation_update')!.execute({ documentId: env.opened.id,
      expectedRevision: created.revision, annotationId: created.annotationId, comment: 'Edited note',
    }, env.execution) as { revision: number }
    const snapshot = env.state.workspaces.readSnapshot(env.execution.agent.session.id, env.opened.id)
    assert.equal(snapshot.document.annotations.find(item => item.id === created.annotationId)?.contents, 'Edited note')
    await env.tools.get('pdf_annotation_delete')!.execute({ documentId: env.opened.id, expectedRevision: updated.revision,
      annotationId: created.annotationId }, env.execution)
    assert.equal(env.state.workspaces.readSnapshot(env.execution.agent.session.id, env.opened.id).document.annotations.length, 0)
    assert.equal(env.state.writes(), 0)
  } finally { await env.dispose() }
})

test('bookmark edits publish structured operations and reject malformed batches before any change', async () => {
  const env = await fixture()
  try {
    const tool = env.tools.get('pdf_bookmark_edit')!
    assert.ok(tool)
    assert.ok(!env.tools.has('pdf_outline_edit'))
    assert.equal(tool.parameters.properties.operations.type, 'array')
    const input = { documentId: env.opened.id, expectedRevision: env.opened.revision }
    await assert.rejects(tool.execute({ ...input, operations: '[{"type":"outline-delete","id":"wrong"}]' }, env.execution))
    await assert.rejects(tool.execute({ ...input, operations: [
      { type: 'outline-add', id: 'first', title: 'First', page: 1 },
      { type: 'outline-move', id: 'first', index: -1 },
    ] }, env.execution))
    assert.equal(env.state.workspaces.readSnapshot(env.execution.agent.session.id, env.opened.id).document.outline?.length ?? 0, 0)
    assert.equal(env.state.workspaces.readSnapshot(env.execution.agent.session.id, env.opened.id).revision, env.opened.revision)
  } finally { await env.dispose() }
})
