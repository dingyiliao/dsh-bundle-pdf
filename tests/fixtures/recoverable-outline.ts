import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'

/** Minimal reproduction of the ARM manual: valid First/Next tree, but
 * Parent/Prev/Last point to placeholder objects, not their actual neighbours.
 */
export async function recoverableOutlineFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const first = pdf.addPage([400, 600]), second = pdf.addPage([400, 600])
  first.drawText('Imported chapter', { x: 40, y: 520, size: 18 })
  second.drawText('Imported section', { x: 40, y: 520, size: 18 })
  const stale = pdf.context.register(pdf.context.obj({}))
  const root = pdf.context.obj({ Type: 'Outlines', Count: 2, Last: stale })
  const chapter = pdf.context.obj({ Title: PDFHexString.fromText('Imported chapter'),
    Parent: stale, Last: stale, Count: -1, C: [0.2, 0.4, 0.6], F: 3,
    Dest: [first.ref, PDFName.of('XYZ'), 40, 520, 1.25],
  })
  const child = pdf.context.register(pdf.context.obj({ Title: PDFHexString.fromText('Imported section'),
    Parent: stale, Dest: [second.ref, PDFName.of('FitH'), 520],
  }))
  const external = pdf.context.register(pdf.context.obj({ Title: PDFString.of('Reference'), Parent: stale, Prev: stale,
    A: { S: 'URI', URI: PDFString.of('https://example.com/reference') },
  }))
  // Last aliases are full duplicate dictionaries in the real manual, not just
  // empty placeholders. Their payload/forward links must match the real item.
  root.set(PDFName.of('Last'), pdf.context.register(pdf.context.lookup(external, PDFDict).clone()))
  chapter.set(PDFName.of('Last'), pdf.context.register(pdf.context.lookup(child, PDFDict).clone()))
  chapter.set(PDFName.of('First'), child)
  chapter.set(PDFName.of('Next'), external)
  root.set(PDFName.of('First'), pdf.context.register(chapter))
  pdf.catalog.set(PDFName.of('Outlines'), pdf.context.register(root))
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false })
}
