import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NativeWorker } from '../src/engine/native-worker.ts'
import { NativeViewport } from '../src/client/native/viewport.ts'
import { applyPdfOperations, loadPdfDocument } from '../src/core/pdf-document.ts'
import { createPdfService } from '../src/host/pdf-service.ts'
import { registerPdfTransport } from '../src/host/transport.ts'
import { createPdfApi } from '../src/client/api.ts'
import { PDFDocument, PDFHexString, PDFName, rgb } from 'pdf-lib'
import { memoryWorkspace, nativeFixture } from './native-fixture.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native tests require a built helper')
const skip = !existsSync(executable), signal = new AbortController().signal

test('PDFium renders crop, intrinsic/additional rotation and UserUnit in the UI coordinate system', { skip }, async () => {
  const bytes = await nativeFixture(), metadata = await loadPdfDocument(bytes), worker = new NativeWorker(executable)
  try {
    await worker.request({ command: 'open', documentId: 'geometry' }, bytes)
    for (const geometry of metadata.pages) for (const extra of [0, 90, 180, 270]) {
      const viewport = new NativeViewport(geometry, 1, (geometry.rotation + extra) % 360)
      const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height)
      const result = await worker.request({ command: 'render', documentId: 'geometry', pageIndex: geometry.page - 1, rotation: extra,
        rasterWidth: width, rasterHeight: height, x: 0, y: 0, width, height, annotations: true })
      for (const [x, y, color] of [[80, 90, [255, 0, 0]], [210, 270, [0, 0, 255]]] as const) {
        const point = viewport.convertToViewportPoint(x, y), offset = (Math.floor(point[1]) * width + Math.floor(point[0])) * 4
        assert.deepEqual([...result.bytes.subarray(offset, offset + 3)], [...color], `page=${geometry.page} extra=${extra}`)
        assert.deepEqual(viewport.convertToPdfPoint(...point), [x, y])
      }
    }
  } finally { worker.dispose() }
})
test('guttered tiles agree with a whole-page render at all internal seams', { skip }, async () => {
  const bytes = await nativeFixture(), worker = new NativeWorker(executable)
  try {
    await worker.request({ command: 'open', documentId: 'seams' }, bytes)
    const base = { command: 'render', documentId: 'seams', pageIndex: 0, rotation: 0, rasterWidth: 750, rasterHeight: 960, annotations: true }
    const full = (await worker.request({ ...base, x: 0, y: 0, width: 750, height: 960 })).bytes
    let differences = 0, tested = 0
    for (let y = 0; y < 960; y += 256) for (let x = 0; x < 750; x += 256) {
      const width = Math.min(256, 750 - x), height = Math.min(256, 960 - y)
      const tile = (await worker.request({ ...base, x: x - 1, y: y - 1, width: width + 2, height: height + 2 })).bytes
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) for (let c = 0; c < 4; c++) {
        tested++; if (Math.abs(tile[((row + 1) * (width + 2) + col + 1) * 4 + c] - full[((row + y) * 750 + col + x) * 4 + c]) > 2) differences++
      }
    }
    assert.ok(differences / tested < 0.0005, `seam differing-byte ratio=${differences / tested}`)
  } finally { worker.dispose() }
})

