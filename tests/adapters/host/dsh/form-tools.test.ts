import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { registerPdfAgentTools } from '../../../../src/adapters/host/dsh/agent-tools.ts'
import { createPdfService } from '../../../../src/adapters/host/pdfium/index.ts'
import { registerPdfFormInspectionTool } from '../../../../src/adapters/host/dsh/model-form-tools.ts'
import { inspectFormPage, type FormPageInspection } from '../../../../src/modules/forms/index.ts'
import { acroformFixture, duplicateFieldNamesFixture } from '../../../fixtures/acroform.ts'
import { memoryWorkspace, digest } from '../../../native-fixture.ts'
import { NativeTestSubprocess } from '../../../native-test-subprocess.ts'

interface Tool {
  name: string
  execute(raw: unknown, exec: unknown): Promise<unknown>
  output: { render(raw: unknown, value: unknown): Array<{ type: string; text?: string; attachment?: { attachmentId: string } }> }
}
type Result = { fields: FormPageInspection['fields']; controlCount: number; revision: number;
  includesValues: boolean; hasUnsavedFormChanges: boolean; imageState: string; image: { attachmentId: string } }
const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native tests require a built helper')
const sessionId = 'form-tools'
const agent = { session: { id: sessionId, header: {}, requestHeader() { return undefined } },
  options: { provider: 'fixture', model: 'vision' } }
const signal = new AbortController().signal

async function setup(source?: Uint8Array) {
  const state = memoryWorkspace(source ?? await acroformFixture())
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in opened)
  const images = new Map<string, Uint8Array>(), tools = new Map<string, Tool>()
  let visual = true, saves = 0
  let beforeStore: (() => Promise<void>) | undefined
  const attachments = { imageLimits: { mediaTypes: ['image/png'] },
    async saveImage({ data }: { data: Uint8Array }) {
      await beforeStore?.()
      saves++
      const png = Buffer.from(data), attachmentId = digest(png)
      images.set(attachmentId, png)
      return { attachmentId, mediaType: 'image/png' as const, bytes: png.length,
        width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
    } }
  const services: Record<string, unknown> = { attachments,
    llm: { async resolveModelInfo() { return { inputModalities: visual ? ['text', 'image'] : ['text'] } } } }
  const ctx = { get(name: string) { return services[name] }, tools: { register(tool: Tool) { tools.set(tool.name, tool); return () => {} } } }
  const pdf = createPdfService(state.workspaces, { executable, subprocess: new NativeTestSubprocess() })
  const dispose = registerPdfAgentTools(ctx as never, state.workspaces, pdf, { current: () => [] })
  return { state, opened, images, tools, services, attachments, saves: () => saves,
    setVisual(value: boolean) { visual = value }, beforeStore(value?: () => Promise<void>) { beforeStore = value },
    async dispose() { await dispose(); await pdf.dispose(); await state.workspaces.dispose() } }
}

