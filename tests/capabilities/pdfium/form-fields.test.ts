import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectFixturePdf, materializeFixturePdf } from '../../fixtures/native-document.ts'
import { acroformFixture, duplicateFieldNamesFixture } from '../../fixtures/acroform.ts'

test('AcroForm inspection exposes stable field identity, widgets, options and permissions', async () => {
  const inspection = await inspectFixturePdf(await acroformFixture())
  const fields = inspection.formFields ?? []
  assert.deepEqual(fields.map(field => [field.name, field.type]), [
    ['Text1', 'text'], ['accepted', 'checkbox'], ['contact', 'radio'], ['choice', 'dropdown'],
    ['list', 'option-list'], ['locked', 'text'], ['hidden', 'text'], ['action', 'unsupported'],
  ])
  assert.deepEqual(fields.find(field => field.name === 'Text1')?.widgets.map(widget => widget.page), [1, 2])
  assert.equal(fields.find(field => field.name === 'Text1')?.maxLength, 6)
  assert.equal(fields.find(field => field.name === 'Text1')?.required, true)
  assert.deepEqual(fields.find(field => field.name === 'choice')?.options, ['first', 'second'])
  assert.equal(fields.find(field => field.name === 'locked')?.readOnly, true)
  assert.deepEqual(fields.find(field => field.name === 'hidden')?.widgets, [])
})

test('AcroForm materialization writes typed values and explicit clears without resurrecting defaults', async () => {
  const source = await acroformFixture()
  const before = await inspectFixturePdf(source)
  const fields = before.formFields ?? []
  const text = fields.find(field => field.name === 'Text1')!
  const result = await materializeFixturePdf(source, [
    { type: 'set-field', fieldId: text.id!, value: 'Agent' },
    { type: 'set-field', name: 'accepted', value: true },
    { type: 'set-field', name: 'contact', value: 'phone' },
    { type: 'set-field', name: 'choice', value: 'second' },
    { type: 'set-field', name: 'list', value: ['two'] },
  ])
  const saved = await inspectFixturePdf(result.bytes)
  assert.deepEqual(Object.fromEntries((saved.formFields ?? []).map(field => [field.name, field.value])), {
    Text1: 'Agent', accepted: true, contact: 'phone', choice: ['second'], list: ['two'], locked: '', hidden: '', action: '',
  })
  const cleared = await materializeFixturePdf(result.bytes, [
    { type: 'set-field', fieldId: text.id!, value: '' },
    { type: 'set-field', name: 'accepted', value: false },
    { type: 'set-field', name: 'contact', value: '' },
    { type: 'set-field', name: 'choice', value: '' },
    { type: 'set-field', name: 'list', value: [] },
  ])
  const reopened = await inspectFixturePdf(cleared.bytes)
  assert.deepEqual(Object.fromEntries((reopened.formFields ?? []).map(field => [field.name, field.value])), {
    Text1: '', accepted: false, contact: '', choice: [], list: [], locked: '', hidden: '', action: '',
  })
})

test('independent same-name fields remain addressable by native field id', async () => {
  const fields = (await inspectFixturePdf(await duplicateFieldNamesFixture())).formFields ?? []
  const duplicates = fields.filter(field => field.name === 'same-name')
  assert.equal(duplicates.length, 3)
  assert.equal(new Set(duplicates.map(field => field.id)).size, 3)
  assert.ok(duplicates.every(field => !field.readOnly && field.widgets.length === 1))
})
