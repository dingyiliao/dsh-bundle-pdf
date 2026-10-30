import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { PDFDocument, PDFName } from 'pdf-lib'
import { registerPdfAgentTools } from '../../../../src/adapters/host/dsh/agent-tools.ts'
import { createPdfService } from '../../../../src/adapters/host/pdfium/index.ts'
import { registerPdfFormInspectionTool } from '../../../../src/adapters/host/dsh/model-form-tools.ts'
import { FORM_CONTEXT_GUIDANCE, FORM_CONTROL_AVAILABILITY_GUIDANCE } from '../../../../src/adapters/host/dsh/form-guidance.ts'
import { inspectFormPage, createFormInspectionRegistry, modelFormInspectionFields } from '../../../../src/modules/forms/index.ts'
import { acroformFixture, denseFormFixture, duplicateFieldNamesFixture } from '../../../fixtures/acroform.ts'
import { formPageBatchesFixture } from '../../../fixtures/form-page-batches.ts'
import { memoryWorkspace, digest } from '../../../native-fixture.ts'
import { NativeTestSubprocess } from '../../../native-test-subprocess.ts'

interface Tool {
  name: string
  description: string
  parameters?: Record<string, unknown>
  execute(raw: unknown, exec: unknown): Promise<unknown>
  output: { render(raw: unknown, value: unknown): Array<{ type: string; text?: string; attachment?: { attachmentId: string } }> }
}
type Result = { documentId: string; page: number; fields: ReturnType<typeof modelFormInspectionFields>;
  revision: number; inspectionId: string; readOnly: boolean; readOnlyReason?: string;
  image: { attachmentId: string; width: number; height: number } }

/** Explicit public allowlists prevent native geometry, identifiers, metadata and values from leaking back in. */
function assertCompactInspection(result: Result, includeValues = false) {
  assert.deepEqual(Object.keys(result).sort(), ['documentId', 'fields', 'image', 'inspectionId', 'page', 'readOnly',
    ...(result.readOnlyReason === undefined ? [] : ['readOnlyReason']), 'revision'].sort())
  const allowedFieldKeys = new Set(['sharedFieldKey', 'type', 'valueType', 'required', 'options', 'maxLength',
    'multiline', 'multiple', ...(includeValues ? ['value'] : []), 'controls'])
  for (const field of result.fields) {
    assert.ok(Object.keys(field).every(key => allowedFieldKeys.has(key)), `Unexpected public field keys: ${Object.keys(field)}`)
    for (const key of ['sharedFieldKey', 'type', 'valueType', 'required', 'controls']) assert.ok(key in field, `Missing ${key}`)
    assert.equal('value' in field, includeValues)
    for (const control of field.controls) {
      assert.deepEqual(Object.keys(control).sort(), ['label', ...(control.option === undefined ? [] : ['option'])].sort())
    }
  }
}
const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native tests require a built helper')
const sessionId = 'form-tools'
const agent = { session: { id: sessionId, header: {}, requestHeader() { return undefined } },
  options: { provider: 'fixture', model: 'vision' } }
const signal = new AbortController().signal

async function setup(source?: Uint8Array, background = false) {
  const state = memoryWorkspace(source ?? await acroformFixture())
  const uiOpened = background ? undefined : await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  if (uiOpened) assert.ok('bytes' in uiOpened)
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
  const opened = uiOpened ?? await (async () => {
    const result = await tools.get('pdf_open')!.execute({ path: '/fixtures/native.pdf' }, { agent, signal }) as { documentId: string }
    return state.workspaces.readSnapshot(sessionId, result.documentId)
  })()
  assert.ok('bytes' in opened)
  return { state, opened, images, tools, services, attachments, pdf, saves: () => saves,
    setVisual(value: boolean) { visual = value }, beforeStore(value?: () => Promise<void>) { beforeStore = value },
    async dispose() { await dispose(); await pdf.dispose(); await state.workspaces.dispose() } }
}

