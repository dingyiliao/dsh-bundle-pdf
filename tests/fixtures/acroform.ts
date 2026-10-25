import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'

/** Synthetic fields and values only; no personal documents in tool tests. */
export async function acroformFixture() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 600]), rotated = pdf.addPage([400, 600])
  rotated.setCropBox(10, 20, 380, 560)
  rotated.setRotation(degrees(90))
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('Applicant name', { x: 30, y: 550, size: 12, font })
  page.drawText('Accept conditions', { x: 60, y: 465, size: 12, font })
  page.drawText('Email', { x: 60, y: 425, size: 12, font })
  page.drawText('Phone', { x: 180, y: 425, size: 12, font })
  const form = pdf.getForm()
  const text = form.createTextField('Text1')
  text.setMaxLength(6); text.enableRequired(); text.setText('Demo')
  text.addToPage(page, { x: 30, y: 510, width: 200, height: 24 })
  text.addToPage(rotated, { x: 50, y: 300, width: 180, height: 24 })
  form.createCheckBox('accepted').addToPage(page, { x: 30, y: 460, width: 20, height: 20 })
  const radio = form.createRadioGroup('contact')
  radio.addOptionToPage('email', page, { x: 30, y: 420, width: 20, height: 20 })
  radio.addOptionToPage('phone', page, { x: 150, y: 420, width: 20, height: 20 })
  const choice = form.createDropdown('choice')
  choice.addOptions(['first', 'second'])
  choice.addToPage(page, { x: 30, y: 350, width: 180, height: 24 })
  const list = form.createOptionList('list')
  list.addOptions(['one', 'two']); list.disableMultiselect()
  list.addToPage(page, { x: 30, y: 270, width: 180, height: 40 })
  const locked = form.createTextField('locked')
  locked.addToPage(page, { x: 30, y: 210, width: 180, height: 24 }); locked.enableReadOnly()
  const hidden = form.createTextField('hidden')
  hidden.addToPage(page, { x: 30, y: 150, width: 180, height: 24 })
  hidden.acroField.getWidgets()[0].setFlags(2)
  return new Uint8Array(await pdf.save())
}

/** Matches a common imported-form shape: distinct checkbox objects share /T. */
export async function duplicateFieldNamesFixture() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([300, 400]), second = pdf.addPage([300, 400])
  const form = pdf.getForm(), font = await pdf.embedFont(StandardFonts.Helvetica)
  const text = form.createTextField('unique-text')
  text.addToPage(page, { x: 30, y: 330, width: 150, height: 24 })
  const shared = form.createTextField('repeated-widget')
  shared.addToPage(page, { x: 30, y: 90, width: 150, height: 24 })
  shared.addToPage(second, { x: 30, y: 90, width: 150, height: 24 })
  for (let index = 0; index < 3; index++) {
    const checkbox = form.createCheckBox(`original-${index}`)
    checkbox.addToPage(page, { x: 30, y: 270 - index * 60, width: 24, height: 24 })
    checkbox.acroField.setPartialName('same-name')
    page.drawText(`Independent option ${index + 1}`, { x: 65, y: 276 - index * 60, font, size: 12 })
  }
  return new Uint8Array(await pdf.save())
}

/** Dense printed labels above fields reproduce the old number-over-text obstruction. */
export async function denseFormFixture() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 840])
  const form = pdf.getForm(), font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('SAMPLE FORM - printed content must stay readable', { x: 20, y: 815, font, size: 14 })
  page.drawText('Select applicable options. Complete details only when Yes is selected.', { x: 20, y: 795, font, size: 10 })
  for (let index = 0; index < 24; index++) {
    const x = 20 + index % 3 * 190, y = 760 - Math.floor(index / 3) * 17
    page.drawText(`Printed option ${index + 1}`, { x: x + 18, y: y + 2, font, size: 10 })
    const checkbox = form.createCheckBox(`option-${index}`)
    checkbox.addToPage(page, { x, y, width: 12, height: 12 })
    if (index % 4 === 0) checkbox.check()
  }
  for (let index = 0; index < 18; index++) {
    const x = 20 + index % 3 * 190, y = 580 - Math.floor(index / 3) * 65
    page.drawText(`Printed field ${index + 1}`, { x, y: y + 22, font, size: 10 })
    const field = form.createTextField(`details-${index}`)
    field.addToPage(page, { x, y, width: 165, height: 18 })
    field.setText(`Sample value ${index + 1}`)
  }
  return new Uint8Array(await pdf.save())
}
