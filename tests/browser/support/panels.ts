import { PDFDocument, PDFHexString, PDFName, StandardFonts, rgb } from 'pdf-lib'
import { type Page } from 'playwright'

export const FILE_NAME = 'panel-coverage.pdf'

export async function documentBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= 4; number++) {
    const page = document.addPage([1100, 700])
    // A wide colored band exposes any accidental clipping behind the rails.
    page.drawRectangle({ x: 0, y: 310, width: 1100, height: 80, color: rgb(.85, .9, .95) })
    page.drawText(`Coverage page ${number}`, { x: 50, y: 610, size: 20, font })
    if (number !== 1) continue
    const records = [
      { kind: 'Text', text: 'A plain note', rect: [50, 530, 75, 555] },
      { kind: 'Highlight', text: 'A highlighted line', rect: [48, 600, 290, 630] },
      { kind: 'Underline', text: 'An underlined line', rect: [48, 600, 290, 630] },
      { kind: 'StrikeOut', text: 'A struck line', rect: [48, 600, 290, 630] },
    ] as const
    const refs = records.map(({ kind, text, rect }) => document.context.register(document.context.obj({
      Type: 'Annot', Subtype: kind, P: page.ref, Rect: rect,
      Contents: PDFHexString.fromText(text), C: [1, 0.55, 0], F: 4,
      ...(kind === 'Text' ? {} : { QuadPoints: [48, 630, 290, 630, 48, 600, 290, 600] }),
    })))
    page.node.set(PDFName.of('Annots'), document.context.obj(refs))
  }
  return document.save({ useObjectStreams: false })
}

export async function openReader(page: Page, url: string, title: string) {
  await page.goto(url, { waitUntil: 'load' })
  await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
  await page.getByRole('treeitem').filter({ hasText: title }).click()
  const restoredReader = page.locator('.dsh-pdf-reader')
  if (await restoredReader.isVisible()) {
    await restoredReader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    return restoredReader
  }
  const column = page.locator('[data-rightbar-col]')
  const expand = page.locator('[data-sidebar-right-expand]')
  if (await expand.isVisible()) await expand.click()
  await column.locator('[data-sidebar-right-guide-entry="files"]').click()
  await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
  await column.locator('[data-files-reload]').click()
  await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()
  const reader = page.locator('.dsh-pdf-reader')
  await reader.waitFor({ state: 'visible', timeout: 20_000 })
  await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
    .waitFor({ state: 'visible', timeout: 20_000 })
  return reader
}
