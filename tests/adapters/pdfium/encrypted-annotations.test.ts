import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readEncryptedAnnotations, saveEncryptedAnnotations, verifyEncryptedSave,
} from '../../../src/adapters/host/pdfium/encrypted-annotations.ts'
import { MAX_NATIVE_REPLY } from '../../../src/engine/host/framing.ts'
import type { PdfAnnotation, PdfDocumentInfo } from '../../../src/core/pdf-types.ts'
import { decodeNativeReply, type NativeRequest } from '../../../src/engine/protocol/commands.ts'
import type { NativePayloadFor, NativePdfPort } from '../../../src/engine/host/native-port.ts'

const signal = new AbortController().signal
const reply = (value: unknown, bytes = Buffer.alloc(0)) => ({ value, bytes })
const fakeWorker = (respond: (request: NativeRequest) => ReturnType<typeof reply>) => ({
  async readAnnotations<T extends NativePayloadFor<'annotations'>>(payload: T) {
    const request = { command: 'annotations' as const, ...payload }
    const { value, bytes } = respond(request)
    return decodeNativeReply(request, value, bytes)
  },
  async editAnnotation<T extends NativePayloadFor<'annotationEdit'>>(payload: T) {
    const request = { command: 'annotationEdit' as const, ...payload } as NativeRequest
    const { value, bytes } = respond(request)
    return decodeNativeReply(request, value, bytes)
  },
  async materializeCopy(payload: NativePayloadFor<'saveCopy'>) {
    const request = { command: 'saveCopy' as const, ...payload }
    const { value, bytes } = respond(request)
    return decodeNativeReply(request, value, bytes)
  },
  async readMaterializedChunk(payload: NativePayloadFor<'saveChunk'>) {
    const request = { command: 'saveChunk' as const, ...payload }
    const { value, bytes } = respond(request)
    return decodeNativeReply(request, value, bytes)
  },
} satisfies Pick<NativePdfPort, 'readAnnotations' | 'editAnnotation' | 'materializeCopy' | 'readMaterializedChunk'>)
const annotation = (id: string, sourceObjectId: string, extra: Partial<PdfAnnotation> = {}): PdfAnnotation =>
  ({ id, sourceObjectId, page: 1, subtype: 'Text', editable: true, supported: true, flags: 4,
    rect: [10, 10, 30, 30], ...extra })
const document = (annotations: PdfAnnotation[] = []): PdfDocumentInfo => ({
  pageCount: 1, pages: [{ page: 1, cropBox: [0, 0, 200, 300], userUnit: 1, rotation: 0 }],
  annotations, encrypted: true, signed: false, readOnly: false, annotationEditing: 'allowed',
})

test('protected annotation pagination fences physical indices and deduplicates embedded IDs', async () => {
  const entry = { subtype: 'Text', editable: true, flags: 4, id: 'duplicate' }
  const worker = fakeWorker(raw => {
    assert.equal(raw.command, 'annotations')
    const { offset } = raw
    return offset === 0 ? reply({ annotations: [{ ...entry, index: 0 }], nextOffset: 64 })
      : reply({ annotations: [{ ...entry, index: 65, editable: false }], nextOffset: null })
  })
  const items = await readEncryptedAnnotations(worker, 'protected', 1, true, signal)
  assert.deepEqual(items?.map(({ id, editable }) => [id, editable]), [['duplicate', true], ['protected-annot:1:65', false]])
  for (const invalid of [
    { annotations: [{ ...entry, index: 64 }], nextOffset: null },
    { annotations: [], nextOffset: 0 },
  ]) {
    await assert.rejects(readEncryptedAnnotations(fakeWorker(() => reply(invalid)),
      'protected', 1, true, signal), { code: 'pdf/native-protocol' })
  }
})

test('protected annotation inventory falls back when the document exceeds the edit budget', async () => {
  const worker = fakeWorker(raw => {
    assert.equal(raw.command, 'annotations')
    const { offset } = raw
    return reply({ annotations: Array.from({ length: 64 }, (_, index) => ({
      index: offset + index, subtype: 'Text', flags: 4, editable: true,
    })), nextOffset: offset + 64 })
  })
  assert.equal(await readEncryptedAnnotations(worker, 'protected', 1, true, signal), undefined)
})

test('protected serialization updates source positions before descending removals and streams a large encrypted reply', async () => {
  const kept = annotation('kept', 'protected-annot:1:0')
  const deleted = annotation('deleted', 'protected-annot:1:1')
  const replaced = annotation('replaced', 'protected-annot:1:3')
  const changed = { ...kept, contents: 'changed' }
  const added = annotation('replaced', 'dsh-new:replaced', { contents: 'new placement' })
  const size = MAX_NATIVE_REPLY + 5
  const commands: Array<{ command: string; action?: string; annotationIndex?: number; length?: number }> = []
  let changedSize = false
  const worker = fakeWorker(input => {
    commands.push(input)
    if (input.command === 'saveCopy') return reply({ size })
    if (input.command === 'saveChunk') return reply({ size: changedSize ? size + 1 : size, offset: input.offset },
      Buffer.alloc(input.length, input.offset === 0 ? 1 : 2))
    return reply({ changed: true })
  })
  const baseline = document([kept, deleted, replaced])
  const projected = document([changed, added])
  const output = await saveEncryptedAnnotations(worker, 'protected', baseline, projected, signal)
  assert.deepEqual(commands.slice(0, 4).map(({ action, annotationIndex }) => [action, annotationIndex]),
    [['update', 0], ['delete', 3], ['delete', 1], ['add', undefined]])
  assert.deepEqual(commands.slice(-2).map(({ length }) => length), [MAX_NATIVE_REPLY, 5])
  assert.equal(output[0], 1)
  assert.equal(output[size - 1], 2)
  changedSize = true
  await assert.rejects(saveEncryptedAnnotations(worker, 'protected', baseline, projected, signal),
    { code: 'pdf/native-protocol' })
  await assert.rejects(saveEncryptedAnnotations(worker, 'protected', document([{ ...deleted, editable: false }]), document(), signal),
    { code: 'pdf/annotation-read-only' })
  await assert.rejects(saveEncryptedAnnotations(worker, 'protected', document([{ ...deleted, sourceObjectId: 'untrusted' }]), document(), signal),
    { code: 'pdf/native-protocol' })
  await assert.rejects(saveEncryptedAnnotations(worker, 'protected', document(), document(Array.from({ length: 20_001 },
    (_, index) => annotation(String(index), String(index)))), signal), { code: 'pdf/native-size' })
})

test('protected output verification rejects lost edits, altered marks and changed page geometry', () => {
  const original = document([annotation('kept', 'protected-annot:1:0')])
  const changed = document([{ ...original.annotations[0], contents: 'lost' }])
  assert.doesNotThrow(() => verifyEncryptedSave(original, original))
  for (const saved of [document(), changed, { ...original, pages: [{ ...original.pages[0], rotation: 90 as const }] }]) {
    assert.throws(() => verifyEncryptedSave(original, saved), { code: 'pdf/protected-save-verification' })
  }
})
