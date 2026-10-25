import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { Context } from '@deepseek-ai/cordis'
import ToolsService, { type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Storage, { type KvUnit } from '@deepseek-ai/dsh-storage'
import { DomainFacility, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { registerPdfAgentTools } from '../../../src/adapters/host/dsh/agent-tools.ts'
import { createPdfService } from '../../../src/adapters/host/pdfium/index.ts'
import { createReaderContexts } from '../../../src/modules/navigation/index.ts'
import { draftSchema } from '../../../src/modules/working-copy/index.ts'
import { createWorkspaces } from '../../../src/host/workspaces.ts'
import { memoryWorkspace } from '../../native-fixture.ts'

const sessionId = 'sdk-compatibility-session'
const address = sessionFileAddress(sessionId, '/fixtures/native.pdf')
const signal = new AbortController().signal
const agent = { session: { id: sessionId, header: { cwd: '/fixtures' } } }

async function blankPdf() {
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400])
  return pdf.save({ useObjectStreams: false })
}

test('published DSH native tool pipeline dispatches PDF tools and removes their fiber-owned registrations', async () => {
  const ctx = new Context()
  const fixture = memoryWorkspace(await blankPdf())
  const reader = createReaderContexts(fixture.workspaces)
  const pages = createPdfService(fixture.workspaces, {
    executable: 'unused-in-metadata-test',
    subprocess: {
      async resolveExecutable() { throw new Error('Metadata tools must not start a native process') },
      spawn() { throw new Error('Metadata tools must not start a native process') },
    },
  })
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolsService, { mode: 'native' })
    const owner = ctx.plugin({
      name: 'pdf-runtime-compatibility', inject: ['tools'],
      apply(scoped: Context) {
        const dispose = registerPdfAgentTools(scoped, fixture.workspaces, pages, reader)
        scoped.effect(() => dispose)
      },
    })
    await owner
    const opened = await fixture.workspaces.execute(sessionId, { action: 'open', sessionId, address }, agent, signal)
    assert.ok('document' in opened)
    reader.update(sessionId, { action: 'set', sessionId, tabId: 'reader-tab', leaseId: 'lease', sequence: 1,
      documentId: opened.id, contentVersion: opened.contentVersion, page: 1 })
    const schemas = (await ctx.systemPrompt.assemble()).tools
    assert.ok(schemas.some(tool => tool.name === 'pdf_current'))
    assert.ok(schemas.some(tool => tool.name === 'pdf_form_inspect_page'))
    assert.ok(schemas.some(tool => tool.name === 'pdf_fill_form'))

    // The real executor treats Agent as an opaque scope; this fixture supplies
    // only the session identity consumed by these PDF metadata tools.
    const toolAgent = agent as unknown as NonNullable<ToolExecutionInput['agent']>
    const run = (name: string, args: object) => ctx.tools.execute({ agent: toolAgent, signal,
      callId: ToolCallId(`call-${name}`), name, arguments: args })
    const result = await run('pdf_current', {})
    assert.ok(result && !result.isError, JSON.stringify(result))
    assert.deepEqual(result.value, { status: 'active', documents: [{ documentId: opened.id,
      tabId: 'reader-tab', path: '/fixtures/native.pdf', page: 1, pageCount: 1,
      revision: opened.revision, contentVersion: opened.contentVersion }] })
    const text = result.content.find(part => part.type === 'text')
    assert.ok(text?.type === 'text')
    assert.match(text.text, new RegExp(opened.id))

    const invalid = await run('pdf_current', { unexpected: true })
    assert.equal(invalid.isError, true, 'the executor preserves PDF argument validation failures')
    await owner.dispose()
    assert.ok(!ctx.tools.schemas().some(tool => tool.name.startsWith('pdf_')))
    assert.equal((await run('pdf_current', {})).isError, true)
  } finally {
    await ctx.fiber.dispose()
    reader.dispose()
    await pages.dispose()
    await fixture.workspaces.dispose()
  }
})

test('a rejected DSH storage write does not advance the PDF draft and a durable retry can succeed', async () => {
  const ctx = new Context()
  const fixture = memoryWorkspace(await blankPdf())
  const records = new Map<string, unknown>()
  const rejectedWrite = new Error('Synthetic backend rejected the draft write before publication')
  let failNextWrite = false, unitClosed = false, backendWrites = 0
  const unit: KvUnit = {
    async loadAll() { return { tables: { drafts: Object.fromEntries(records) }, global: null } },
    async putRecord(_table, key, value) {
      backendWrites++
      if (failNextWrite) { failNextWrite = false; throw rejectedWrite }
      records.set(key, structuredClone(value))
    },
    async deleteRecord(_table, key) { records.delete(key) },
    async setGlobal() { throw new Error('PDF drafts have no global record') },
    async close() { unitClosed = true },
  }
  await ctx.plugin(Storage)
  const unregister = ctx.storage.backend.register('pdf_test', { kv: { async open() { return unit } }, async close() {} })
  const facility = new DomainFacility(ctx, { backend: 'pdf_test' })
  const domain = await facility.open(defineDomain({ name: 'pdf_test_drafts', version: 1,
    layout: 'per-record', tables: { drafts: domainTable(draftSchema) } }))
  const table = domain.table('drafts')
  const workspaces = createWorkspaces(fixture.files, table)
  const reopened = createWorkspaces(fixture.files, table)
  try {
    const opened = await workspaces.execute(sessionId, { action: 'open', sessionId, address }, agent, signal)
    assert.ok('document' in opened)
    const edit = (id: string, revision: number, noteId: string) => workspaces.execute(sessionId, {
      action: 'change', sessionId, id, revision,
      operations: [{ type: 'add', annotation: { id: noteId, subtype: 'Text', page: 1,
        rect: [40, 40, 60, 60], contents: noteId } }],
    }, agent, signal)
    const first = await edit(opened.id, opened.revision, 'accepted-note')
    assert.ok('document' in first)
    failNextWrite = true
    await assert.rejects(edit(first.id, first.revision, 'rejected-note'), error => error === rejectedWrite)
    const confirmed = workspaces.readSnapshot(sessionId, first.id)
    assert.equal(confirmed.revision, first.revision)
    assert.equal(confirmed.dirty, true)
    assert.deepEqual(confirmed.document.annotations.map(note => note.id), ['accepted-note'])
    assert.equal(fixture.writes(), 0, 'draft failure never publishes the source PDF')
    const activeRecord = [...table.entries()].find(([, record]) => record.groups.length > 0)?.[1]
    assert.equal(activeRecord?.revision, first.revision, 'DSH domain keeps the last durably committed record')
    const writesAtFailure = backendWrites
    const retried = await edit(first.id, first.revision, 'retried-note')
    assert.ok('document' in retried)
    assert.equal(retried.revision, first.revision + 1)
    assert.equal(backendWrites, writesAtFailure + 1)
    const restored = await reopened.execute(sessionId, { action: 'open', sessionId, address }, agent, signal)
    assert.ok('document' in restored)
    assert.deepEqual(restored.document.annotations.map(note => note.id), ['accepted-note', 'retried-note'])
  } finally {
    await workspaces.dispose()
    await reopened.dispose()
    await fixture.workspaces.dispose()
    await facility.closeAll()
    unregister()
    await ctx.fiber.dispose()
  }
  assert.equal(unitClosed, true)
})
