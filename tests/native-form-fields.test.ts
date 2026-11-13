import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { decodeFormFields, encodeFormEdits } from '../src/adapters/host/pdfium/document-forms.js'
import { NativeWorker } from '../src/engine/host/native-worker.js'
import { acroformFixture, duplicateFieldNamesFixture } from './fixtures/acroform.js'
import { nativeTestSubprocess } from './native-test-subprocess.js'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const skip = !existsSync(executable)
if (skip && process.env.DSH_PDF_REQUIRE_NATIVE_EXTENSIONS === '1') throw new Error('Native form tests require the patched PDFium helper')

test('native AcroForm writes share field identity and preserve explicit clears and widget appearances after reopen', { skip }, async t => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.ready()
    if (!worker.documentExtensions && process.env.DSH_PDF_REQUIRE_NATIVE_EXTENSIONS !== '1') {
      return t.skip('Native helper does not expose PDFium extensions')
    }
    assert.equal(worker.documentExtensions, true)
    const original = await acroformFixture()
    const documentId = 'native-form-fields'
    const read = async () => decodeFormFields((await worker.request({ command: 'formFields', documentId })).value.fields)
    const saveAndReopen = async () => {
      const { size } = (await worker.request({ command: 'saveCopy', documentId })).value
      const { bytes } = await worker.request({ command: 'saveChunk', documentId, offset: 0, length: size })
      await worker.request({ command: 'close', documentId })
      await worker.request({ command: 'open', documentId }, bytes)
      return bytes
    }
    await worker.request({ command: 'open', documentId }, original)
    const fields = await read()
    const page = { command: 'formFields', documentId, limit: 1 } as const
    assert.deepEqual((await worker.request({ ...page, offset: fields.length })).value, { fields: [], nextOffset: null })
    await assert.rejects(worker.request({ ...page, offset: fields.length + 1 }), { code: 'pdf/native-form' })
    const firstPage = (await worker.request({ ...page, offset: 0 })).value
    assert.deepEqual(decodeFormFields(firstPage.fields), fields.slice(0, 1))
    assert.equal(firstPage.nextOffset, 1)
    const text = fields.find(field => field.name === 'Text1')!
    const choice = fields.find(field => field.name === 'choice')!
    assert.deepEqual(text.widgets.map(widget => widget.page), [1, 2])
    assert.equal(text.maxLength, 6)
    assert.equal(text.required, true)
    assert.deepEqual(choice.options, ['first', 'second'])
    assert.equal(fields.find(field => field.name === 'locked')!.readOnly, true)
    assert.deepEqual(fields.find(field => field.name === 'hidden')!.widgets, [])
    assert.equal(fields.find(field => field.name === 'action')!.type, 'unsupported')
    assert.equal(fields.find(field => field.name === 'action')!.readOnly, true)
    await assert.rejects(worker.request({ command: 'applyFormFields', documentId,
      edits: [{ type: 'unknown', objectNumber: 1, generation: 0, value: '' } as never] }),
    { code: 'pdf/native-request' })
    const changes = encodeFormEdits(fields, [
      { type: 'set-field', fieldId: text.id!, value: 'Agent' },
      { type: 'set-field', name: 'accepted', value: true },
      { type: 'set-field', name: 'contact', value: 'phone' },
      { type: 'set-field', fieldId: choice.id!, value: 'second' },
      { type: 'set-field', name: 'list', value: ['two'] },
    ])
    await assert.rejects(worker.request({ command: 'applyFormFields', documentId,
      edits: [changes[0]!, { ...changes[0]!, objectNumber: 99999 }] }), { code: 'pdf/native-form' })
    assert.equal((await read()).find(field => field.id === text.id)!.value, 'Demo')
    await worker.request({ command: 'applyFormFields', documentId, edits: changes })
    await saveAndReopen()
    const savedFields = await read()
    assert.equal(savedFields.find(field => field.name === 'Text1')?.value, 'Agent')
    assert.deepEqual(savedFields.find(field => field.name === 'choice')?.value, ['second'])
    assert.equal(savedFields.find(field => field.name === 'Text1')?.widgets.length, 2)
    assert.deepEqual(Object.fromEntries((await read()).map(field => [field.name, field.value])), {
      Text1: 'Agent', accepted: true, contact: 'phone', choice: ['second'], list: ['two'], locked: '', hidden: '', action: '',
    })
    const edits = encodeFormEdits(await read(), [
      { type: 'set-field', fieldId: text.id!, value: '' },
      { type: 'set-field', name: 'accepted', value: false },
      { type: 'set-field', name: 'contact', value: '' },
      { type: 'set-field', fieldId: choice.id!, value: '' },
      { type: 'set-field', name: 'list', value: [] },
    ])
    await worker.request({ command: 'applyFormFields', documentId, edits })
    await saveAndReopen()
    const cleared = await read()
    assert.equal(cleared.find(field => field.name === 'Text1')?.value, '')
    assert.deepEqual(cleared.find(field => field.name === 'choice')?.value, [])
    assert.deepEqual(Object.fromEntries((await read()).map(field => [field.name, field.value])), {
      Text1: '', accepted: false, contact: '', choice: [], list: [], locked: '', hidden: '', action: '',
    })
  } finally { await worker.dispose() }
})

test('native AcroForm addresses independent same-name fields by object identity', { skip }, async t => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.ready()
    if (!worker.documentExtensions && process.env.DSH_PDF_REQUIRE_NATIVE_EXTENSIONS !== '1') {
      return t.skip('Native helper does not expose PDFium extensions')
    }
    assert.equal(worker.documentExtensions, true)
    const documentId = 'native-form-duplicate'
    await worker.request({ command: 'open', documentId }, await duplicateFieldNamesFixture())
    const read = async () => decodeFormFields((await worker.request({ command: 'formFields', documentId })).value.fields)
    const fields = await read()
    const duplicates = fields.filter(field => field.name === 'same-name')
    assert.equal(duplicates.length, 3)
    assert.equal(new Set(duplicates.map(field => field.id)).size, 3)
    assert.ok(duplicates.every(field => !field.readOnly && field.widgets.length === 1))
    const selected = duplicates[1]!.id!
    await worker.request({ command: 'applyFormFields', documentId, edits: encodeFormEdits(fields, [
      { type: 'set-field', fieldId: selected, value: true },
    ]) })
    const { size } = (await worker.request({ command: 'saveCopy', documentId })).value
    const { bytes } = await worker.request({ command: 'saveChunk', documentId, offset: 0, length: size })
    await worker.request({ command: 'close', documentId })
    await worker.request({ command: 'open', documentId }, bytes)
    assert.deepEqual((await read()).filter(field => field.name === 'same-name' && field.value === true).map(field => field.id), [selected])
  } finally { await worker.dispose() }
})
