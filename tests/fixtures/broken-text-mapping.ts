import { PDFDocument, PDFDict, PDFName, StandardFonts, degrees } from 'pdf-lib'

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
  const codes = [...new Set('Full name in English')].map((character, index) =>
    `<${character.charCodeAt(0).toString(16).padStart(2, '0')}> <${(index + 1).toString(16).padStart(4, '0')}>`)
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /BrokenUnicode def /CMapType 2 def
1 begincodespacerange <00> <ff> endcodespacerange
${codes.length} beginbfchar ${codes.join('\n')} endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`
  pdf.context.lookup(font.ref, PDFDict).set(PDFName.of('ToUnicode'), pdf.context.register(pdf.context.flateStream(cmap)))
  return new Uint8Array(await pdf.save())
}
