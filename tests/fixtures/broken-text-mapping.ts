import { PDFDocument, PDFDict, PDFName, StandardFonts, degrees, type PDFFont } from 'pdf-lib'

function invalidateMapping(pdf: PDFDocument, font: PDFFont, text: string) {
  const codes = [...new Set(text)].map((character, index) =>
    `<${character.charCodeAt(0).toString(16).padStart(2, '0')}> <${(index + 1).toString(16).padStart(4, '0')}>`)
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /BrokenUnicode def /CMapType 2 def
1 begincodespacerange <00> <ff> endcodespacerange
${codes.length} beginbfchar ${codes.join('\n')} endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`
  pdf.context.lookup(font.ref, PDFDict).set(PDFName.of('ToUnicode'), pdf.context.register(pdf.context.flateStream(cmap)))
}

/** Visible glyphs with invalid control-code mappings. No real forms or personal data. */
export async function brokenTextMappingFixture(rotation = 0) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 250])
  page.setRotation(degrees(rotation))
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('Full name in English', { x: 30, y: 150, size: 22, font })
  const field = pdf.getForm().createTextField('synthetic-value')
  field.addToPage(page, { x: 30, y: 50, width: 320, height: 30 })
  field.setText('DO NOT READ THIS FORM VALUE')
  await pdf.flush()
  invalidateMapping(pdf, font, 'Full name in English')
  return new Uint8Array(await pdf.save())
}

/** One invalid font run must not change the representation of another run's saved reference. */
export async function partialTextMappingFixture() {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const damaged = await pdf.embedFont(StandardFonts.Courier)
  pdf.addPage([540, 720]).drawText('Opening page', { x: 40, y: 500, size: 16, font })
  const page = pdf.addPage([540, 720])
  page.drawText('Training error does not certify generalization.', { x: 40, y: 500, size: 16, font })
  page.drawText('Always evaluate on independent data.', { x: 40, y: 470, size: 16, font })
  page.drawText('BAD MAPPING', { x: 40, y: 350, size: 16, font: damaged })
  await pdf.flush()
  invalidateMapping(pdf, damaged, 'BAD MAPPING')
  return new Uint8Array(await pdf.save())
}
