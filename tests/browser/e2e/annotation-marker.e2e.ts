import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { launchPdfBrowser } from '../launch.ts'

it('keeps the page comment marker opaque on hover and press', async () => {
  const css = await readFile(new URL('../../../src/client/reader.css', import.meta.url), 'utf8')
  const browser = await launchPdfBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(`<div class="dsh-pdf-reader" style="height: 100px">
      <button class="dsh-pdf-comment-marker" style="left: 50px; top: 30px" type="button" aria-label="Comment"></button>
    </div>`)
    await page.addStyleTag({ content: `${css}
      :root {
        --dsw-alias-link: #4278ed;
        --dsw-alias-interactive-bg-hover: rgb(38 49 72 / 6%);
        --dsw-alias-interactive-bg-active: rgb(38 49 72 / 12%);
      }
      button:hover { --marker-test-state: hover; }
      button:active { --marker-test-state: active; }` })
    const marker = page.getByRole('button', { name: 'Comment', exact: true })
    const appearance = () => marker.evaluate(element => {
      const style = getComputedStyle(element)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')!
      context.fillStyle = style.backgroundColor
      context.fillRect(0, 0, 1, 1)
      return { alpha: context.getImageData(0, 0, 1, 1).data[3], state: style.getPropertyValue('--marker-test-state').trim() }
    })
    expect(await appearance()).toEqual({ alpha: 255, state: '' })
    await marker.hover()
    expect(await appearance()).toEqual({ alpha: 255, state: 'hover' })
    await page.mouse.down()
    expect(await appearance()).toEqual({ alpha: 255, state: 'active' })
    await page.mouse.up()
  } finally {
    await browser.close()
  }
})
