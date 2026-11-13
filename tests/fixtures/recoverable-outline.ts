import { classicPdf, pdfArray, pdfDict, pdfHex, pdfString, pdfStream, ref } from './pdf-fixture-kit.ts'

/** Minimal reproduction of the ARM manual: valid First/Next tree, but
 * Parent/Prev/Last point to placeholder objects, not their actual neighbours. */
export async function recoverableOutlineFixture(): Promise<Uint8Array> {
  return classicPdf([
    pdfDict({ Type: '/Catalog', Pages: ref(2), Outlines: ref(9) }),
    pdfDict({ Type: '/Pages', Kids: pdfArray([ref(5), ref(7)]), Count: '2' }),
    pdfDict({ Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' }),
    pdfDict({ Producer: pdfString('DSH PDF test fixture') }),
    pdfDict({ Type: '/Page', Parent: ref(2), MediaBox: '[0 0 400 600]', Resources: pdfDict({ Font: pdfDict({ F1: ref(3) }) }), Contents: ref(6) }),
    pdfStream('BT /F1 18 Tf 40 520 Td (Imported chapter) Tj ET'),
    pdfDict({ Type: '/Page', Parent: ref(2), MediaBox: '[0 0 400 600]', Resources: pdfDict({ Font: pdfDict({ F1: ref(3) }) }), Contents: ref(8) }),
    pdfStream('BT /F1 18 Tf 40 520 Td (Imported section) Tj ET'),
    pdfDict({ Type: '/Outlines', Count: '2', First: ref(10), Last: ref(13) }),
    pdfDict({ Title: pdfHex('Imported chapter'), Parent: ref(9), First: ref(11), Last: ref(14), Next: ref(12), Count: '-1', C: '[0.2 0.4 0.6]', F: '3', Dest: `[${ref(5)} /XYZ 40 520 1.25]` }),
    pdfDict({ Title: pdfHex('Imported section'), Parent: ref(10), Dest: `[${ref(7)} /FitH 520]` }),
    pdfDict({ Title: pdfString('Reference'), Parent: ref(9), Prev: ref(10), A: pdfDict({ S: '/URI', URI: pdfString('https://example.com/reference') }) }),
    pdfDict({ Title: pdfString('Reference'), Parent: ref(9), Prev: ref(10), A: pdfDict({ S: '/URI', URI: pdfString('https://example.com/reference') }) }),
    pdfDict({ Title: pdfHex('Imported section'), Parent: ref(10), Dest: `[${ref(7)} /FitH 520]` }),
  ], 4)
}
