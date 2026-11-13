import { expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchPdfBrowser } from '../launch.ts'
import { newEnglishPage, launchWebScaffold, seedSession, watchConsole, ROOT, SESSION } from '../support/scaffold.ts'
import { chooseZoom } from '../support/toolbar.ts'
import { sourcePdf } from '../support/documents.ts'

const FILE = 'low-zoom-selection.pdf'

it('treats zoom below 50% as browse-only and restores text selection at 50%', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Awaited<ReturnType<typeof launchPdfBrowser>> | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-low-zoom-selection')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF low zoom selection' })
    await writeFile(join(scaffold.workspaceCwd, FILE), await sourcePdf())

    browser = await launchPdfBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF low zoom selection' }).click()
    const column = page.locator('[data-rightbar-col]')
    if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    await reader.locator('[data-pdf-page="1"] .dsh-pdf-tile-surface canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await chooseZoom(reader, '100%')
    await expect.poll(() => reader.locator('[data-pdf-page="1"] [data-pdf-text="active"] span[data-pdf-run]').count())
      .toBeGreaterThan(0)

    const selectFirstWord = () => reader.evaluate(element => {
      const span = element.querySelector<HTMLElement>('[data-pdf-page="1"] [data-pdf-text="active"] span[data-pdf-run]')
      if (!span?.firstChild) throw new Error('The page text layer is missing')
      const range = document.createRange()
      range.setStart(span.firstChild, 0)
      range.setEnd(span.firstChild, Math.min(5, span.textContent?.length ?? 0))
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      element.querySelector<HTMLElement>('.dsh-pdf-scroll')!.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
      return selection?.toString() ?? ''
    })
    expect(await selectFirstWord()).not.toBe('')
    const selectionToolbar = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await selectionToolbar.waitFor({ state: 'visible' })

    await reader.evaluate(async element => {
      const target = element.querySelector<HTMLElement>('[data-pdf-page]')!
      const box = target.getBoundingClientRect()
      for (let index = 0; index < 12; index++) {
        target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
          ctrlKey: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, deltaY: 200 }))
        await new Promise<void>(resolve => setTimeout(resolve, 30))
      }
      await new Promise<void>(resolve => setTimeout(resolve, 1200))
    })
    await expect.poll(() => reader.locator('.dsh-pdf-toolbar-zoom summary').getAttribute('aria-label')).toContain('10%')
    expect(await reader.locator('[data-pdf-text="active"]').count()).toBe(0)
    expect(Number(await reader.locator('.dsh-pdf-windowed-pages').getAttribute('data-windowed-page-count'))).toBeLessThanOrEqual(16)
    const semantic = reader.locator('[data-pdf-page="1"] [data-pdf-semantic-text="1"]')
    await expect.poll(() => semantic.textContent()).not.toBe('')
    expect(await semantic.getAttribute('role')).toBe('document')
    await selectionToolbar.waitFor({ state: 'hidden' })
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true)

    await chooseZoom(reader, '50%')
    await expect.poll(() => reader.locator('[data-pdf-page="1"] [data-pdf-text="active"]').count()).toBe(1)
    expect(await selectFirstWord()).not.toBe('')
    await selectionToolbar.waitFor({ state: 'visible' })
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
