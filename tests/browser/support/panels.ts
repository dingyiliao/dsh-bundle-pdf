import { type Page } from 'playwright'
import { pdfDict, pdfHex, plainPdf } from '../../fixtures/pdf-fixture-kit.ts'

export const FILE_NAME = 'panel-coverage.pdf'

export async function documentBytes(): Promise<Uint8Array> {
  const records = [
    ['Text', 'A plain note'], ['Highlight', 'A highlighted line'], ['Underline', 'An underlined line'], ['StrikeOut', 'A struck line'],
  ] as const
  return plainPdf(Array.from({ length: 4 }, (_, index) => ({ size: [1100, 700] as const,
    lines: [{ text: `Coverage page ${index + 1}`, x: 50, y: 610, size: 20 }],
    annotationObjects: index === 0 ? records.map(([kind, text]) => pdfDict({ Type: '/Annot', Subtype: `/${kind}`, Rect: '[50 530 290 630]', Contents: pdfHex(text), C: '[1 0.55 0]', F: '4' })) : undefined,
  })))
}

export async function openReader(page: Page, url: string, title: string) {
  await page.goto(url, { waitUntil: 'load' })
  await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
  await page.getByRole('treeitem').filter({ hasText: title }).click()
  const restoredReader = page.locator('.dsh-pdf-reader')
  if (await restoredReader.isVisible()) {
    await restoredReader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
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
  await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
  return reader
}
