import { PDFDocument } from 'pdf-lib'

/** Three independent pages plus deliberate shared/dependency fields; synthetic data only. */
export async function formPageBatchesFixture() {
  const pdf = await PDFDocument.create(), form = pdf.getForm()
  const pages = Array.from({ length: 3 }, () => pdf.addPage([400, 600]))
  for (const [index, page] of pages.entries()) {
    form.createTextField(`page-${index + 1}`).addToPage(page, { x: 30, y: 500, width: 200, height: 24 })
  }
  const shared = form.createTextField('shared')
  for (const page of pages.slice(0, 2)) shared.addToPage(page, { x: 30, y: 440, width: 200, height: 24 })
  form.createCheckBox('controller').addToPage(pages[0], { x: 30, y: 380, width: 20, height: 20 })
  for (const [index, page] of pages.slice(0, 2).entries()) {
    form.createCheckBox(`alternative-${index + 1}`).addToPage(page, { x: 30, y: 320, width: 20, height: 20 })
  }
  return new Uint8Array(await pdf.save())
}