test('cold background form edits are adopted by the UI and both entrances keep the exact shared values',
  { skip: !existsSync(executable) }, async () => {
    const env = await setup(undefined, true)
    try {
      const id = env.opened.id
      assert.equal(env.state.workspaces.isUiOwned(sessionId, id), false,
        'the first open must come only from the model, without an implicit Reader')
      assert.equal(env.pdf.diagnostics().documents, 0, 'Host open does not require a pre-existing native/UI handle')
      const inspect = env.tools.get('pdf_form_inspect')!, fill = env.tools.get('pdf_form_fill')!
      const initial = await inspect.execute({ documentId: id, page: 1 }, { agent, signal }) as Result
      const text = initial.fields.find(field => field.type === 'text')!
      const changed = await fill.execute({ documentId: id, expectedRevision: initial.revision,
        inspectionId: initial.inspectionId, fields: [{ label: text.controls[0].label, value: 'Model' }] },
      { agent, signal }) as { revision: number; dirty: boolean; status: string }
      assert.equal(changed.status, 'updated', JSON.stringify(changed))
      const address = `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`
      const reader = await env.pdf.dispatch(sessionId, { action: 'open', sessionId, address,
        referenceId: 'cold-background-ui-takeover' }, agent, signal) as {
          id: string; revision: number; dirty: boolean; document: { formFields: Array<{ id: string; type: string; value: unknown }> }
        }
      assert.equal(reader.id, id)
      assert.equal(reader.revision, changed.revision); assert.equal(reader.dirty, true)
      const readerField = reader.document.formFields.find(field => field.type === 'text')!
      assert.equal(readerField.value, 'Model', 'UI takeover must show the existing projected form value, not source bytes')
      const wait = env.state.workspaces.waitForRevision(sessionId, id, reader.revision, signal)
      const ui = await env.pdf.dispatch(sessionId, { action: 'change', sessionId, id, revision: reader.revision,
        operations: [{ type: 'set-field', fieldId: readerField.id, value: 'Reader' }] }, agent, signal) as { revision: number }
      assert.equal(await wait, ui.revision)
      const observed = await inspect.execute({ documentId: id, page: 1, includeValues: true }, { agent, signal }) as Result
      assert.equal(observed.documentId, id); assert.equal(observed.revision, ui.revision)
      assert.equal(observed.fields.find(field => field.type === 'text')!.value, 'Reader',
        'the model must observe UI changes in the same authoritative draft')
      assert.equal(env.state.writes(), 0, 'neither entrance writes the source before an approved save')
      const reopened = await env.tools.get('pdf_open')!.execute({ path: '/fixtures/native.pdf' }, { agent, signal }) as { documentId: string }
      assert.equal(reopened.documentId, id)
      assert.equal(env.pdf.diagnostics().documents, 1, 'all consumers share one lazily acquired native baseline')
    } finally { await env.dispose() }
  })

