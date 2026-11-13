import { classicPdf, pdfArray, pdfDict, pdfStream, pdfString, ref } from './pdf-fixture-kit.ts'
import { materializeFixturePdf } from './native-document.ts'
import type { PdfWorkingCopyOperation } from '../../src/core/pdf-types.js'

const mode = process.argv[2]
if (!['history-clear', 'radio-only', 'plain-clear'].includes(mode)) throw new Error('Unknown form save scenario')

function formFixture(): Uint8Array {
  return classicPdf([
    pdfDict({ Type: '/Catalog', Pages: ref(2), AcroForm: ref(7) }),
    pdfDict({ Type: '/Pages', Kids: pdfArray([ref(5)]), Count: '1' }),
    pdfDict({ Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' }),
    pdfDict({ Producer: pdfString('DSH PDF test fixture') }),
    pdfDict({ Type: '/Page', Parent: ref(2), MediaBox: '[0 0 400 600]', Resources: pdfDict({ Font: pdfDict({ F1: ref(3) }) }), Contents: ref(6), Annots: pdfArray([ref(9), ref(11), ref(13), ref(14)]) }),
    pdfStream(''),
    pdfDict({ Type: '/AcroForm', Fields: pdfArray([ref(8), ref(10), ref(12)]), NeedAppearances: 'true' }),
    pdfDict({ FT: '/Tx', T: pdfString('sample-text'), Kids: pdfArray([ref(9)]) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Tx', Parent: ref(8), Rect: '[20 500 200 524]', P: ref(5) }),
    pdfDict({ FT: '/Btn', T: pdfString('sample-checkbox'), Kids: pdfArray([ref(11)]), V: '/Off' }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Btn', Parent: ref(10), Rect: '[20 460 40 480]', P: ref(5), AS: '/Off', AP: pdfDict({ N: pdfDict({ Off: ref(15), Yes: ref(16) }) }) }),
    pdfDict({ FT: '/Btn', T: pdfString('sample-radio'), Ff: '32768', Opt: pdfArray(['/first', '/second']), Kids: pdfArray([ref(13), ref(14)]), V: '/first' }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Btn', Parent: ref(12), Rect: '[20 400 40 420]', P: ref(5), AS: '/first', AP: pdfDict({ N: pdfDict({ Off: ref(15), first: ref(16) }) }) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Btn', Parent: ref(12), Rect: '[100 400 120 420]', P: ref(5), AS: '/Off', AP: pdfDict({ N: pdfDict({ Off: ref(15), second: ref(16) }) }) }),
    pdfStream('q 0 g 0 0 1 1 re f Q', { Type: '/XObject', Subtype: '/Form', BBox: '[0 0 1 1]' }),
    pdfStream('q 1 g 0 0 1 1 re f Q', { Type: '/XObject', Subtype: '/Form', BBox: '[0 0 1 1]' }),
  ])
}

const field = (name: string, value: string | boolean): PdfWorkingCopyOperation => ({ type: 'set-field', name, value })
const operations = mode === 'history-clear'
  ? [field('sample-text', '测试'), field('sample-radio', 'first'), field('sample-checkbox', true),
      field('sample-text', ''), field('sample-radio', ''), field('sample-checkbox', false)]
  : mode === 'radio-only' ? [field('sample-radio', 'second')] : [field('sample-text', '')]
const saved = await materializeFixturePdf(formFixture(), operations)
const fields = saved.document.formFields ?? []
process.stdout.write(JSON.stringify({
  text: fields.find(field => field.name === 'sample-text')?.value ?? '',
  radio: fields.find(field => field.name === 'sample-radio')?.value ?? '',
  checkbox: fields.find(field => field.name === 'sample-checkbox')?.value ?? false,
}))
