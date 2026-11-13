import { classicPdf, pdfArray, pdfDict, pdfHex, pdfName, pdfStream, pdfString, ref } from './pdf-fixture-kit.ts'

function page(content: number, annotations: readonly number[], pageNumber: number): string {
  return pdfDict({ Type: '/Page', Parent: ref(2), MediaBox: '[0 0 400 600]',
    Resources: pdfDict({ Font: pdfDict({ F1: ref(3) }) }), Contents: ref(content),
    ...(annotations.length ? { Annots: pdfArray(annotations.map(ref)) } : {}),
    ...(pageNumber === 2 ? { CropBox: '[10 20 390 580]', Rotate: '90' } : {}) })
}

function textWidget(parent: number, pageNumber: number, rect: string, flags = 0): string {
  return pdfDict({ Type: '/Annot', Subtype: '/Widget', Rect: rect, Parent: ref(parent), P: ref(pageNumber),
    F: String(flags), FT: '/Tx', DA: pdfString('/Helv 10 Tf 0 g') })
}

/** Synthetic fields and values only; no personal documents in tool tests. */
export async function acroformFixture(): Promise<Uint8Array> {
  const objects = [
    pdfDict({ Type: '/Catalog', Pages: ref(2), AcroForm: ref(9) }),
    pdfDict({ Type: '/Pages', Kids: pdfArray([ref(5), ref(7)]), Count: '2' }),
    pdfDict({ Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' }),
    pdfDict({ CreationDate: pdfString('D:20000101000000Z'), Producer: pdfString('DSH PDF test fixture') }),
    page(6, [11, 14, 16, 17, 19, 21, 23, 25, 27], 1),
    pdfStream('BT /F1 12 Tf 30 550 Td (Applicant name) Tj 60 465 Td (Accept conditions) Tj 60 425 Td (Email) Tj 180 425 Td (Phone) Tj ET'),
    page(8, [12], 2),
    pdfStream(''),
    pdfDict({ Type: '/AcroForm', Fields: pdfArray([ref(10), ref(13), ref(15), ref(18), ref(20), ref(22), ref(24), ref(26)]), NeedAppearances: 'true' }),
    pdfDict({ FT: '/Tx', T: pdfString('Text1'), V: pdfHex('Demo'), DV: pdfHex('Demo'), MaxLen: '6', Ff: '2', Kids: pdfArray([ref(11), ref(12)]) }),
    textWidget(10, 5, '[30 510 230 534]'),
    textWidget(10, 7, '[50 300 230 324]'),
    pdfDict({ FT: '/Btn', T: pdfString('accepted'), V: '/Off', Kids: pdfArray([ref(14)]) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Btn', Parent: ref(13), Rect: '[30 460 50 480]', P: ref(5), AP: pdfDict({ N: pdfDict({ Off: ref(27), Yes: ref(28) }) }), AS: '/Off' }),
    pdfDict({ FT: '/Btn', T: pdfString('contact'), Ff: '32768', V: pdfName('Off'), Kids: pdfArray([ref(16), ref(17)]) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Btn', Parent: ref(15), Rect: '[30 420 50 440]', P: ref(5), AP: pdfDict({ N: pdfDict({ Off: ref(27), email: ref(28) }) }), AS: '/Off' }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Btn', Parent: ref(15), Rect: '[150 420 170 440]', P: ref(5), AP: pdfDict({ N: pdfDict({ Off: ref(27), phone: ref(28) }) }), AS: '/Off' }),
    pdfDict({ FT: '/Ch', T: pdfString('choice'), Ff: '131072', Opt: pdfArray([pdfString('first'), pdfString('second')]), V: pdfString(''), Kids: pdfArray([ref(19)]) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Ch', Parent: ref(18), Rect: '[30 350 210 374]', P: ref(5) }),
    pdfDict({ FT: '/Ch', T: pdfString('list'), Ff: '0', Opt: pdfArray([pdfString('one'), pdfString('two')]), V: '[]', Kids: pdfArray([ref(21)]) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Ch', Parent: ref(20), Rect: '[30 270 210 310]', P: ref(5) }),
    pdfDict({ FT: '/Tx', T: pdfString('locked'), Ff: '1', Kids: pdfArray([ref(23)]) }),
    textWidget(22, 5, '[30 210 210 234]'),
    pdfDict({ FT: '/Tx', T: pdfString('hidden'), Kids: pdfArray([ref(25)]) }),
    textWidget(24, 5, '[30 150 210 174]', 2),
    pdfDict({ FT: '/Btn', T: pdfString('action'), Ff: '65536', Kids: pdfArray([ref(27)]) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Btn', Parent: ref(26), Rect: '[35 35 125 59]', P: ref(5) }),
    pdfStream('q 0 g 0 0 1 1 re f Q', { Type: '/XObject', Subtype: '/Form', BBox: '[0 0 1 1]' }),
    pdfStream('q 1 g 0 0 1 1 re f Q', { Type: '/XObject', Subtype: '/Form', BBox: '[0 0 1 1]' }),
  ]
  return classicPdf(objects, 4)
}

/** Matches a common imported-form shape: distinct widgets share /T. */
export async function duplicateFieldNamesFixture(): Promise<Uint8Array> {
  const objects = [
    pdfDict({ Type: '/Catalog', Pages: ref(2), AcroForm: ref(9) }),
    pdfDict({ Type: '/Pages', Kids: pdfArray([ref(5), ref(7)]), Count: '2' }),
    pdfDict({ Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' }),
    pdfDict({ Producer: pdfString('DSH PDF test fixture') }),
    pdfDict({ Type: '/Page', Parent: ref(2), MediaBox: '[0 0 300 400]', Resources: pdfDict({ Font: pdfDict({ F1: ref(3) }) }), Contents: ref(6), Annots: pdfArray([ref(11), ref(13), ref(15), ref(17), ref(20)]) }),
    pdfStream('BT /F1 12 Tf 65 276 Td (Independent option 1) Tj 65 216 Td (Independent option 2) Tj 65 156 Td (Independent option 3) Tj ET'),
    pdfDict({ Type: '/Page', Parent: ref(2), MediaBox: '[0 0 300 400]', Resources: pdfDict({ Font: pdfDict({ F1: ref(3) }) }), Contents: ref(8), Annots: pdfArray([ref(19)]) }),
    pdfStream(''),
    pdfDict({ Type: '/AcroForm', Fields: pdfArray([ref(10), ref(12), ref(14), ref(16), ref(18)]) }),
    pdfDict({ FT: '/Tx', T: pdfString('unique-text'), Kids: pdfArray([ref(11)]) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Tx', Parent: ref(10), Rect: '[30 330 180 354]', P: ref(5) }),
    pdfDict({ FT: '/Btn', T: pdfString('same-name'), Kids: pdfArray([ref(13)]) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Btn', Parent: ref(12), Rect: '[30 270 54 294]', P: ref(5), AS: '/Off', AP: pdfDict({ N: pdfDict({ Off: ref(21), Yes: ref(22) }) }) }),
    pdfDict({ FT: '/Btn', T: pdfString('same-name'), Kids: pdfArray([ref(15)]) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Btn', Parent: ref(14), Rect: '[30 210 54 234]', P: ref(5), AS: '/Off', AP: pdfDict({ N: pdfDict({ Off: ref(21), Yes: ref(22) }) }) }),
    pdfDict({ FT: '/Btn', T: pdfString('same-name'), Kids: pdfArray([ref(17)]) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Btn', Parent: ref(16), Rect: '[30 150 54 174]', P: ref(5), AS: '/Off', AP: pdfDict({ N: pdfDict({ Off: ref(21), Yes: ref(22) }) }) }),
    pdfDict({ FT: '/Tx', T: pdfString('repeated-widget'), Kids: pdfArray([ref(19), ref(20)]) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Tx', Parent: ref(18), Rect: '[30 90 180 114]', P: ref(7) }),
    pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Tx', Parent: ref(18), Rect: '[30 30 180 54]', P: ref(5) }),
    pdfStream('q 0 g 0 0 1 1 re f Q', { Type: '/XObject', Subtype: '/Form', BBox: '[0 0 1 1]' }),
    pdfStream('q 1 g 0 0 1 1 re f Q', { Type: '/XObject', Subtype: '/Form', BBox: '[0 0 1 1]' }),
  ]
  return classicPdf(objects, 4)
}

/** Dense printed labels above fields reproduce the old number-over-text obstruction. */
export async function denseFormFixture(): Promise<Uint8Array> {
  const fields: string[] = [], annotations: number[] = []
  const objects: string[] = [
    pdfDict({ Type: '/Catalog', Pages: ref(2), AcroForm: ref(7) }),
    pdfDict({ Type: '/Pages', Kids: pdfArray([ref(5)]), Count: '1' }),
    pdfDict({ Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' }),
    pdfDict({ Producer: pdfString('DSH PDF test fixture') }),
    pdfDict({ Type: '/Page', Parent: ref(2), MediaBox: '[0 0 600 840]', Resources: pdfDict({ Font: pdfDict({ F1: ref(3) }) }), Contents: ref(6) }),
    pdfStream('BT /F1 10 Tf 20 815 Td (SAMPLE FORM - printed content must stay readable) Tj 20 795 Td (Select applicable options. Complete details only when Yes is selected.) Tj ET'),
    pdfDict({ Type: '/AcroForm', Fields: '[]', NeedAppearances: 'true' }),
  ]
  let next = 8
  for (let index = 0; index < 24; index++) {
    const field = next++, widget = next++
    fields.push(ref(field)); annotations.push(widget)
    objects.push(pdfDict({ FT: '/Btn', T: pdfString(`option-${index}`), V: index % 4 === 0 ? '/Yes' : '/Off', Kids: pdfArray([ref(widget)]) }))
    objects.push(pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Btn', Parent: ref(field), Rect: `[${20 + index % 3 * 190} ${760 - Math.floor(index / 3) * 17} ${32 + index % 3 * 190} ${772 - Math.floor(index / 3) * 17}]`, P: ref(5), AS: index % 4 === 0 ? '/Yes' : '/Off' }))
  }
  for (let index = 0; index < 18; index++) {
    const field = next++, widget = next++
    fields.push(ref(field)); annotations.push(widget)
    objects.push(pdfDict({ FT: '/Tx', T: pdfString(`details-${index}`), V: pdfString(`Sample value ${index + 1}`), Kids: pdfArray([ref(widget)]) }))
    objects.push(pdfDict({ Type: '/Annot', Subtype: '/Widget', FT: '/Tx', Parent: ref(field), Rect: `[${20 + index % 3 * 190} ${580 - Math.floor(index / 3) * 65} ${185 + index % 3 * 190} ${598 - Math.floor(index / 3) * 65}]`, P: ref(5) }))
  }
  objects[4] = pdfDict({ Type: '/Page', Parent: ref(2), MediaBox: '[0 0 600 840]', Resources: pdfDict({ Font: pdfDict({ F1: ref(3) }) }), Contents: ref(6), Annots: pdfArray(annotations.map(ref)) })
  objects[6] = pdfDict({ Type: '/AcroForm', Fields: pdfArray(fields), NeedAppearances: 'true' })
  return classicPdf(objects, 4)
}