test('two discoverable form tools return real numbered native images and edit the same unsaved draft',
  { skip: !existsSync(executable) }, async () => {
    const env = await setup()
    try {
      const source = env.state.current().slice()
      const baselinePage = await env.pdf.renderPage(sessionId, env.opened.id, 1, 1024, signal)
      const inspect = env.tools.get('pdf_form_inspect')!, fill = env.tools.get('pdf_form_fill')!
      assert.ok(inspect); assert.ok(fill); assert.equal(env.tools.has('pdf_form_fields'), false)
      assert.deepEqual(Object.keys((inspect.parameters as { properties: Record<string, unknown> }).properties).sort(),
        ['documentId', 'includeValues', 'page'])
      const args = { documentId: env.opened.id, page: 1 }
      const result = await inspect.execute(args, { agent, signal }) as Result
      assert.ok(fill.description.includes(FORM_CONTROL_AVAILABILITY_GUIDANCE))
      for (const tool of [inspect, fill]) {
        assert.ok(tool.description.includes(FORM_CONTEXT_GUIDANCE), `${tool.name} must require contextual understanding before filling`)
      }
      assertCompactInspection(result)
      assert.deepEqual(result.fields.map(field => field.type), ['text', 'checkbox', 'radio', 'dropdown', 'option-list'])
      assert.deepEqual(result.fields.map(field => field.valueType), ['string', 'boolean', 'string', 'string', 'string[]'])
      assert.match(result.inspectionId, /^form-inspect_/)
      assert.equal(result.fields.reduce((count, field) => count + field.controls.length, 0), 6)
      assert.equal(result.readOnly, false)
      assert.equal(new Set(result.fields.map(field => field.sharedFieldKey)).size, 5)
      assert.deepEqual(result.fields[2].controls.map(control => control.option), ['email', 'phone'])
      const output = inspect.output.render(args, result)
      assert.deepEqual(output.map(item => item.type), ['text', 'image'])
      const renderedText = output[0].text!
      const metadata = JSON.parse(renderedText.slice(renderedText.indexOf('\n') + 1))
      const { image, ...expectedMetadata } = result
      assert.deepEqual(metadata, expectedMetadata)
      assert.doesNotMatch(renderedText, /Text1|Demo|fieldId|pdf-field:|rectPdf|rectImage|labelRect|valueContract/)
      assert.equal('image' in metadata, false)
      assert.equal('attachmentId' in metadata, false)
      assert.match(renderedText, /F01/)
      assert.equal(output[1].attachment!.attachmentId, result.image.attachmentId)
      assert.equal(output[1].attachment!.attachmentId, image.attachmentId)
      const png = env.images.get(result.image.attachmentId)!
      if (process.env.PDF_FORM_INSPECTION_SCREENSHOT) await writeFile(process.env.PDF_FORM_INSPECTION_SCREENSHOT, png)
      const data = Buffer.from(png), chunks: Buffer[] = []
      assert.equal(Math.max(data.readUInt32BE(16), data.readUInt32BE(20)), 2048)
      for (let offset = 8; offset + 12 <= data.length;) {
        const length = data.readUInt32BE(offset)
        if (data.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(data.subarray(offset + 8, offset + 8 + length))
        offset += length + 12
      }
      const raster = inflateSync(Buffer.concat(chunks)), width = data.readUInt32BE(16)
      const native = await env.pdf.renderFormPage(sessionId, env.opened.id, 1, 2048, false, signal)
      assert.deepEqual(native.png, png)
      for (const field of native.formInspection.fields) for (const control of field.controls) {
        const [left, top, right, bottom] = control.labelRect
        let blue = 0
        for (let y = Math.floor(top); y < Math.ceil(bottom); y++) for (let x = Math.floor(left); x < Math.ceil(right); x++) {
          const offset = y * (width * 4 + 1) + 1 + x * 4
          if (raster[offset + 2] > raster[offset] + 30) blue++
        }
        assert.ok(blue > 50, `${control.label} must be readable blue inside its widget`)
      }
      const changed = await fill.execute({ documentId: env.opened.id, expectedRevision: result.revision,
        inspectionId: result.inspectionId, fields: [{ label: result.fields[0].controls[0].label, value: '测试' }] }, { agent, signal }) as { revision: number; dirty: boolean;
          status: string }
      assert.equal(changed.dirty, true); assert.equal(env.state.writes(), 0)
      assert.equal(changed.status, 'updated')
      const current = await inspect.execute({ ...args, includeValues: true }, { agent, signal }) as Result
      assertCompactInspection(current, true)
      assert.equal(current.revision, changed.revision)
      assert.equal(current.fields[0].value, '测试')
      assert.deepEqual(env.images.get(current.image.attachmentId), png, 'Inspection omits both saved and unsaved widget values')
      assert.deepEqual(env.state.current(), source)
      assert.equal(env.state.writes(), 0)
      assert.equal(env.pdf.diagnostics().documents, 1, 'Inspection reuses the Reader baseline without private draft handles')
      assert.deepEqual((await env.pdf.renderPage(sessionId, env.opened.id, 1, 1024, signal)).png, baselinePage.png,
        'Draft inspection must not replace the live Reader baseline handle')
      const rotated = await inspect.execute({ ...args, page: 2 }, { agent, signal }) as Result
      assertCompactInspection(rotated)
      assert.equal(rotated.fields.length, 1); assert.equal(rotated.fields[0].controls.length, 1)
      assert.equal(rotated.fields[0].controls[0].label, 'F01', 'Labels are local to each page')
      assert.equal(rotated.fields[0].sharedFieldKey, result.fields[0].sharedFieldKey)
    } finally { await env.dispose() }
  })

test('form inspection rejects non-visual models, foreign sessions, invalid input and stale delivery',
  { skip: !existsSync(executable) }, async () => {
    const env = await setup()
    const inspect = env.tools.get('pdf_form_inspect')!
    const args = { documentId: env.opened.id, page: 1 }
    try {
      await assert.rejects(inspect.execute(args, { signal }), { code: 'pdf/session-required' })
      await assert.rejects(inspect.execute(args, { signal, agent: { ...agent, session: { id: 'foreign', header: {} } } }), /session|belong/i)
      env.setVisual(false)
      await assert.rejects(inspect.execute(args, { agent, signal }), { code: 'pdf/image-input-unsupported' })
      assert.equal(env.saves(), 0)
      env.setVisual(true)
      await assert.rejects(inspect.execute({ ...args, page: 0 }, { agent, signal }))
      for (const removed of [{ maxEdge: 1024 }, { purpose: 'verify' }, { understanding: 'auto' }]) {
        await assert.rejects(inspect.execute({ ...args, ...removed }, { agent, signal }))
      }
      env.beforeStore(async () => {
        const snapshot = env.state.workspaces.readSnapshot(sessionId, env.opened.id)
        await env.state.workspaces.execute(sessionId, { action: 'change', sessionId, id: snapshot.id, revision: snapshot.revision,
          operations: [{ type: 'set-field', name: 'accepted', value: true }] }, agent, signal)
      })
      await assert.rejects(inspect.execute(args, { agent, signal }), { code: 'pdf/stale-revision' })
      assert.equal(env.state.writes(), 0)
      env.beforeStore()
      const fill = env.tools.get('pdf_form_fill')!
      const conflict = await fill.execute({ documentId: env.opened.id, expectedRevision: env.opened.revision,
        inspectionId: 'form-inspect_00000000-0000-0000-0000-000000000000',
        fields: [{ label: 'F01', value: 'value' }] }, { agent, signal }) as { status: string; recovery: { action: string } }
      assert.equal(conflict.status, 'inspection_required'); assert.equal(conflict.recovery.action, 'inspect_again')
    } finally { await env.dispose() }
  })

test('parallel native inspections followed by queued single-page fills retain every independent page change',
  { skip: !existsSync(executable) }, async () => {
    const env = await setup(await formPageBatchesFixture())
    try {
      const inspect = env.tools.get('pdf_form_inspect')!, fill = env.tools.get('pdf_form_fill')!
      assert.deepEqual(Object.keys((fill.parameters as { properties: Record<string, unknown> }).properties).sort(),
        ['choiceGroups', 'conditions', 'documentId', 'expectedRevision', 'fields', 'inspectionId'])
      const inspected = await Promise.all([1, 2, 3].map(page => inspect.execute({ documentId: env.opened.id, page },
        { agent, signal }))) as Result[]
      assert.deepEqual(inspected.map(result => result.revision), [env.opened.revision, env.opened.revision, env.opened.revision])
      for (const result of inspected) {
        assertCompactInspection(result)
        assert.ok(env.images.has(result.image.attachmentId), 'Each tool inspection supplies a real image attachment')
      }
      const filled = await Promise.all(inspected.map((result, index) => fill.execute({ documentId: env.opened.id,
        expectedRevision: result.revision, inspectionId: result.inspectionId,
        fields: [{ label: result.fields[0].controls[0].label, value: `Batch ${index + 1}` }] }, { agent, signal }))) as Array<{
          status: string; page: number; inspectionId: string }>
      assert.deepEqual(filled.map(result => result.status), ['updated', 'updated', 'updated'])
      assert.deepEqual(filled.map(result => result.page), [1, 2, 3])
      assert.deepEqual(filled.map(result => result.inspectionId), inspected.map(result => result.inspectionId))
      const verified = await Promise.all([1, 2, 3].map(page => inspect.execute({ documentId: env.opened.id,
        page, includeValues: true }, { agent, signal }))) as Result[]
      assert.deepEqual(verified.map(result => result.fields[0].value), ['Batch 1', 'Batch 2', 'Batch 3'])
      assert.equal(env.state.writes(), 0)
    } finally { await env.dispose() }
  })

test('empty and selected dropdown inspection values round-trip directly through fill while internal drafts keep arrays',
  { skip: !existsSync(executable) }, async () => {
    const env = await setup()
    try {
      const inspect = env.tools.get('pdf_form_inspect')!, fill = env.tools.get('pdf_form_fill')!
      const args = { documentId: env.opened.id, page: 1, includeValues: true }
      const inspectCurrent = async () => {
        const result = await inspect.execute(args, { agent, signal }) as Result
        assertCompactInspection(result, true)
        const dropdown = result.fields.find(field => field.type === 'dropdown')!
        assert.equal(dropdown.valueType, 'string'); assert.equal(typeof dropdown.value, 'string')
        return { result, dropdown }
      }
      const submit = (result: Result, label: string, value: unknown) => fill.execute({ documentId: env.opened.id,
        expectedRevision: result.revision, inspectionId: result.inspectionId, fields: [{ label, value }] },
      { agent, signal }) as Promise<{ status: string; revision: number; appliedCount: number; code?: string }>
      const initial = await inspectCurrent(), label = initial.dropdown.controls[0].label
      assert.equal(initial.dropdown.value, '')
      assert.equal((await submit(initial.result, label, initial.dropdown.value)).status, 'no_changes')
      const selected = await submit(initial.result, label, 'second')
      assert.equal(selected.status, 'updated')
      const current = await inspectCurrent()
      assert.equal(current.dropdown.value, 'second')
      assert.equal((await submit(current.result, label, current.dropdown.value)).status, 'no_changes')
      assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
        .find(field => field.type === 'dropdown')!.value, ['second'])
      const hidden = await inspect.execute({ documentId: env.opened.id, page: 1 }, { agent, signal }) as Result
      assertCompactInspection(hidden)
      const text = inspect.output.render({}, hidden)[0].text!
      const metadata = JSON.parse(text.slice(text.indexOf('\n') + 1))
      assert.ok(metadata.fields.every((field: object) => !('value' in field)), 'Existing values require explicit opt-in')
      const stale = await submit(initial.result, label, 'first')
      assert.equal(stale.status, 'inspection_required'); assert.equal(stale.code, 'pdf/form-inspection-required'); assert.equal(stale.appliedCount, 0)
      const cleared = await submit(current.result, label, '')
      assert.equal(cleared.status, 'updated')
      const empty = await inspectCurrent()
      assert.equal(empty.dropdown.value, '')
      assert.equal((await submit(empty.result, label, empty.dropdown.value)).status, 'no_changes')
      assert.deepEqual(env.state.workspaces.readSnapshot(sessionId, env.opened.id).document.formFields!
        .find(field => field.type === 'dropdown')!.value, [])
      assert.equal(env.state.writes(), 0, 'Tool round-trips edit the shared draft without saving the source')
    } finally { await env.dispose() }
  })