test('PDFium gives existing and newly authored highlights the same color on white and gray paper', { skip }, async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage([440, 220])
  const color: [number, number, number] = [1, 0.38431, 0]
  const left = 20, right = 160, direct = 300, bottom = 100, width = 100, height = 40
  const quads = (x: number) => [
    x, bottom + height, x + 65, bottom + height, x, bottom, x + 65, bottom,
    x + 35, bottom + height, x + width, bottom + height, x + 35, bottom, x + width, bottom,
  ]
  // The two halves have the same white/gray paper, so the sampled pixels
  // distinguish annotation compositing from differences in page content.
  for (const x of [left, right, direct]) page.drawRectangle({ x, y: 120, width, height: 20, color: rgb(0.75, 0.75, 0.75) })

  // An external-reader appearance has three levels: color in a plain Form,
  // a transparency group wrapping it, and an outer Form applying .4 alpha
  // plus Multiply. It deliberately does not use the writer under test.
  const oldInk = pdf.context.register(pdf.context.flateStream(
    `${color.join(' ')} rg 0 0 65 ${height} re f 35 0 65 ${height} re f`, {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, width, height],
    },
  ))
  const oldGroup = pdf.context.register(pdf.context.flateStream('/Ink Do', {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, width, height],
    Group: pdf.context.obj({ S: 'Transparency' }),
    Resources: pdf.context.obj({ XObject: { Ink: oldInk } }),
  }))
  const oldAppearance = pdf.context.register(pdf.context.flateStream('/R0 gs /R1 gs /Group Do', {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, width, height],
    Resources: pdf.context.obj({
      ExtGState: {
        R0: { Type: 'ExtGState', ca: 0.4, CA: 0.4 },
        R1: { Type: 'ExtGState', BM: 'Multiply' },
      },
      XObject: { Group: oldGroup },
    }),
  }))
  const oldAnnotation = pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Highlight', P: page.ref, F: 4,
    Rect: [left, bottom, left + width, bottom + height],
    QuadPoints: quads(left),
    C: color, CA: 0.4, AP: { N: oldAppearance },
  }))
  // Negative control: the previous writer's direct, per-quad alpha paints
  // overlapping quads twice. It must visibly differ at the overlap pixel.
  const directAppearance = pdf.context.register(pdf.context.flateStream(
    `q /GS0 gs ${color.join(' ')} rg 0 0 65 ${height} re f 35 0 65 ${height} re f Q`, {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, width, height],
      Resources: pdf.context.obj({ ExtGState: { GS0: { Type: 'ExtGState', ca: 0.4, CA: 0.4, BM: 'Multiply' } } }),
    },
  ))
  const directAnnotation = pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Highlight', P: page.ref, F: 4,
    Rect: [direct, bottom, direct + width, bottom + height], QuadPoints: quads(direct),
    C: color, AP: { N: directAppearance },
  }))
  page.node.set(PDFName.of('Annots'), pdf.context.obj([oldAnnotation, directAnnotation]))
  const source = await pdf.save({ useObjectStreams: false })
  const authored = await applyPdfOperations(source, [{
    type: 'add', annotation: {
      id: 'new-matching-highlight', page: 1, subtype: 'Highlight',
      rect: [right, bottom, right + width, bottom + height],
      quadPoints: quads(right),
      color,
    },
  }])
  const worker = new NativeWorker(executable)
  const sample = (pixels: Uint8Array, x: number, pdfY: number): number[] => {
    const rasterX = x * 2, rasterY = (220 - pdfY) * 2
    return [...pixels.subarray((rasterY * 880 + rasterX) * 4, (rasterY * 880 + rasterX) * 4 + 3)]
  }
  try {
    await worker.request({ command: 'open', documentId: 'highlight-compositing' }, authored.bytes)
    const base = { command: 'render', documentId: 'highlight-compositing', pageIndex: 0,
      rotation: 0, rasterWidth: 880, rasterHeight: 440, x: 0, y: 0, width: 880, height: 440 }
    const plain = (await worker.request({ ...base, annotations: false })).bytes
    const painted = (await worker.request({ ...base, annotations: true })).bytes
    for (const pdfY of [110, 130]) {
      const singleOld = sample(painted, left + 20, pdfY)
      const overlapOld = sample(painted, left + 50, pdfY)
      for (const x of [20, 50, 80]) {
        const paper = sample(plain, left + x, pdfY)
        const oldColor = sample(painted, left + x, pdfY)
        const newColor = sample(painted, right + x, pdfY)
        assert.deepEqual(sample(plain, right + x, pdfY), paper, `Unequal paper at x=${x} y=${pdfY}`)
        assert.ok(oldColor.some((channel, index) => Math.abs(channel - paper[index]) > 15),
          `Fixture's legacy appearance did not render at x=${x} y=${pdfY}: ${oldColor}`)
        for (let channel = 0; channel < 3; channel++) {
          assert.ok(Math.abs(oldColor[channel] - newColor[channel]) <= 4,
            `Different ${['red', 'green', 'blue'][channel]} at x=${x} y=${pdfY}: old=${oldColor}, new=${newColor}`)
        }
      }
      assert.ok(overlapOld.every((channel, index) => Math.abs(channel - singleOld[index]) <= 4),
        `Legacy fixture darkens overlapping quads at y=${pdfY}: single=${singleOld}, overlap=${overlapOld}`)
      const directSingle = sample(painted, direct + 20, pdfY)
      const directOverlap = sample(painted, direct + 50, pdfY)
      assert.ok(directOverlap.some((channel, index) => Math.abs(channel - directSingle[index]) > 8),
        `Pre-fix appearance unexpectedly hides its double alpha at y=${pdfY}: single=${directSingle}, overlap=${directOverlap}`)
    }
  } finally { worker.dispose() }
})
test('PDFium exposes searchable text, URI/internal destinations and bounded object inspection', { skip }, async () => {
  const worker = new NativeWorker(executable)
  try {
    await worker.request({ command: 'open', documentId: 'content' }, await nativeFixture())
    const text = (await worker.request({ command: 'text', documentId: 'content', pageIndex: 0 })).value as { items: { str: string; transform: number[] }[] }
    assert.equal(text.items.map(run => run.str).join(''), 'Native PDF test page 1')
    assert.ok(Math.abs(text.items[0].transform[4] - 42) < 0.01); assert.ok(Math.abs(text.items[0].transform[5] - 330) < 0.01)
    const links = (await worker.request({ command: 'links', documentId: 'content', pageIndex: 0 })).value as { url: string }[]
    assert.equal(links[0].url, 'https://example.com/native')
    assert.deepEqual((await worker.request({ command: 'destination', documentId: 'content', name: 'chapter' })).value, [2, { name: 'XYZ' }, 50, 300, null])
    const objects = (await worker.request({ command: 'inspect', documentId: 'content', pageIndex: 0, offset: 0, limit: 1 })).value as { objects: unknown[]; nextOffset: unknown }
    assert.equal(objects.objects.length, 1); assert.equal(objects.nextOffset, 1)
  } finally { worker.dispose() }
})

