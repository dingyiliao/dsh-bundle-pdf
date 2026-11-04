import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, newEnglishPage, saveFailureShot, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { FILE_NAME, fittedOutlinePdf, outlinedSourcePdf } from '../support/documents.ts'
import { openSidebarSection } from '../support/toolbar.ts'

it('applies real FitV and FitR PDF outline destinations in the browser reader', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-fit-outline-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF Fit outline test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await fittedOutlinePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-fit-outline-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF Fit outline test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await openSidebarSection(reader, 'Bookmarks')
    const pageInput = reader.locator('.dsh-pdf-sidebar').getByRole('textbox', { name: 'Page' })
    const scroll = reader.locator('.dsh-pdf-scroll')
    const zoom = reader.locator('.dsh-pdf-toolbar-zoom > summary')
    const vertical = reader.getByRole('button', { name: 'Fit vertical', exact: true })
    await expect.poll(() => vertical.isEnabled()).toBe(true)
    await vertical.click()
    await expect.poll(() => pageInput.inputValue()).toBe('2')
    await reader.locator('[data-pdf-page="2"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    // A retained raster can already be ready at the old fit-width scale.
    // Wait for the requested geometry and navigation lock, not that old frame.
    const expectedVerticalScale = await scroll.evaluate(element => Math.max(0.1, (element.clientHeight - 32) / 560))
    await expect.poll(async () => ({ idle: await pageInput.isEnabled(), scaleMatches:
      Math.abs(await reader.locator('[data-pdf-page="2"]').evaluate(element => element.getBoundingClientRect().height / 560)
        - expectedVerticalScale) < 0.03 })).toEqual({ idle: true, scaleMatches: true })
    expect(await zoom.getAttribute('aria-label')).toBe(`Zoom: ${Math.round(expectedVerticalScale * 100)}%`)

    const rectangle = reader.getByRole('button', { name: 'Fit rectangle', exact: true })
    await expect.poll(() => rectangle.isEnabled()).toBe(true)
    await rectangle.click()
    await expect.poll(() => pageInput.inputValue()).toBe('3')
    await reader.locator('[data-pdf-page="3"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    const expectedRectangleScale = await scroll.evaluate(element => {
      const style = getComputedStyle(element)
      return Math.max(0.1, Math.min((element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / 300,
        (element.clientHeight - 32) / 310))
    })
    await expect.poll(async () => ({ idle: await pageInput.isEnabled(), scaleMatches:
      Math.abs(await reader.locator('[data-pdf-page="3"]').evaluate(element => element.getBoundingClientRect().height / 560)
        - expectedRectangleScale) < 0.03 })).toEqual({ idle: true, scaleMatches: true })
    expect(await zoom.getAttribute('aria-label')).toBe(`Zoom: ${Math.round(expectedRectangleScale * 100)}%`)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('navigates from the whole built-in bookmark item without hijacking item actions', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-bookmark-rows-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF bookmark rows test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await outlinedSourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-bookmark-rows-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF bookmark rows test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
    await openSidebarSection(reader, 'Bookmarks')
    const sidebarPage = reader.locator('.dsh-pdf-sidebar').getByRole('textbox', { name: 'Page' })
    const scroll = reader.locator('.dsh-pdf-scroll')
    const scrollTop = () => scroll.evaluate(root => root.scrollTop)
    // Opening the auto-collapsed sidebar preserves the reading anchor and can
    // leave a nonzero starting scroll offset at this responsive width.
    // The first canvas can become visible while Reader still has its initial
    // 600px viewport estimate. Wait for Fit width's actual 400×560 page size
    // before capturing the position that Back should restore.
    await expect.poll(() => scroll.evaluate(root => {
      const page = root.querySelector<HTMLElement>('[data-pdf-page="1"]')
      const style = getComputedStyle(root)
      const width = root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      return page ? Math.abs(page.getBoundingClientRect().height - width * 560 / 400) : Infinity
    })).toBeLessThan(2)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    // Establish the document start through the same page field a user uses;
    // opening the sidebar may otherwise leave a preserved, nonzero anchor.
    await sidebarPage.fill('1')
    await sidebarPage.press('Enter')
    await expect.poll(() => sidebarPage.isEnabled()).toBe(true)
    await expect.poll(scrollTop).toBeLessThan(2)
    const originScrollTop = await scrollTop()
    const atOrigin = async () => Math.abs(await scrollTop() - originScrollTop)

    const chapter = reader.locator('.dsh-pdf-bookmark-row').filter({ hasText: 'Chapter 1' }).first()
    await expect.poll(() => chapter.getByRole('button', { name: 'Chapter 1', exact: true }).isEnabled()).toBe(true)
    await expect.poll(() => chapter.evaluate(row => {
      const bounds = row.getBoundingClientRect()
      return row.contains(document.elementFromPoint(bounds.x + 8, bounds.y + bounds.height / 2))
    })).toBe(true)
    const chapterBox = await chapter.boundingBox()
    expect(chapterBox).not.toBeNull()
    // Click the row's own padding, not its independent reorder/expand controls.
    await page.mouse.click(chapterBox!.x + 8, chapterBox!.y + 2)
    // The rail and sidebar determine the fit-width scale. Validate the actual
    // PDF destination, including the browser's document-end clamp, rather than
    // assuming its scroll distance is always more than 200 CSS pixels.
    await expect.poll(() => scroll.evaluate(root => {
      const target = root.querySelector<HTMLElement>('[data-page-number="2"]')!
      const page = target.querySelector<HTMLElement>('[data-pdf-page="2"]')!
      const destination = target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
        + 70 * page.getBoundingClientRect().height / 560 - 16
      const expected = Math.max(0, Math.min(root.scrollHeight - root.clientHeight, destination))
      return Math.abs(root.scrollTop - expected)
    }), { timeout: 20_000 }).toBeLessThan(2)
    await expect.poll(() => sidebarPage.inputValue()).toBe('2')
    await reader.getByRole('button', { name: 'Back', exact: true }).click()
    await expect.poll(atOrigin).toBeLessThan(2)
    await expect.poll(() => sidebarPage.inputValue()).toBe('1')
    await chapter.getByRole('button', { name: 'Expand bookmark section' }).click()
    await reader.getByRole('treeitem', { name: 'Section 1' }).waitFor({ state: 'visible' })
    expect(await atOrigin()).toBeLessThan(2)

    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