test('dense inspection puts small IDs inside widgets, omits appearances and preserves surrounding printed ink',
  { skip: !existsSync(executable) }, async () => {
    const source = await denseFormFixture(), env = await setup(source)
    // Independent reference: physically remove widgets from a synthetic clone, not the tested document.
    const bare = await PDFDocument.load(source)
    bare.catalog.delete(PDFName.of('AcroForm'))
    bare.getPages().forEach(page => page.node.delete(PDFName.of('Annots')))
    const reference = await setup(await bare.save())
    function decode(png: Uint8Array) {
      const data = Buffer.from(png), chunks: Buffer[] = []
      for (let offset = 8; offset + 12 <= data.length;) {
        const length = data.readUInt32BE(offset)
        if (data.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(data.subarray(offset + 8, offset + 8 + length))
        offset += length + 12
      }
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), pixels: inflateSync(Buffer.concat(chunks)) }
    }
    try {
      const clean = decode((await reference.pdf.renderFormPage(sessionId, reference.opened.id, 1, 2048, false, signal)).png)
      const inspect = env.tools.get('pdf_form_inspect')!
      const result = await inspect.execute({ documentId: env.opened.id, page: 1 }, { agent, signal }) as Result
      const png = env.images.get(result.image.attachmentId)!, marked = decode(png)
      if (process.env.PDF_DENSE_FORM_SCREENSHOT) await writeFile(process.env.PDF_DENSE_FORM_SCREENSHOT, png)
      assertCompactInspection(result)
      const native = await env.pdf.renderFormPage(sessionId, env.opened.id, 1, 2048, false, signal)
      const [left, top, right, bottom] = native.formInspection.pageRect
      assert.equal(right - left, clean.width); assert.equal(bottom - top, clean.height)
      assert.equal(result.fields.reduce((count, field) => count + field.controls.length, 0), 42)
      assert.ok(marked.width <= 2048 && marked.height <= 2048)
      for (const marker of native.formInspection.fields.flatMap(field => field.controls)) {
        assert.ok(marker.labelRect[0] > marker.rectImage[0] && marker.labelRect[1] > marker.rectImage[1]
          && marker.labelRect[2] < marker.rectImage[2] && marker.labelRect[3] < marker.rectImage[3], `${marker.label} stays inside its control`)
      }
      let ink = 0, altered = 0
      for (let y = 0; y < clean.height; y++) for (let x = 0; x < clean.width; x++) {
        const source = y * (clean.width * 4 + 1) + 1 + x * 4
        const target = (top + y) * (marked.width * 4 + 1) + 1 + (left + x) * 4
        ink++
        if (clean.pixels.subarray(source, source + 4).equals(marked.pixels.subarray(target, target + 4))) continue
        const onLabel = native.formInspection.fields.some(field => field.controls.some(control => {
          const [l, t, r, b] = control.labelRect
          return x >= Math.floor(l) && x < Math.ceil(r) && y >= Math.floor(t) && y < Math.ceil(b)
        }))
        if (onLabel) continue
        altered++
      }
      assert.ok(ink > 10_000, 'the test includes dense real printed labels')
      assert.equal(altered, 0, 'outside the IDs, inspection is pixel-identical to a page without widgets')
      assert.equal(env.state.writes(), 0)
    } finally { await reference.dispose(); await env.dispose() }
  })