test('native dispatcher rejects an unknown command without stopping the worker', { skip }, async () => {
  const worker = new NativeWorker(executable)
  try {
    await assert.rejects(worker.request({ command: 'unknown' }), /Unknown native command/)
    assert.deepEqual((await worker.request({ command: 'hello' })).value,
      { protocolVersion: 1, engine: 'pdfium', build: '156.0.8076.0' })
  } finally { worker.dispose() }
})

test('native render rejects invalid flags and leaves blank pixels white', { skip }, async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([32, 32])
  const worker = new NativeWorker(executable)
  try {
    await worker.request({ command: 'open', documentId: 'blank' }, await pdf.save())
    const tile = { command: 'render', documentId: 'blank', pageIndex: 0, rotation: 0,
      rasterWidth: 32, rasterHeight: 32, x: 0, y: 0, width: 32, height: 32 }
    await assert.rejects(worker.request({ ...tile, annotations: 'yes' }), { code: 'pdf/native-request' })
    const { bytes } = await worker.request({ ...tile, annotations: false })
    assert.equal(bytes.length, 32 * 32 * 4)
    assert.ok(bytes.every(channel => channel === 255))
  } finally { worker.dispose() }
})

test('oversized native replies return an explicit error without stopping the worker', { skip }, async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage([32, 32])
  const root = pdf.context.obj({ Type: 'Outlines', Count: 110 })
  const rootRef = pdf.context.register(root)
  let previous: typeof root | undefined
  let previousRef: typeof rootRef | undefined
  for (let index = 0; index < 110; index++) {
    const bookmark = pdf.context.obj({ Title: PDFHexString.fromText('汉'.repeat(7000)), Parent: rootRef,
      Dest: [page.ref, PDFName.of('Fit')] })
    const bookmarkRef = pdf.context.register(bookmark)
    if (previous && previousRef) { previous.set(PDFName.of('Next'), bookmarkRef); bookmark.set(PDFName.of('Prev'), previousRef) }
    else root.set(PDFName.of('First'), bookmarkRef)
    previous = bookmark; previousRef = bookmarkRef
  }
  root.set(PDFName.of('Last'), previousRef!)
  pdf.catalog.set(PDFName.of('Outlines'), rootRef)
  const worker = new NativeWorker(executable)
  try {
    await worker.request({ command: 'open', documentId: 'large-outline' }, await pdf.save({ useObjectStreams: false }))
    await assert.rejects(worker.request({ command: 'outline', documentId: 'large-outline' }),
      { code: 'pdf/native-reply-too-large' })
    assert.deepEqual((await worker.request({ command: 'hello' })).value,
      { protocolVersion: 1, engine: 'pdfium', build: '156.0.8076.0' })
  } finally { worker.dispose() }
})

