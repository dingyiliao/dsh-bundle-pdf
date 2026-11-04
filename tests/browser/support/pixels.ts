import { type Page as BrowserPage } from 'playwright'
import { expect } from 'vitest'

/** Sample the composited browser image, not just the SVG's declared fill. */
export async function highlightPixels(page: BrowserPage) {
  const png = await page.locator('.dsh-pdf-reader [data-pdf-page="1"]').screenshot()
  return page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(bitmap, 0, 0)
    const pixel = (x: number, y: number) => {
      const data = context.getImageData(Math.floor(x * bitmap.width / 240), Math.floor((160 - y) * bitmap.height / 160), 1, 1).data
      return [data[0], data[1], data[2]]
    }
    const rows = [60, 100].map(y => ({ paper: pixel(190, y), left: pixel(45, y), overlap: pixel(85, y), right: pixel(125, y) }))
    bitmap.close(); canvas.width = 0; canvas.height = 0
    return rows
  }, [...png])
}

/** Sample the raw PDF crop returned by the screenshot action. */
export async function screenshotPagePixels(page: BrowserPage) {
  return page.getByRole('dialog', { name: 'Screenshot preview' }).getByRole('img').evaluate(async element => {
    const image = element as HTMLImageElement
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(image, 0, 0)
    // The drag selected PDF rect [10, 30, 170, 130].
    const pixel = (x: number, y: number) => {
      const data = context.getImageData(Math.floor((x - 10) * canvas.width / 160), Math.floor((130 - y) * canvas.height / 100), 1, 1).data
      return [data[0], data[1], data[2]]
    }
    const rows = [60, 100].map(y => ({ paper: pixel(160, y), left: pixel(45, y), overlap: pixel(85, y), right: pixel(125, y) }))
    canvas.width = 0; canvas.height = 0
    return rows
  })
}

export function expectUniformHighlight(rows: Awaited<ReturnType<typeof highlightPixels>>) {
  for (const row of rows) {
    expect(row.left[1], JSON.stringify(row)).toBeLessThan(row.paper[1] - 20)
    for (const other of [row.overlap, row.right]) {
      expect(Math.max(...row.left.map((channel, index) => Math.abs(channel - other[index]))), JSON.stringify(row))
        .toBeLessThanOrEqual(4)
    }
  }
}

export function expectUnannotatedPage(rows: Awaited<ReturnType<typeof screenshotPagePixels>>) {
  for (const row of rows) for (const sample of [row.left, row.overlap, row.right]) {
    expect(Math.max(...sample.map((channel, index) => Math.abs(channel - row.paper[index]))), JSON.stringify(row))
      .toBeLessThanOrEqual(4)
  }
}
