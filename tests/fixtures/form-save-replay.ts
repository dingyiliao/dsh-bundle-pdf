import { PDFDocument } from 'pdf-lib'
import { applyPdfOperations } from '../../src/adapters/host/pdf-lib/pdf-document.js'
import type { PdfWorkingCopyOperation } from '../../src/core/pdf-types.js'

// Synthetic-only subprocess fixture: a fontkit background exception must not kill the test runner.
const mode = process.argv[2]
if (!['history-clear', 'radio-only', 'plain-clear'].includes(mode)) throw new Error('Unknown form save scenario')
const pdf = await PDFDocument.create(), page = pdf.addPage([400, 600]), form = pdf.getForm()
form.createTextField('sample-text').addToPage(page, { x: 20, y: 500, width: 180, height: 24 })
form.createCheckBox('sample-checkbox').addToPage(page, { x: 20, y: 460, width: 20, height: 20 })
const radio = form.createRadioGroup('sample-radio')
radio.addOptionToPage('first', page, { x: 20, y: 400, width: 20, height: 20 })
radio.addOptionToPage('second', page, { x: 100, y: 400, width: 20, height: 20 })
const field = (name: string, value: string | boolean): PdfWorkingCopyOperation => ({ type: 'set-field', name, value })
const operations = mode === 'history-clear'
  ? [field('sample-text', '测试'), field('sample-radio', 'first'), field('sample-checkbox', true),
    field('sample-text', ''), field('sample-radio', ''), field('sample-checkbox', false)]
  : mode === 'radio-only' ? [field('sample-radio', 'second')] : [field('sample-text', '')]
const source = await pdf.save({ updateFieldAppearances: false })
const saved = await applyPdfOperations(source, operations)
const reopened = (await PDFDocument.load(saved.bytes)).getForm()
process.stdout.write(JSON.stringify({ text: reopened.getTextField('sample-text').getText() ?? '',
  radio: reopened.getRadioGroup('sample-radio').getSelected() ?? '', checkbox: reopened.getCheckBox('sample-checkbox').isChecked() }))