test('PDFium reads a nested Unicode outline with a working page destination', { skip }, async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400])
  const target = pdf.addPage([300, 400])
  const root = pdf.context.obj({ Type: 'Outlines', Count: 2 })
  const rootRef = pdf.context.register(root)
  const chapter = pdf.context.obj({ Title: PDFHexString.fromText('Chapter 1'), Parent: rootRef, Count: 1,
    Dest: [target.ref, PDFName.of('Fit')] })
  const chapterRef = pdf.context.register(chapter)
  const section = pdf.context.obj({ Title: PDFHexString.fromText('第二节'), Parent: chapterRef,
    Dest: [target.ref, PDFName.of('Fit')] })
  const sectionRef = pdf.context.register(section)
  chapter.set(PDFName.of('First'), sectionRef); chapter.set(PDFName.of('Last'), sectionRef)
  root.set(PDFName.of('First'), chapterRef); root.set(PDFName.of('Last'), chapterRef)
  pdf.catalog.set(PDFName.of('Outlines'), rootRef)
  const worker = new NativeWorker(executable)
  try {
    await worker.request({ command: 'open', documentId: 'outline' }, await pdf.save({ useObjectStreams: false }))
    assert.deepEqual((await worker.request({ command: 'outline', documentId: 'outline' })).value, [{
      title: 'Chapter 1', dest: [1, { name: 'Fit' }], items: [
        { title: '第二节', dest: [1, { name: 'Fit' }], items: [] },
      ],
    }])
  } finally { worker.dispose() }
})