test('two discoverable form tools return real numbered native images and edit the same unsaved draft',
  { skip: !existsSync(executable) }, async () => {
    const env = await setup()
    try {
      const inspect = env.tools.get('pdf_form_inspect_page')!, fill = env.tools.get('pdf_fill_form')!
      assert.ok(inspect); assert.ok(fill); assert.equal(env.tools.has('pdf_form_fields'), false)
      const args = { documentId: env.opened.id, page: 1 }
      const result = await inspect.execute(args, { agent, signal }) as Result
      assert.deepEqual(result.fields.map(field => field.name), ['Text1', 'accepted', 'contact', 'choice', 'list'])
      assert.ok(result.fields.every(field => /^pdf-field:\d+:\d+$/.test(field.fieldId)))
      assert.equal(result.controlCount, 6)
      assert.ok(result.fields.every(field => !('value' in field)))
      assert.equal(result.hasUnsavedFormChanges, false)
      assert.deepEqual(result.fields[2].controls.map(control => control.option), ['email', 'phone'])
      const output = inspect.output.render(args, result)
      assert.deepEqual(output.map(item => item.type), ['text', 'image'])
      assert.match(output[0].text!, /Text1/); assert.match(output[0].text!, /F01/)
      assert.equal(output[1].attachment!.attachmentId, result.image.attachmentId)
      const png = env.images.get(result.image.attachmentId)!
      if (process.env.PDF_FORM_INSPECTION_SCREENSHOT) await writeFile(process.env.PDF_FORM_INSPECTION_SCREENSHOT, png)
      const data = Buffer.from(png), chunks: Buffer[] = []
      for (let offset = 8; offset + 12 <= data.length;) {
        const length = data.readUInt32BE(offset)
        if (data.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(data.subarray(offset + 8, offset + 8 + length))
        offset += length + 12
      }
      const raster = inflateSync(Buffer.concat(chunks)), width = data.readUInt32BE(16)
      for (const field of result.fields) for (const control of field.controls) {
        const [left, top] = control.labelRect
        const offset = (Math.floor(top) + 1) * (width * 4 + 1) + 1 + (Math.floor(left) + 1) * 4
        assert.deepEqual([...raster.subarray(offset, offset + 4)], [24, 83, 201, 255], `${control.label} must be painted`)
      }
      const changed = await fill.execute({ documentId: env.opened.id, expectedRevision: result.revision,
        fields: [{ fieldId: result.fields[0].fieldId, value: '测试' }] }, { agent, signal }) as { revision: number; dirty: boolean }
      assert.equal(changed.dirty, true); assert.equal(env.state.writes(), 0)
      const current = await inspect.execute({ ...args, includeValues: true }, { agent, signal }) as Result
      assert.equal(current.revision, changed.revision)
      assert.equal(current.fields[0].value, '测试'); assert.equal(current.hasUnsavedFormChanges, true)
      assert.equal(current.imageState, 'numbered-source-page')
      assert.deepEqual(env.images.get(current.image.attachmentId), png, 'Source image remains explicitly distinct from unsaved draft values')
      const rotated = await inspect.execute({ ...args, page: 2 }, { agent, signal }) as Result
      assert.equal(rotated.controlCount, 1); assert.equal(rotated.fields[0].fieldId, result.fields[0].fieldId)
      assert.equal(rotated.fields[0].controls[0].label, 'F01', 'Labels are local to each page')
    } finally { await env.dispose() }
  })

test('form inspection rejects non-visual models, foreign sessions, invalid input and stale delivery',
  { skip: !existsSync(executable) }, async () => {
    const env = await setup()
    const inspect = env.tools.get('pdf_form_inspect_page')!
    const args = { documentId: env.opened.id, page: 1 }
    try {
      await assert.rejects(inspect.execute(args, { signal }), { code: 'pdf/session-required' })
      await assert.rejects(inspect.execute(args, { signal, agent: { ...agent, session: { id: 'foreign', header: {} } } }), /session|belong/i)
      env.setVisual(false)
      await assert.rejects(inspect.execute(args, { agent, signal }), { code: 'pdf/image-input-unsupported' })
      assert.equal(env.saves(), 0)
      env.setVisual(true)
      await assert.rejects(inspect.execute({ ...args, page: 0 }, { agent, signal }))
      await assert.rejects(inspect.execute({ ...args, maxEdge: 1025 }, { agent, signal }))
      env.beforeStore(async () => {
        const snapshot = env.state.workspaces.readSnapshot(sessionId, env.opened.id)
        await env.state.workspaces.execute(sessionId, { action: 'change', sessionId, id: snapshot.id, revision: snapshot.revision,
          operations: [{ type: 'set-field', name: 'accepted', value: true }] }, agent, signal)
      })
      await assert.rejects(inspect.execute(args, { agent, signal }), { code: 'pdf/stale-revision' })
      assert.equal(env.state.writes(), 0)
      env.beforeStore()
      const fill = env.tools.get('pdf_fill_form')!
      await assert.rejects(fill.execute({ documentId: env.opened.id, expectedRevision: env.opened.revision,
        fields: [{ fieldId: 'Text1', value: 'value' }] }, { agent, signal }), { code: 'pdf/stale-revision' })
    } finally { await env.dispose() }
  })

test('numbered form tools distinguish same-name fields and native appearances after save',
  { skip: !existsSync(executable) }, async () => {
    const env = await setup(await duplicateFieldNamesFixture())
    try {
      const inspect = env.tools.get('pdf_form_inspect_page')!, fill = env.tools.get('pdf_fill_form')!
      const args = { documentId: env.opened.id, page: 1 }
      const initial = await inspect.execute(args, { agent, signal }) as Result
      const boxes = initial.fields.filter(field => field.name === 'same-name')
      assert.equal(boxes.length, 3); assert.equal(new Set(boxes.map(field => field.fieldId)).size, 3)
      const edited = await fill.execute({ documentId: env.opened.id, expectedRevision: initial.revision,
        fields: [{ fieldId: boxes[1].fieldId, value: true }] }, { agent, signal }) as { revision: number }
      await env.state.workspaces.execute(sessionId, { action: 'save', sessionId,
        id: env.opened.id, revision: edited.revision, options: {} }, agent, signal)
      const saved = await inspect.execute({ ...args, includeValues: true }, { agent, signal }) as Result
      assert.deepEqual(saved.fields.filter(field => field.name === 'same-name').map(field => field.value), [false, true, false])
      const png = Buffer.from(env.images.get(saved.image.attachmentId)!), chunks: Buffer[] = []
      if (process.env.PDF_DUPLICATE_FORM_SCREENSHOT) await writeFile(process.env.PDF_DUPLICATE_FORM_SCREENSHOT, png)
      for (let offset = 8; offset + 12 <= png.length;) {
        const length = png.readUInt32BE(offset)
        if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length))
        offset += length + 12
      }
      const scanlines = inflateSync(Buffer.concat(chunks)), width = png.readUInt32BE(16)
      const inkCounts = boxes.map(field => {
        const [left, top, right, bottom] = field.controls[0].rectImage
        let count = 0
        for (let y = Math.ceil(top + 4); y < Math.floor(bottom - 4); y++) {
          for (let x = Math.ceil(left + 4); x < Math.floor(right - 4); x++) {
            const offset = y * (width * 4 + 1) + 1 + x * 4
            if (scanlines[offset] < 100 && scanlines[offset + 1] < 100 && scanlines[offset + 2] < 100) count++
          }
        }
        return count
      })
      assert.ok(inkCounts[1] > inkCounts[0] + 10 && inkCounts[1] > inkCounts[2] + 10,
        `Only the chosen native checkbox must be painted checked: ${inkCounts.join(',')}`)
    } finally { await env.dispose() }
  })