test('numbered form tools distinguish same-name fields and native appearances after save',
  { skip: !existsSync(executable) }, async () => {
    const env = await setup(await duplicateFieldNamesFixture())
    try {
      const inspect = env.tools.get('pdf_form_inspect')!, fill = env.tools.get('pdf_form_fill')!
      const args = { documentId: env.opened.id, page: 1 }
      const initial = await inspect.execute(args, { agent, signal }) as Result
      assertCompactInspection(initial)
      const readerBefore = await env.pdf.renderPage(sessionId, env.opened.id, 1, 1024, signal)
      const boxes = initial.fields.filter(field => field.type === 'checkbox')
      assert.equal(boxes.length, 3); assert.equal(new Set(boxes.map(field => field.controls[0].label)).size, 3)
      assert.equal(new Set(boxes.map(field => field.sharedFieldKey)).size, 3,
        'Independent same-name checkboxes must not be merged into a shared field or inferred single-choice group')
      const edited = await fill.execute({ documentId: env.opened.id, expectedRevision: initial.revision,
        inspectionId: initial.inspectionId, fields: [{ label: boxes[1].controls[0].label, value: true }] }, { agent, signal }) as { revision: number }
      await env.state.workspaces.execute(sessionId, { action: 'save', sessionId,
        id: env.opened.id, revision: edited.revision, options: {} }, agent, signal)
      const saved = await inspect.execute({ ...args, includeValues: true }, { agent, signal }) as Result
      assertCompactInspection(saved, true)
      assert.deepEqual(saved.fields.filter(field => field.type === 'checkbox').map(field => field.value), [false, true, false])
      const png = Buffer.from(env.images.get(saved.image.attachmentId)!)
      if (process.env.PDF_DUPLICATE_FORM_SCREENSHOT) await writeFile(process.env.PDF_DUPLICATE_FORM_SCREENSHOT, png)
      assert.deepEqual(png, env.images.get(initial.image.attachmentId), 'Saved checkmarks are hidden only in inspection')
      assert.notDeepEqual((await env.pdf.renderPage(sessionId, env.opened.id, 1, 1024, signal)).png, readerBefore.png,
        'Normal Reader rendering still displays the saved native checkbox appearance')
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
    get(name: string) { return name === 'attachments' ? { imageLimits: { mediaTypes: ['image/png'] }, async saveImage() {
      return { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 10, width: resize ? 500 : 512, height: 768 }
    } } : undefined } }
  registerPdfFormInspectionTool(ctx as never, { readSnapshot: state.workspaces.readSnapshot,
    async execute(owner, request, caller, abort) { return sourceChanged ? { version: 'external-change' }
      : state.workspaces.execute(owner, request, caller, abort) } },
  { async renderFormPage() { calls++; return { snapshot: opened, png: new Uint8Array(), width: 512, height: 768,
    formInspection: inspectFormPage(opened.document, 1, 768) } } }, async () => {}, () => {}, createFormInspectionRegistry())
  try {
    const inspect = tools.get('pdf_form_inspect')!, args = { documentId: opened.id, page: 1 }
    sourceChanged = true
    await assert.rejects(inspect.execute(args, { agent, signal }), { code: 'pdf/source-conflict' })
    assert.equal(calls, 0)
    sourceChanged = false; resize = true
    await assert.rejects(inspect.execute(args, { agent, signal }), { code: 'pdf/image-normalized' })
    const abort = new AbortController(); abort.abort()
    await assert.rejects(inspect.execute(args, { agent, signal: abort.signal }), /abort/i)
  } finally { await state.workspaces.dispose() }
})