/** Decode the public Connection contract, including native PNG tile attachments. */
async function decode(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const form = await response.formData(), envelope = JSON.parse(String(form.get('metadata')))
    assert.deepEqual(envelope.attachments, [{ codec: 'bytes', part: 'pdf-bytes', path: ['bytes'] }])
    const binary = form.get('pdf-bytes'); assert.ok(binary instanceof Blob)
    envelope.result.value.bytes = new Uint8Array(await binary.arrayBuffer())
    return envelope.result
  }
  return (await response.json()).result
}
test('authenticated v2 UI supports delta edits, undo/redo, atomic save/reopen and raw PNG attachments', { skip }, async () => {
  const state = memoryWorkspace(await nativeFixture()), service = createPdfService(state.workspaces, { executable })
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const context: Parameters<typeof registerPdfTransport>[0] = {
    connection: { fetch: { register(route) { routes.set(route.path, route.fetch); return async () => { routes.delete(route.path) } } } },
    sessionController: { async resolveAgent(sessionId) { return sessionId === 'native-test' ? { agent: { session: { id: sessionId, header: {} } } } : { error: new Error('Unknown session') } } },
  }
  registerPdfTransport(context, service.dispatch, { endpoint: 'pdf.dispatch.v2' }); registerPdfTransport(context, service.native, { endpoint: 'pdf.native' })
  const clientLifetime = new AbortController()
  const calls: { payload: any; value: any }[] = []
  const call = async (method: string, payload: object) => {
    const result: any = await decode(await routes.get(`/api/${method}`)!(new Request(`http://host/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    })))
    calls.push({ payload, value: result.value }); return result
  }
  const api = createPdfApi({ rpc: { call: (_path, method, payload) => call(method, payload) } }, clientLifetime.signal)
  try {
    const opened = await api.open('native-test', 'dsh-resource://file/session/native-test//fixtures/native.pdf')
    assert.equal(opened.reader.protocolVersion, 1); assert.equal('bytes' in opened, false)
    assert.equal(opened.document.annotations.find(a => a.linkAction)?.linkAction, 'NextPage')
    const changed = await api.change('native-test', opened.id, opened.revision, [{ type: 'add', annotation: { id: 'v1-note', page: 1, subtype: 'Text', rect: [80, 80, 100, 100], contents: 'Native note' } }])
    assert.equal(changed.dirty, true); assert.ok(changed.document.annotations.some(a => a.id === 'v1-note'))
    assert.equal(calls.at(-1)!.value.document, undefined); assert.equal(calls.at(-1)!.value.annotationDelta.upsert.length, 1)
    const retry = calls.at(-1)!.payload
    const generation = service.diagnostics().generation, pid = service.diagnostics().workerPid
    assert.ok(pid)
    process.kill(pid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 20))
    const recoveredText = await api.native.text('native-test', changed.id, changed.reader, 1)
    assert.equal(recoveredText.items.map(item => item.str).join(''), 'Native PDF test page 1')
    assert.equal(service.diagnostics().generation, generation + 1)
    assert.equal(state.workspaces.readSnapshot('native-test', changed.id).dirty, true)
    assert.equal((await call('pdf.dispatch.v2', retry) as any).value.revision, changed.revision)
    const undone = await api.undo('native-test', changed.id, changed.revision); assert.ok(!undone.document.annotations.some(a => a.id === 'v1-note'))
    const redone = await api.redo('native-test', changed.id, undone.revision); assert.ok(redone.document.annotations.some(a => a.id === 'v1-note'))
    const saved = await api.save('native-test', changed.id, redone.revision, {})
    assert.equal(saved.dirty, false); assert.equal(state.writes(), 1); assert.notEqual(saved.reader.bytesHash, opened.reader.bytesHash)
    assert.ok((await loadPdfDocument(state.current())).annotations.some(a => a.id === 'v1-note'))
    const tile = await api.native.tile('native-test', saved.id, saved.reader, { page: 1, rotation: 0, rasterWidth: 250, rasterHeight: 320, x: 0, y: 0, width: 250, height: 320, annotations: true })
    assert.equal(tile.mime, 'image/png'); assert.deepEqual([...tile.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    await assert.rejects(api.native.tile('native-test', saved.id, opened.reader, { page: 1, rotation: 0, rasterWidth: 250, rasterHeight: 320, x: 0, y: 0, width: 250, height: 320, annotations: true }), { code: 'pdf/stale-reader' })
    const attacker = { session: { id: 'another-session', header: {} } }
    await assert.rejects(service.native('another-session', { action: 'text', sessionId: 'another-session', id: saved.id, bytesHash: saved.reader.bytesHash, page: 1 }, attacker, signal), { code: 'pdf/session-mismatch' })
    assert.ok(service.diagnostics().tileCacheBytes <= 32 * 1024 * 1024)
  } finally { clientLifetime.abort(); service.dispose(); await state.workspaces.dispose() }
})
test('opening fails explicitly when the native helper is absent', async () => {
  const state = memoryWorkspace(await nativeFixture()), service = createPdfService(state.workspaces, { executable: '/missing/helper' })
  try {
    await assert.rejects(service.dispatch('missing-helper', { action: 'open', sessionId: 'missing-helper', address: 'dsh-resource://file/session/missing-helper//fixtures/native.pdf' }, { session: { id: 'missing-helper', header: {} } }, signal), { code: 'pdf/native-unavailable' })
  } finally { service.dispose(); await state.workspaces.dispose() }
})
test('PDF forms fail explicitly rather than showing an incomplete native appearance', { skip }, async () => {
  const document = await PDFDocument.create(), page = document.addPage([300, 400])
  document.getForm().createTextField('field').addToPage(page, { x: 30, y: 100, width: 150, height: 30 })
  const state = memoryWorkspace(await document.save()), service = createPdfService(state.workspaces, { executable })
  try {
    await assert.rejects(service.dispatch('forms', { action: 'open', sessionId: 'forms', address: 'dsh-resource://file/session/forms//fixtures/native.pdf' }, { session: { id: 'forms', header: {} } }, signal), { code: 'pdf/native-unsupported' })
    assert.equal(service.diagnostics().documents, 0)
  } finally { service.dispose(); await state.workspaces.dispose() }
})
