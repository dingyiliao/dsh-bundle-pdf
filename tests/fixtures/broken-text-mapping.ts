import { classicPdf } from './plain-pdf.ts'

function invalidMapping(text: string): string {
  const codes = [...new Set(text)].map((character, index) =>
    `<${character.charCodeAt(0).toString(16).padStart(2, '0')}> <${(index + 1).toString(16).padStart(4, '0')}>`)
  return `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /BrokenUnicode def /CMapType 2 def
1 begincodespacerange <00> <ff> endcodespacerange
${codes.length} beginbfchar ${codes.join('\n')} endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end
`
}

function stream(program: string, fields = '') {
  return `<< /Length ${program.length} ${fields} >>\nstream\n${program}endstream`
}

/** Visible glyphs with invalid control-code mappings. No real forms or personal data. */
export async function brokenTextMappingFixture(rotation = 0) {
  const label = 'Full name in English'
  const widgetValue = 'DO NOT READ THIS FORM VALUE'
  return classicPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [7 0 R] /DA (/Clean 12 Tf 0 g) /DR << /Font << /Clean 8 0 R >> >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 250] /Rotate ${rotation}
       /Resources << /Font << /Broken 4 0 R >> >> /Contents 6 0 R /Annots [7 0 R] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >>',
    stream(invalidMapping(label)),
    stream(`BT /Broken 22 Tf 30 150 Td (${label}) Tj ET\n`),
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (synthetic-value) /V (${widgetValue})
      /Rect [30 50 350 80] /P 3 0 R /F 4 /AP << /N 9 0 R >> >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    stream(`1 1 1 rg 0 0 320 30 re f\n0 g BT /Clean 12 Tf 4 8 Td (${widgetValue}) Tj ET\n`,
      '/Type /XObject /Subtype /Form /BBox [0 0 320 30] /Resources << /Font << /Clean 8 0 R >> >>'),
  ])
}

/** One invalid font run must not change the representation of another run's saved reference. */
export async function partialTextMappingFixture() {
  return classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 540 720] >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /Clean 5 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /Clean 5 0 R /Broken 6 0 R >> >> /Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding /ToUnicode 7 0 R >>',
    stream(invalidMapping('BAD MAPPING')),
    stream('BT /Clean 16 Tf 40 500 Td (Opening page) Tj ET\n'),
    stream('BT /Clean 16 Tf 40 500 Td (Training error does not certify generalization.) Tj ET\n'
      + 'BT /Clean 16 Tf 40 470 Td (Always evaluate on independent data.) Tj ET\n'
      + 'BT /Broken 16 Tf 40 350 Td (BAD MAPPING) Tj ET\n'),
  ])
}
