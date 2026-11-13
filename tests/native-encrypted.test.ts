import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { blankPdf } from './fixtures/plain-pdf.ts'
import { NativeWorker } from '../src/engine/host/native-worker.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(executable)) throw new Error('Native tests require a built helper')
const skip = !existsSync(executable)
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}.pdf`, import.meta.url))

test('native document info reports the encrypted page scale when PDFium exposes it', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    const { value: hello } = await worker.request({ command: 'hello' })
    assert.partialDeepStrictEqual(hello,
      { protocolVersion: 2, engine: 'pdfium', build: '156.0.8076.0', encryptedOpen: true, encryptedAnnotationEdit: true,
        selectionGeometry: true })
    const opened = (await worker.request({ command: 'open', documentId: 'empty-password' },
      await fixture('encrypted-object-stream'))).value
    assert.deepEqual(opened, { pageCount: 2, formType: 0, signatureCount: 0,
      ...(hello.documentExtensions ? { signatureStatus: 0 } : {}) })
    const security = (await worker.request({ command: 'security', documentId: 'empty-password' })).value as {
      securityRevision: number; permissions: number; userPermissions: number
    }
    const info = (await worker.request({ command: 'documentInfo', documentId: 'empty-password' })).value as {
      securityRevision: number; permissions: number; title?: string; pages: Array<{
        page: number; mediaBox: number[]; cropBox: number[]; rotation: number; userUnit: number | null
        renderedWidth: number; renderedHeight: number
      }>
    }
    assert.ok(info.securityRevision >= 0)
    assert.ok(Number.isSafeInteger(info.permissions))
    assert.deepEqual(security, { securityRevision: info.securityRevision, permissions: info.permissions,
      userPermissions: info.permissions })
    assert.equal(info.title, 'Encrypted compatibility fixture')
    assert.deepEqual(info.pages, [
      { page: 1, mediaBox: [0, 0, 400, 600], cropBox: [20, 30, 340, 530], rotation: 90,
        visibleBox: [20, 30, 340, 530], boxSource: 'page-dictionary',
        renderedWidth: 500, renderedHeight: 320, userUnit: hello.documentExtensions ? 2 : null },
      { page: 2, mediaBox: [0, 0, 300, 500], cropBox: [0, 0, 300, 500], rotation: 0,
        visibleBox: [0, 0, 300, 500], boxSource: hello.documentExtensions ? 'page-dictionary' : 'effective-bounds',
        renderedWidth: 300, renderedHeight: 500, userUnit: hello.documentExtensions ? 1 : null },
    ])
    const secondPage = (await worker.request({ command: 'documentInfo', documentId: 'empty-password',
      offset: 1, limit: 1 })).value as { pages: unknown[] }
    assert.deepEqual(secondPage.pages, [info.pages[1]], 'paged documentInfo retains original page numbers')
    await worker.request({ command: 'close', documentId: 'empty-password' })
    await assert.rejects(worker.request({ command: 'documentInfo', documentId: 'empty-password' }),
      { code: 'pdf/native-document' })
  } finally { await worker.dispose() }
})

test('native document info reads inherited encrypted geometry and its effective bounds', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    const bytes = await fixture('encrypted-inherited-boxes')
    await worker.request({ command: 'open', documentId: 'inherited', password: 'fixture-password' }, bytes)
    const info = (await worker.request({ command: 'documentInfo', documentId: 'inherited' })).value as {
      title: string; pages: unknown[]
    }
    assert.equal(info.title, 'Inherited 😀 geometry')
    assert.deepEqual(info.pages, [{
      page: 1, mediaBox: worker.documentExtensions ? [0, 0, 400, 600] : [20, 30, 340, 530],
      cropBox: [20, 30, 340, 530], visibleBox: [20, 30, 340, 530],
      boxSource: worker.documentExtensions ? 'page-dictionary' : 'effective-bounds', rotation: 90,
      renderedWidth: 500, renderedHeight: 320, userUnit: worker.documentExtensions ? 2 : null,
    }])
    assert.deepEqual((await worker.request({ command: 'documentInfo', documentId: 'inherited', offset: 1,
      limit: 1 })).value, { ...info, pages: [] })
    for (const invalid of [{ offset: -1 }, { limit: 0 }, { offset: 2 }, { limit: 2049 }]) {
      await assert.rejects(worker.request({ command: 'documentInfo', documentId: 'inherited', ...invalid }),
        { code: 'pdf/native-request' })
    }
  } finally { await worker.dispose() }
})

test('native security probe distinguishes a plain PDF without enumerating pages', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'plain' }, blankPdf(1, [200, 300]))
    assert.deepEqual((await worker.request({ command: 'security', documentId: 'plain' })).value,
      { securityRevision: -1, permissions: 0xffffffff, userPermissions: 0xffffffff })
    const annotations = { command: 'annotations', documentId: 'plain', pageIndex: 0, offset: 0, limit: 64 } as const
    if (worker.documentExtensions) {
      assert.deepEqual((await worker.request(annotations)).value, { annotations: [], nextOffset: null })
      assert.ok((await worker.request({ command: 'saveCopy', documentId: 'plain' })).value.size > 0)
    } else {
      await assert.rejects(worker.request({ command: 'saveCopy', documentId: 'plain' }), { code: 'pdf/annotation-permission' })
      await assert.rejects(worker.request(annotations), { code: 'pdf/native-request' })
    }
  } finally { await worker.dispose() }
})

async function protectedPageAnnotations(worker: NativeWorker, documentId: string, pageIndex: number, offset = 0, limit = 64) {
  return (await worker.request({ command: 'annotations', documentId, pageIndex, offset, limit })).value as {
    annotations: Array<{ index: number; id?: string; subtype: string; contents?: string; author?: string;
      color?: number[]; rect: number[]; quadPoints?: number[]; opacity?: number; editable: boolean }>
    nextOffset: number | null
  }
}

async function encryptedCopyBytes(worker: NativeWorker, documentId: string) {
  const { size } = (await worker.request({ command: 'saveCopy', documentId })).value as { size: number }
  assert.ok(size > 0)
  const split = Math.ceil(size / 2)
  const first = await worker.request({ command: 'saveChunk', documentId, offset: 0, length: split })
  const second = await worker.request({ command: 'saveChunk', documentId, offset: split, length: size - split })
  assert.deepEqual(first.value, { offset: 0, size })
  assert.deepEqual(second.value, { offset: split, size })
  assert.equal(first.bytes.length, split)
  assert.equal(second.bytes.length, size - split)
  await assert.rejects(worker.request({ command: 'saveChunk', documentId, offset: size, length: 1 }),
    { code: 'pdf/native-request' })
  return Buffer.concat([first.bytes, second.bytes])
}

test('native protected annotations can be changed, rendered and exported without dropping passwords or raw permissions', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  const bytes = await fixture('password-object-stream')
  const credentials = { password: 'fixture-password' }
  const note = { id: 'saved-note', subtype: 'Text', rect: [30, 60, 50, 80], color: [1, 0.85, 0],
    contents: '便签 😀', author: 'DSH', createdAt: 'D:20261109120000Z', modifiedAt: 'D:20261109120000Z' }
  const highlight = { id: 'saved-highlight', subtype: 'Highlight', rect: [60, 100, 140, 120], color: [1, 1, 0],
    quadPoints: [60, 120, 140, 120, 60, 100, 140, 100], opacity: 0.4 }
  try {
    await worker.request({ command: 'open', documentId: 'source', ...credentials }, bytes)
    const security = (await worker.request({ command: 'security', documentId: 'source' })).value
    const first = await protectedPageAnnotations(worker, 'source', 0)
    assert.deepEqual(first.annotations.map(item => [item.subtype, item.contents, item.editable]),
      [['Highlight', 'Fixture annotation', true]])
    await assert.rejects(worker.request({ command: 'saveChunk', documentId: 'source', offset: 0, length: 1 }),
      { code: 'pdf/native-request' })

    await worker.request({ command: 'annotationEdit', documentId: 'source', action: 'update',
      pageIndex: 0, annotationIndex: 0, patch: { contents: 'Updated imported annotation' } })
    for (const annotation of [note, highlight]) {
      await worker.request({ command: 'annotationEdit', documentId: 'source', action: 'add', pageIndex: 1, annotation })
    }
    const page = await protectedPageAnnotations(worker, 'source', 1, 0, 1)
    assert.equal(page.nextOffset, 1)
    assert.equal(page.annotations[0].id, note.id)
    assert.equal((await protectedPageAnnotations(worker, 'source', 1, page.nextOffset!)).nextOffset, null)
    await assert.rejects(worker.request({ command: 'saveCopy', documentId: 'source', maxBytes: 128 }),
      { code: 'pdf/native-size' })
    await assert.rejects(worker.request({ command: 'saveChunk', documentId: 'source', offset: 0, length: 1 }),
      { code: 'pdf/native-request' })
    const saved = await encryptedCopyBytes(worker, 'source')
    assert.notDeepEqual(saved, bytes)
    assert.equal(saved.includes(Buffer.from(note.contents, 'utf16le')), false)
    await assert.rejects(worker.request({ command: 'open', documentId: 'saved' }, saved), { code: 'pdf/password-required' })
    await assert.rejects(worker.request({ command: 'open', documentId: 'saved', password: 'wrong' }, saved),
      { code: 'pdf/password-incorrect' })
    await worker.request({ command: 'open', documentId: 'saved', ...credentials }, saved)
    await worker.request({ command: 'open', documentId: 'owner', password: 'fixture-owner' }, saved)
    assert.deepEqual((await worker.request({ command: 'security', documentId: 'saved' })).value, security)
    assert.equal((await protectedPageAnnotations(worker, 'saved', 0)).annotations[0].contents, 'Updated imported annotation')
    const [savedNote, savedHighlight] = (await protectedPageAnnotations(worker, 'saved', 1)).annotations
    assert.equal(savedNote.id, note.id)
    assert.equal(savedNote.contents, note.contents)
    assert.equal(savedNote.author, note.author)
    assert.deepEqual(savedNote.rect, note.rect)
    assert.equal(savedNote.editable, true)
    assert.equal(savedHighlight.id, highlight.id)
    assert.deepEqual(savedHighlight.quadPoints, highlight.quadPoints)
    assert.ok(Math.abs(savedHighlight.opacity! - 0.4) <= 1 / 255)
    assert.equal(savedHighlight.editable, true)

    // Reopen separately from the editable handle. PDFium can generate a
    // transient appearance as a side effect of rendering.
    const render = { command: 'render' as const, documentId: 'owner', pageIndex: 1, rotation: 0,
      rasterWidth: 300, rasterHeight: 500, x: 0, y: 0, width: 300, height: 500 }
    const clean = (await worker.request({ ...render, annotations: false })).bytes
    const marked = (await worker.request({ ...render, annotations: true })).bytes
    for (const { rect } of [note, highlight]) {
      const [left, bottom, right, top] = rect
      let differs = false
      for (let x = left; x < right; x++) for (let y = bottom; y < top; y++) {
        const offset = (300 * (499 - y) + x) * 4
        if (!marked.subarray(offset, offset + 4).equals(clean.subarray(offset, offset + 4))) differs = true
      }
      assert.ok(differs, `exported annotation renders inside ${rect.join(',')}`)
    }

    await worker.request({ command: 'annotationEdit', documentId: 'saved', action: 'update', pageIndex: 1,
      annotationIndex: savedNote.index, patch: { rect: [50, 60, 70, 80], color: [0, 1, 0], contents: 'Moved note' } })
    await worker.request({ command: 'annotationEdit', documentId: 'saved', action: 'delete',
      pageIndex: 1, annotationIndex: savedHighlight.index })
    const changed = (await protectedPageAnnotations(worker, 'saved', 1)).annotations
    assert.deepEqual(changed.map(item => [item.id, item.rect, item.color, item.contents]),
      [[note.id, [50, 60, 70, 80], [0, 1, 0], 'Moved note']])
  } finally { await worker.dispose() }
})

test('native protected edits keep existing note threads and malformed markup intact', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  const documentId = 'annotation-edges'
  try {
    await worker.request({ command: 'open', documentId }, await fixture('encrypted-annotation-edges'))
    const described = (await protectedPageAnnotations(worker, documentId, 0)).annotations
    assert.deepEqual(described.map(item => [item.contents, item.editable]),
      [['Thread root', false], ['Thread reply', false], ['Missing quadrilateral', false]])
    assert.equal(described[2].quadPoints, undefined)
    for (const { index } of described) {
      await assert.rejects(worker.request({ command: 'annotationEdit', documentId, action: 'delete',
        pageIndex: 0, annotationIndex: index }), { code: 'pdf/annotation-read-only' })
    }
    // Quad validation fails after PDFium allocates an annotation dictionary.
    // Its transient array entry must still be rolled back.
    await assert.rejects(worker.request({ command: 'annotationEdit', documentId, action: 'add', pageIndex: 0,
      annotation: { id: 'invalid', subtype: 'Highlight', rect: [60, 100, 140, 120],
        quadPoints: [60, 120, 140, 120, 60, 121, 140, 100] } }), { code: 'pdf/native-request' })
    assert.deepEqual((await protectedPageAnnotations(worker, documentId, 0)).annotations, described)
  } finally { await worker.dispose() }
})

test('native protected annotation metadata pages within its protocol byte budget', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  const documentId = 'large-protected-annotations'
  try {
    await worker.request({ command: 'open', documentId }, await fixture('encrypted-object-stream'))
    const contents = 'z'.repeat(100_000)
    for (let index = 0; index < 22; index++) {
      await worker.request({ command: 'annotationEdit', documentId, action: 'add', pageIndex: 1,
        annotation: { id: `large-${index}`, subtype: 'Text', rect: [30, 60, 50, 80], contents } })
    }
    const first = await protectedPageAnnotations(worker, documentId, 1)
    assert.ok(first.nextOffset !== null && first.nextOffset < 22)
    assert.equal(first.annotations.length, first.nextOffset)
    const second = await protectedPageAnnotations(worker, documentId, 1, first.nextOffset)
    assert.equal(second.nextOffset, null)
    assert.equal(first.annotations.length + second.annotations.length, 22)
    assert.equal(second.annotations.at(-1)?.contents, contents)
  } finally { await worker.dispose() }
})

test('native protected annotation mutation and save require effective permission, and owner export preserves user restrictions', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  const bytes = await fixture('encrypted-annotation-restricted')
  const add = { command: 'annotationEdit' as const, action: 'add' as const, pageIndex: 1,
    annotation: { id: 'owner-note', subtype: 'Text', rect: [30, 60, 50, 80], contents: 'Owner note' } }
  try {
    await worker.request({ command: 'open', documentId: 'reader' }, bytes)
    const security = (await worker.request({ command: 'security', documentId: 'reader' })).value as {
      securityRevision: number; permissions: number; userPermissions: number
    }
    assert.equal(security.permissions & 0x20, 0)
    assert.equal((await protectedPageAnnotations(worker, 'reader', 0)).annotations[0].editable, false)
    await assert.rejects(worker.request({ ...add, documentId: 'reader' }), { code: 'pdf/annotation-permission' })
    await assert.rejects(worker.request({ command: 'saveCopy', documentId: 'reader' }), { code: 'pdf/annotation-permission' })
    await worker.request({ command: 'open', documentId: 'owner', password: 'fixture-owner' }, bytes)
    const owner = (await worker.request({ command: 'security', documentId: 'owner' })).value as typeof security
    assert.equal(owner.permissions & 0x20, 0x20)
    assert.equal(owner.userPermissions, security.userPermissions)
    await worker.request({ ...add, documentId: 'owner' })
    const saved = await encryptedCopyBytes(worker, 'owner')
    await worker.request({ command: 'open', documentId: 'saved' }, saved)
    assert.deepEqual((await worker.request({ command: 'security', documentId: 'saved' })).value, security)
    assert.equal((await protectedPageAnnotations(worker, 'saved', 1)).annotations[0].contents, 'Owner note')
  } finally { await worker.dispose() }
})

test('native password errors are fixed, retries leave no ghost handle, and valid credentials unlock', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  const bytes = await fixture('password-object-stream')
  try {
    await assert.rejects(worker.request({ command: 'open', documentId: 'protected' }, bytes),
      { code: 'pdf/password-required' })
    await assert.rejects(worker.request({ command: 'open', documentId: 'protected', password: 'wrong' }, bytes),
      { code: 'pdf/password-incorrect' })
    assert.deepEqual((await worker.request({ command: 'open', documentId: 'protected', password: 'fixture-password' }, bytes)).value,
      { pageCount: 2, formType: 0, signatureCount: 0, ...(worker.documentExtensions ? { signatureStatus: 0 } : {}) })
    const info = (await worker.request({ command: 'documentInfo', documentId: 'protected' })).value as { securityRevision: number }
    assert.ok(info.securityRevision >= 0)
  } finally { await worker.dispose() }
})

test('native password validation and unsupported security fail without exposing credential text', { skip }, async () => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  const bytes = await fixture('password-object-stream')
  try {
    for (const password of [42, 'x'.repeat(4097), 'before\0after']) {
      // @ts-expect-error Intentionally send invalid IPC to exercise native validation.
      await assert.rejects(worker.request({ command: 'open', documentId: 'invalid-password', password }, bytes), error => {
        assert.equal((error as { code: string }).code, 'pdf/native-request')
        assert.ok(!String(error).includes(String(password)))
        return true
      })
    }
    const original = bytes.toString('latin1')
    const unsupported = original.replace('/Filter /Standard', '/Filter /Stundard')
    assert.notEqual(unsupported, original, 'the synthetic fixture must contain a standard security dictionary')
    await assert.rejects(worker.request({ command: 'open', documentId: 'unsupported', password: 'fixture-password' },
      Buffer.from(unsupported, 'latin1')), { code: 'pdf/security-unsupported' })
    await assert.rejects(worker.request({ command: 'open', documentId: 'malformed' }, Buffer.from('not a PDF')),
      { code: 'pdf/native-open' })
  } finally { await worker.dispose() }
})
