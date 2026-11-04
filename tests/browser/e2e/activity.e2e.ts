import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { join } from 'node:path'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { readFile } from 'node:fs/promises'
import { ROOT } from '../support/scaffold.ts'

it('keeps concurrent activity ordered, cancelable, timed, and inside a narrow reader', async () => {
  const bundle = await build({ entryPoints: [join(ROOT, 'tests', 'modules', 'viewer', 'floating-status.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser' })
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
    await page.setContent('<div class="dsh-pdf-reader"><div class="dsh-pdf-body"><div class="dsh-pdf-tool-rail" data-pdf-tool-rail="" id="rail-root"></div><div class="dsh-pdf-content"></div></div></div>')
    await page.addStyleTag({ content: `:root { --dsw-alias-bg-base:#f5f5f5; --dsw-alias-bg-layer-1:#fff; --dsw-alias-label-primary:#222; --dsw-alias-border-l2:#ddd; --dsw-alias-link:#4278ed; } html,body { margin:0; height:100%; } #rail-root > .dsh-pdf-main-toolbar { width:100% !important; height:44px !important; } ${await readFile(join(ROOT, 'src/client/reader.css'), 'utf8')}` })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const reader = page.locator('.dsh-pdf-reader')
    const rail = reader.locator('.dsh-pdf-floating-status-rail')
    const tasks = reader.locator('.dsh-pdf-activity-popover')
    await rail.waitFor({ state: 'attached' })
    const set = (items: { id: string; label: string; actionLabel?: string; durationMs?: number; occurrence?: number;
      tone?: 'progress' | 'success' | 'error' | 'neutral' }[]) => page.evaluate(next => {
      const fixture = (window as typeof window & { __pdfFloatingStatusFixture?: { set(items: typeof next): void } }).__pdfFloatingStatusFixture
      fixture!.set(next)
    }, items)
    await set([{ id: 'save', label: 'Saved', occurrence: 1 }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(1)
    await set([{ id: 'ocr', label: 'Recognizing text' }, { id: 'save', label: 'Saved', occurrence: 1 }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(2)
    const activity = rail.locator('.dsh-pdf-activity-trigger')
    expect(await activity.getAttribute('aria-expanded')).toBe('false')
    await activity.click()
    expect(await tasks.locator('.dsh-pdf-floating-status-content').allTextContents()).toEqual(['Saved', 'Recognizing text'])
    const ocrLayout = await tasks.locator('.dsh-pdf-floating-status').nth(1).evaluate(element => {
      const content = element.querySelector('.dsh-pdf-floating-status-content')!.getBoundingClientRect()
      const action = element.querySelector('button')!.getBoundingClientRect()
      const popover = element.parentElement!.getBoundingClientRect()
      return { contentRight: content.right, actionLeft: action.left, actionRight: action.right, popoverRight: popover.right }
    })
    expect(ocrLayout.actionLeft - ocrLayout.contentRight).toBeGreaterThanOrEqual(8)
    expect(ocrLayout.popoverRight - ocrLayout.actionRight).toBeLessThanOrEqual(16)
    const [first, second] = await Promise.all([tasks.locator('.dsh-pdf-floating-status').nth(0).boundingBox(),
      tasks.locator('.dsh-pdf-floating-status').nth(1).boundingBox()])
    expect(first!.y).toBeLessThan(second!.y)
    const assertActivityColumn = async () => {
      // ReaderPopover follows ResizeObserver with a frame. A viewport resize
      // must settle before checking the final popup geometry.
      await expect.poll(async () => {
        const [bar, popover, owner] = await Promise.all([
          reader.locator('[data-pdf-tool-rail]').boundingBox(), tasks.boundingBox(), reader.boundingBox(),
        ])
        return !!bar && !!popover && !!owner
          && popover.x >= bar.x + bar.width + 7
          && popover.x + popover.width <= owner.x + owner.width - 7
          && popover.y >= owner.y + 7
          && popover.y + popover.height <= owner.y + owner.height - 7
      }).toBe(true)
      const [bar, content, trigger, popover, owner] = await Promise.all([
        reader.locator('[data-pdf-tool-rail]').boundingBox(), reader.locator('.dsh-pdf-content').boundingBox(),
        activity.boundingBox(), tasks.boundingBox(), reader.boundingBox(),
      ])
      expect(bar!.width).toBe(56)
      expect(Math.abs(content!.x - owner!.x)).toBeLessThanOrEqual(1)
      expect(trigger!.x).toBeGreaterThanOrEqual(bar!.x)
      expect(trigger!.x + trigger!.width).toBeLessThanOrEqual(bar!.x + bar!.width)
      expect(trigger!.y).toBeGreaterThanOrEqual(bar!.y)
      expect(trigger!.y + trigger!.height).toBeLessThanOrEqual(bar!.y + bar!.height)
      expect(popover!.x).toBeGreaterThanOrEqual(bar!.x + bar!.width + 7)
      expect(popover!.x + popover!.width).toBeLessThanOrEqual(owner!.x + owner!.width - 7)
      expect(popover!.y).toBeGreaterThanOrEqual(owner!.y + 7)
      expect(popover!.y + popover!.height).toBeLessThanOrEqual(owner!.y + owner!.height - 7)
    }
    await page.setViewportSize({ width: 1000, height: 600 })
    await assertActivityColumn()
    if (process.env.DSH_PDF_FLOATING_PREVIEW_PATH)
      await page.screenshot({ path: process.env.DSH_PDF_FLOATING_PREVIEW_PATH.replace(/\.png$/, '-aligned.png') })
    await page.setViewportSize({ width: 700, height: 600 })
    await assertActivityColumn()
    await page.setViewportSize({ width: 1200, height: 600 })
    await tasks.getByRole('button', { name: 'Cancel ocr' }).click()
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(1)
    expect(await page.evaluate(() => (window as typeof window & { __pdfFloatingStatusFixture?: { presses(): number } }).__pdfFloatingStatusFixture!.presses())).toBe(1)
    await set([{ id: 'save', label: 'Saved', occurrence: 1 }, { id: 'timed', label: 'Temporary', durationMs: 400, occurrence: 1 }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(2)
    await page.waitForTimeout(200)
    await set([{ id: 'save', label: 'Saved', occurrence: 1 }, { id: 'timed', label: 'Temporary again', durationMs: 800, occurrence: 2 }])
    await page.waitForTimeout(300)
    expect(await tasks.locator('.dsh-pdf-floating-status').count()).toBe(2)
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count(), { timeout: 3000 }).toBe(1)
    await page.setViewportSize({ width: 380, height: 600 })
    await set([{ id: 'save', label: 'A long status about a PDF region that must stay readable', occurrence: 1 },
      { id: 'screenshot', label: 'Creating screenshot', occurrence: 1 }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(2)
    await assertActivityColumn()
    const bounds = await tasks.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements.map(element => {
      const { left, right, top } = element.getBoundingClientRect()
      return { left, right, top }
    }))
    const ownerRight = await reader.evaluate(element => element.getBoundingClientRect().right)
    expect(bounds.every(item => item.right <= ownerRight - 7)).toBe(true)
    await assertActivityColumn()
    expect(bounds[0]!.top).toBeLessThan(bounds[1]!.top)
    await page.setViewportSize({ width: 200, height: 600 })
    await assertActivityColumn()
    const tinyBounds = await tasks.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements.map(element => {
      const { left, right } = element.getBoundingClientRect()
      return { left, right }
    }))
    const tinyPopover = (await tasks.boundingBox())!
    expect(tinyBounds.every(item => item.left >= tinyPopover.x && item.right <= tinyPopover.x + tinyPopover.width)).toBe(true)
    await page.setViewportSize({ width: 380, height: 600 })
    if (process.env.DSH_PDF_FLOATING_PREVIEW_PATH) await page.screenshot({ path: process.env.DSH_PDF_FLOATING_PREVIEW_PATH })
    await page.setViewportSize({ width: 1000, height: 600 })
    await set([{ id: 'ocr', label: '正在识别文字…', actionLabel: '取消' }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(1)
    const ocrPopover = await tasks.boundingBox()
    expect(ocrPopover!.width).toBeLessThanOrEqual(300)
    await assertActivityColumn()
    if (process.env.DSH_PDF_FLOATING_PREVIEW_PATH) {
      await page.screenshot({ path: process.env.DSH_PDF_FLOATING_PREVIEW_PATH.replace(/\.png$/, '-ocr.png') })
    }
    await set([{ id: 'ocr', label: 'Working', tone: 'progress' },
      { id: 'saved', label: 'Completed', tone: 'success' }, { id: 'failed', label: 'Failed', tone: 'error' }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(3)
    const colors = await tasks.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements.map(element => {
      const marker = element.querySelector('.dsh-pdf-floating-status-dot, .dsh-pdf-floating-status-spinner')!
      const style = getComputedStyle(marker)
      return marker.classList.contains('dsh-pdf-floating-status-spinner') ? style.borderTopColor : style.backgroundColor
    }))
    expect(colors).toEqual(['rgb(66, 120, 237)', 'rgb(34, 160, 107)', 'rgb(223, 51, 68)'])
  } finally { await browser.close() }
})