test('form inspection fails closed on external source changes, canceled requests or attachment resizing', async () => {
  const state = memoryWorkspace(await acroformFixture())
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in opened)
  let sourceChanged = false, resize = false, calls = 0
  const tools = new Map<string, Tool>()
  const ctx = { tools: { register(tool: Tool) { tools.set(tool.name, tool); return () => {} } },
    get() { return { imageLimits: { mediaTypes: ['image/png'] }, async saveImage() {
      return { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 10, width: resize ? 500 : 512, height: 768 }
    } } } }
  registerPdfFormInspectionTool(ctx as never, { readSnapshot: state.workspaces.readSnapshot,
    async execute(owner, request, caller, abort) { return sourceChanged ? { version: 'external-change' }
      : state.workspaces.execute(owner, request, caller, abort) } },
  { async renderFormPage() { calls++; return { snapshot: opened, png: new Uint8Array(), width: 512, height: 768,
    formInspection: inspectFormPage(opened.document, 1, 512, 768) } } }, async () => {}, () => {})
  try {
    const inspect = tools.get('pdf_form_inspect_page')!, args = { documentId: opened.id, page: 1 }
    sourceChanged = true
    await assert.rejects(inspect.execute(args, { agent, signal }), { code: 'pdf/source-conflict' })
    assert.equal(calls, 0)
    sourceChanged = false; resize = true
    await assert.rejects(inspect.execute(args, { agent, signal }), { code: 'pdf/image-normalized' })
    const abort = new AbortController(); abort.abort()
    await assert.rejects(inspect.execute(args, { agent, signal: abort.signal }), /abort/i)
  } finally { await state.workspaces.dispose() }
})