test('read-only inspection preserves its reason and compact envelope without advertising writable controls', async () => {
  const state = memoryWorkspace(await acroformFixture())
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in opened)
  const snapshot = { ...opened, document: { ...opened.document, readOnly: true, readOnlyReason: 'Fixture is read-only' } }
  const tools = new Map<string, Tool>(), inspections = createFormInspectionRegistry()
  const formInspection = inspectFormPage(snapshot.document, 1)
  const ctx = { tools: { register(tool: Tool) { tools.set(tool.name, tool); return () => {} } },
    get() { return { imageLimits: { mediaTypes: ['image/png'] }, async saveImage() {
      return { attachmentId: 'read-only-image', mediaType: 'image/png', bytes: 0,
        width: formInspection.width, height: formInspection.height }
    } } } }
  registerPdfFormInspectionTool(ctx as never, { readSnapshot: () => snapshot,
    execute: (owner, input, caller, abort) => state.workspaces.execute(owner, input, caller, abort) },
  { async renderFormPage() { return { snapshot, png: new Uint8Array(), width: formInspection.width,
    height: formInspection.height, formInspection } } }, async () => {}, () => {}, inspections)
  try {
    const inspect = tools.get('pdf_form_inspect')!
    const result = await inspect.execute({ documentId: snapshot.id, page: 1 }, { agent, signal }) as Result
    assertCompactInspection(result)
    assert.equal(result.readOnly, true); assert.equal(result.readOnlyReason, snapshot.document.readOnlyReason)
    assert.deepEqual(result.fields, [])
    assert.match(inspect.description, /not save authorization/i)
    assert.equal(state.writes(), 0)
  } finally { inspections.dispose(); await state.workspaces.dispose() }
})
