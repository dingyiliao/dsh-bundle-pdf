import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, newEnglishPage, saveFailureShot, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { build } from 'esbuild'
import { ANNOTATION_FILE_NAME, LARGE_FILE_NAME, LARGE_PAGE_COUNT, LONG_ANNOTATION_FILE_NAME, LONG_ANNOTATION_PAGE_COUNT, LONG_ANNOTATION_SOURCE, LONG_ANNOTATION_TARGET, WIDE_NOTE_FILE_NAME, WIDE_NOTE_PAGE, distantHighlightPdf, longHighlightPdf, manyPageSourcePdf, widePageWithNotePdf } from '../support/documents.ts'
import { chooseZoom, expectFloatingToolRails, openSidebarSection } from '../support/toolbar.ts'

it('renders a distant note page when a wide PDF leaves it outside the horizontal viewport', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-wide-note-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF wide note test' })
    await writeFile(join(scaffold.workspaceCwd, WIDE_NOTE_FILE_NAME), await widePageWithNotePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-wide-note-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF wide note test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: WIDE_NOTE_FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await chooseZoom(reader, '100%')
    const scroll = reader.locator('.dsh-pdf-scroll')
    await expect.poll(() => scroll.evaluate(root => root.scrollWidth)).toBeGreaterThan(3000)
    await scroll.evaluate(root => { root.scrollTop = 0; root.scrollLeft = 0 })
    await reader.locator('[data-pdf-page="1"]').waitFor({ state: 'attached' })
    await openSidebarSection(reader, 'Annotations')
    const note = reader.locator('.dsh-pdf-comments .dsh-pdf-comment-item').filter({ hasText: 'Narrow-page note' })
    await note.waitFor({ state: 'visible' })
    await note.click()

    const target = reader.locator(`[data-pdf-page="${WIDE_NOTE_PAGE}"]`)
    await target.waitFor({ state: 'attached', timeout: 10_000 })
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    await expect.poll(() => reader.locator('.dsh-pdf-toolbar-zoom > summary').getAttribute('aria-disabled')).toBe('false')
    await expect.poll(() => scroll.evaluate(root => root.scrollLeft)).toBeGreaterThan(1000)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('virtualizes annotation rows while keeping filters and heading fixed through scrolling and excerpt revisits', async () => {
  const bundle = await build({
    entryPoints: [join(ROOT, 'tests', 'modules', 'viewer', 'annotation-list.web.fixture.tsx')], bundle: true, write: false,
    platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  })
  const css = await readFile(join(ROOT, 'src', 'client', 'reader.css'), 'utf8')
  const sidebarCss = await readFile(join(ROOT, 'src', 'client', 'reading-sidebar.css'), 'utf8')
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent(`<style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}
      :root{--dsw-alias-bg-base:#f4f5f7;--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#222;
      --dsw-alias-label-secondary:#666;--dsw-alias-border-l2:#ddd;--dsw-alias-link:#1765c0}
      #root>.dsh-pdf-reader{height:900px}.dsh-pdf-comments{width:320px;right:auto}
      ${css}${sidebarCss}</style><div id="root"></div>`)
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const panel = page.locator('.dsh-pdf-panel-scroll')
    const rows = page.locator('.dsh-pdf-comment-item')
    await rows.first().waitFor()
    const heading = page.locator('.dsh-pdf-annotations-heading')
    const headingBox = await heading.boundingBox()
    const scrollBox = await panel.boundingBox()
    expect(headingBox && scrollBox).toBeTruthy()
    expect(Math.abs(headingBox!.y + headingBox!.height - scrollBox!.y)).toBeLessThan(1)
    expect(await panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    expect(await rows.count()).toBeLessThan(20)

    const filters = page.getByRole('combobox', { name: 'Filter annotations' })
    const filterBox = await filters.boundingBox()
    expect(filterBox && filterBox.y < scrollBox!.y).toBeTruthy()
    await panel.evaluate(element => { element.scrollTop = 2500 })
    await expect.poll(async () => Number(await rows.first().getAttribute('data-annotation-index'))).toBeGreaterThan(20)
    expect(await rows.count()).toBeLessThan(20)
    expect((await heading.boundingBox())!.y).toBe(headingBox!.y)
    expect((await filters.boundingBox())!.y).toBe(filterBox!.y)

    await panel.evaluate(element => { element.scrollTop = 0 })
    await expect.poll(() => rows.first().getAttribute('data-annotation-index')).toBe('0')
    await rows.first().focus()
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-annotation-index'))).toBe('0')
    await panel.hover()
    await page.mouse.wheel(0, 100_000)
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(70_000)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-annotation-index'))).toBe('0')
    expect(await rows.count()).toBeLessThan(20)
    await page.keyboard.press('End')
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-annotation-index'))).toBe('999')

    await page.evaluate(() => (window as any).annotationListProbe.setMode('multi-page-notes'))
    await panel.evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.getByText('Page 12', { exact: true }).waitFor()
    // The previously focused row remains mounted outside the visible window.
    expect(await rows.count()).toBeLessThanOrEqual(21)

    await page.evaluate(() => (window as any).annotationListProbe.setMode('highlights'))
    await panel.evaluate(element => { element.scrollTop = 0 })
    await page.getByText('Target phrase', { exact: true }).first().waitFor()
    const reads = () => page.evaluate(() => (window as any).annotationListProbe.reads as number[])
    await expect.poll(async () => (await reads()).filter(value => value === 1).length).toBe(1)
    await panel.evaluate(element => { element.scrollTop = 1400 })
    await expect.poll(async () => (await reads()).filter(value => value === 2).length).toBe(1)
    // Flush the negative excerpt cache for page 2 before evicting its group.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await panel.evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.getByText('Page 12', { exact: true }).waitFor()
    await panel.evaluate(element => { element.scrollTop = 0 })
    await page.getByText('Target phrase', { exact: true }).first().waitFor()
    await panel.evaluate(element => { element.scrollTop = 1400 })
    await page.getByText('Page 2', { exact: true }).waitFor()
    expect((await reads()).filter(value => value === 1).length).toBe(1)
    expect((await reads()).filter(value => value === 2).length).toBe(1)
    expect(errors).toEqual([])
  } finally { await browser.close() }
}, 40_000)

it('renders a distant highlight after navigating from the Annotations sidebar', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-annotation-jump-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF annotation jump test' })
    await writeFile(join(scaffold.workspaceCwd, ANNOTATION_FILE_NAME), await distantHighlightPdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-annotation-jump-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF annotation jump test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: ANNOTATION_FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await chooseZoom(reader, '100%')
    const scroll = reader.locator('.dsh-pdf-scroll')
    await expect.poll(() => scroll.evaluate(root => root.scrollWidth)).toBeGreaterThan(3000)
    await scroll.evaluate(root => { root.scrollTop = 0; root.scrollLeft = 0 })
    await openSidebarSection(reader, 'Annotations')
    const annotation = reader.locator('.dsh-pdf-comments .dsh-pdf-comment-item').filter({ hasText: 'Distant highlight' })
    await annotation.waitFor({ state: 'visible' })
    await annotation.click()

    const target = reader.locator(`[data-pdf-page="${WIDE_NOTE_PAGE}"]`)
    await target.waitFor({ state: 'attached', timeout: 10_000 })
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    await expect.poll(() => reader.locator('.dsh-pdf-toolbar-zoom > summary').getAttribute('aria-disabled')).toBe('false')
    const commentCard = reader.locator('.dsh-pdf-page-comment-card')
    const selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await selectedToolbar.waitFor({ state: 'visible' })
    await commentCard.waitFor({ state: 'visible' })
    expect(await commentCard.getByText('Distant highlight', { exact: true }).count()).toBe(1)
    expect(await commentCard.getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    await commentCard.getByRole('button', { name: 'Add comment' }).click()
    await expect.poll(() => commentCard.getByRole('textbox', { name: 'Comment' }).evaluate(element => element === document.activeElement)).toBe(true)
    await commentCard.getByRole('textbox', { name: 'Comment' }).fill('Temporary question')
    await commentCard.getByRole('button', { name: 'Cancel' }).click()
    expect(await commentCard.getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    expect(await commentCard.getByText('Distant highlight', { exact: true }).count()).toBe(1)
    await selectedToolbar.getByLabel('Selected annotation color').fill('#ff0000')
    await expect.poll(() => reader.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(true)
    await selectedToolbar.waitFor({ state: 'visible' })
    await selectedToolbar.getByRole('button', { name: 'Deselect' }).click()
    await commentCard.waitFor({ state: 'hidden' })
    await reader.getByRole('button', { name: 'Back', exact: true }).click()
    await expect.poll(() => scroll.evaluate(root => root.scrollTop)).toBeLessThan(20)
    await target.waitFor({ state: 'detached' })
    await annotation.click()
    await target.waitFor({ state: 'attached', timeout: 10_000 })
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    await expect.poll(() => reader.locator('.dsh-pdf-toolbar-zoom > summary').getAttribute('aria-disabled')).toBe('false')
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('jumps from a distant page to a highlight in a book-length PDF', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-long-annotation-jump-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF long annotation jump test' })
    await writeFile(join(scaffold.workspaceCwd, LONG_ANNOTATION_FILE_NAME), await longHighlightPdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-long-annotation-jump-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF long annotation jump test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: LONG_ANNOTATION_FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    const input = reader.locator('.dsh-pdf-sidebar').getByRole('textbox', { name: 'Page' })
    await input.fill(String(LONG_ANNOTATION_SOURCE))
    await input.press('Enter')
    // 1151-page layout + native raster can exceed 20 s under the instrumented
    // coverage build; this is a readiness timeout, not a relaxed assertion.
    await reader.locator(`[data-pdf-page="${LONG_ANNOTATION_SOURCE}"] canvas[data-pdf-raster-ready="true"]`).first()
      .waitFor({ state: 'visible', timeout: 60_000 })
    // Keep zoom=1 while fit width computes a different effective scale. A
    // previous jump used to rebuild the 1151-page layout and restore its old anchor.
    await chooseZoom(reader, '100%')
    await chooseZoom(reader, 'Fit width')
    await openSidebarSection(reader, 'Annotations')
    await reader.locator('.dsh-pdf-comments .dsh-pdf-comment-item').filter({ hasText: 'Distant book highlight' }).click()

    const target = reader.locator(`[data-pdf-page="${LONG_ANNOTATION_TARGET}"]`)
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 60_000 })
    await expect.poll(() => input.inputValue()).toBe(String(LONG_ANNOTATION_TARGET))
    await expect.poll(() => target.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const root = element.closest('.dsh-pdf-scroll')?.getBoundingClientRect()
      return !!root && box.bottom > root.top && box.top < root.bottom && box.right > root.left && box.left < root.right
    })).toBe(true)
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 150_000)

it('renders an annotation destination after scrolling deep into a book-length PDF', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-scrolled-annotation-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF scrolled annotation test' })
    await writeFile(join(scaffold.workspaceCwd, LONG_ANNOTATION_FILE_NAME), await longHighlightPdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-scrolled-annotation-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF scrolled annotation test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: LONG_ANNOTATION_FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await openSidebarSection(reader, 'Annotations')
    const scroll = reader.locator('.dsh-pdf-scroll')
    const input = reader.locator('.dsh-pdf-sidebar').getByRole('textbox', { name: 'Page' })
    await reader.locator('.dsh-pdf-windowed-pages').waitFor({ state: 'attached', timeout: 20_000 })
    // A mounted virtual-page container may still use Reader's initial 600px
    // estimate. Scroll only after ResizeObserver has committed Fit width for
    // the actual viewport; otherwise its total height can change mid-scroll
    // and the requested distant page never enters the rendered window.
    await expect.poll(() => scroll.evaluate(root => {
      const stage = root.querySelector<HTMLElement>('[data-page-number="1"] .dsh-pdf-page-stage')
      const style = getComputedStyle(root)
      return stage ? Math.abs(stage.getBoundingClientRect().width
        - (root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))) : Infinity
    }), { timeout: 20_000 }).toBeLessThan(2)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await scroll.evaluate((root, { source, count }) => {
      const pages = root.querySelector<HTMLElement>('.dsh-pdf-windowed-pages')
      if (!pages) throw new Error('Book layout is not ready')
      root.scrollTop = pages.offsetHeight * (source - 0.5) / count
    }, { source: LONG_ANNOTATION_SOURCE, count: LONG_ANNOTATION_PAGE_COUNT })
    const source = reader.locator(`[data-pdf-page="${LONG_ANNOTATION_SOURCE}"]`)
    await source.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => input.inputValue(), { timeout: 10_000 }).toBe(String(LONG_ANNOTATION_SOURCE))

    await reader.locator('.dsh-pdf-comments .dsh-pdf-comment-item')
      .filter({ hasText: 'Distant book highlight' }).first().click()
    const target = reader.locator(`[data-pdf-page="${LONG_ANNOTATION_TARGET}"]`)
    await target.locator('.dsh-pdf-tile-surface').waitFor({ state: 'visible', timeout: 20_000 })
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => input.inputValue()).toBe(String(LONG_ANNOTATION_TARGET))
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    await expect.poll(() => target.evaluate(element => {
      const root = element.closest('.dsh-pdf-scroll')?.getBoundingClientRect()
      if (!root) return false
      return [...element.querySelectorAll<HTMLCanvasElement>('canvas[data-pdf-raster-ready="true"]')].some(canvas => {
        const box = canvas.getBoundingClientRect()
        if (box.bottom <= root.top || box.top >= root.bottom || box.right <= root.left || box.left >= root.right) return false
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return false
        const left = Math.max(0, Math.floor((Math.max(box.left, root.left) - box.left) * canvas.width / box.width))
        const top = Math.max(0, Math.floor((Math.max(box.top, root.top) - box.top) * canvas.height / box.height))
        const right = Math.min(canvas.width, Math.ceil((Math.min(box.right, root.right) - box.left) * canvas.width / box.width))
        const bottom = Math.min(canvas.height, Math.ceil((Math.min(box.bottom, root.bottom) - box.top) * canvas.height / box.height))
        if (right <= left || bottom <= top) return false
        const pixels = context.getImageData(left, top, right - left, bottom - top).data
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 100 && Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 180) return true
        }
        return false
      })
    }), { timeout: 20_000 }).toBe(true)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 150_000)

it('keeps active pages bounded while navigating to a distant page through the installed Web plugin', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.name === '@dylanl1/dsh-plugin-pdf')
    expect(entry?.fiber?.state).toBe(2)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-many-pages-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF many pages test' })
    await writeFile(join(scaffold.workspaceCwd, LARGE_FILE_NAME), await manyPageSourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-many-pages-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF many pages test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: LARGE_FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 }).catch(async failure => {
      throw new Error(`${String(failure)}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 1')
    expect(await reader.locator('.dsh-pdf-page').count()).toBeLessThan(20)

    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const pageInput = sidebar.getByRole('textbox', { name: 'Page' })
    expect(await pageInput.isVisible()).toBe(true)
    expect(await toolbar.getByRole('textbox', { name: 'Page' }).count()).toBe(0)
    await openSidebarSection(reader, 'Pages')
    await expect.poll(() => sidebar.getByRole('tab', { selected: true }).getAttribute('aria-expanded')).toBe('true')
    // Let fit-width consume the new PDF column width before starting a jump.
    await reader.locator('.dsh-pdf-scroll').evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await pageInput.fill('115')
    await pageInput.press('Enter')
    await reader.locator('[data-pdf-page="115"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 }).catch(async failure => {
        const state = await reader.evaluate(element => {
          const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
          const input = element.querySelector<HTMLInputElement>('.dsh-pdf-sidebar-page-nav input')
          return {
            sidebar: element.querySelector('.dsh-pdf-sidebar')?.className,
            input: input?.value, disabled: input?.disabled,
            scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight,
            scrollWidth: scroll?.clientWidth,
            pages: [...element.querySelectorAll<HTMLElement>('[data-page-number]')]
              .slice(0, 12).map(page => ({ page: page.dataset.pageNumber, top: page.getBoundingClientRect().top })),
            error: element.querySelector('.dsh-pdf-error')?.textContent,
          }
        })
        throw new Error(`${String(failure)}\nReader state: ${JSON.stringify(state)}\nPage errors: ${tripwire.pageErrors.join('\n')}`)
      })
    await reader.locator('.dsh-pdf-scroll').evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await expect.poll(() => pageInput.inputValue(), { timeout: 10_000 }).toBe('115').catch(async failure => {
      const state = await reader.evaluate(element => ({
        sidebar: element.querySelector('.dsh-pdf-sidebar')?.className,
        inputs: [...element.querySelectorAll<HTMLInputElement>('.dsh-pdf-sidebar-page-nav input')]
          .map(input => ({ value: input.value, disabled: input.disabled, visible: input.getClientRects().length > 0 })),
        error: element.querySelector('.dsh-pdf-error')?.textContent,
        scrollTop: element.querySelector('.dsh-pdf-scroll')?.scrollTop,
        current: [...element.querySelectorAll<HTMLElement>('[aria-current="page"]')]
          .map(node => node.getAttribute('aria-label')),
      }))
      throw new Error(`${String(failure)}\nReader state: ${JSON.stringify(state)}`)
    })
    await expect.poll(() => reader.getByRole('button', { name: `Page 115 / ${LARGE_PAGE_COUNT}` }).getAttribute('aria-current'))
      .toBe('page')
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 115')
    // Choosing a non-adjacent stop returns directly to it and drops every skipped stop.
    await pageInput.fill('64')
    await pageInput.press('Enter')
    await expect.poll(() => pageInput.inputValue()).toBe('64')
    await toolbar.getByRole('button', { name: 'Back history' }).click()
    const historyMenu = reader.getByTestId('pdf-back-history')
    expect(await historyMenu.getByRole('button', { name: 'Return to page 115', exact: true }).count()).toBe(1)
    await historyMenu.getByRole('button', { name: 'Return to page 1', exact: true }).click()
    await expect.poll(() => pageInput.inputValue()).toBe('1')
    expect(await toolbar.getByRole('button', { name: 'Back', exact: true }).isDisabled()).toBe(true)

    await pageInput.fill(String(LARGE_PAGE_COUNT))
    await pageInput.press('Enter')
    await reader.locator(`[data-pdf-page="${LARGE_PAGE_COUNT}"] canvas`).first().waitFor({ state: 'visible', timeout: 20_000 })
    expect(await reader.locator('.dsh-pdf-tile-surface').count()).toBeGreaterThan(0)
    expect(await reader.locator('[data-page-number]').count()).toBeLessThan(20)
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain(`Browser PDF page ${LARGE_PAGE_COUNT}`)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-page').count()).toBeLessThan(20)
    await expect.poll(() => reader.locator('[data-pdf-page="1"]').count()).toBe(0)

    const originalSizing = await reader.getAttribute('style')
    try {
      await reader.evaluate(element => { (element as HTMLElement).style.width = '320px' })
      await expectFloatingToolRails(reader)
      const directBack = toolbar.locator('.dsh-pdf-toolbar-back-split').getByRole('button', { name: 'Back', exact: true })
      expect(await directBack.isVisible()).toBe(true)
      await directBack.click()
    } finally {
      await reader.evaluate((element, style) => {
        if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style)
      }, originalSizing)
    }
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 1')
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-page').count()).toBeLessThan(20)

    // Select across two visible PDF text layers. A DOM Range avoids relying on
    // platform-specific drag speed while exercising Reader's keyup capture path.
    await expect.poll(() => reader.locator('[data-pdf-page="2"] [data-pdf-text="active"]').textContent())
      .toContain('Browser PDF page 2')
    // Returning from the distant page and restoring the fit-width viewport can
    // leave text layers in their 64ms resize debounce. Creating a native Range
    // during that window lets the next text-layer replacement invalidate its
    // end point just as the selection is being pinned for virtualization.
    await expect.poll(() => reader.evaluate(element => [1, 2].every(pageNumber => {
      const page = element.querySelector<HTMLElement>(`[data-pdf-page="${pageNumber}"]`)
      const text = page?.querySelector<HTMLElement>('[data-pdf-text="active"]')
      return !!text?.childNodes.length && text.style.transform === ''
        && !!page?.querySelector('canvas[data-pdf-raster-ready="true"]')
    }))).toBe(true)
    await reader.locator('.dsh-pdf-scroll').evaluate(() => new Promise<void>((resolve, reject) => {
      let previous = '', stableFrames = 0
      const deadline = performance.now() + 5_000
      const check = () => {
        if (performance.now() > deadline) {
          reject(new Error('PDF text layers did not settle after restoring fit width'))
          return
        }
        const pages = [1, 2].map(pageNumber => {
          const page = document.querySelector<HTMLElement>(`.dsh-pdf-reader [data-pdf-page="${pageNumber}"]`)
          const text = page?.querySelector<HTMLElement>('[data-pdf-text="active"]')
          const bounds = page?.getBoundingClientRect()
          return { signature: `${bounds?.width}:${bounds?.height}:${text?.style.transform}:${text?.textContent?.length}`,
            stable: !!text && text.style.transform === '' }
        })
        const current = pages.map(page => page.signature).join('|')
        stableFrames = pages.every(page => page.stable) && current === previous ? stableFrames + 1 : 0
        previous = current
        if (stableFrames >= 8) resolve()
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    }))
    const selectedText = await reader.evaluate(element => {
      const firstLayer = element.querySelector('[data-pdf-page="1"] .dsh-pdf-text-layer')
      const secondLayer = element.querySelector('[data-pdf-page="2"] .dsh-pdf-text-layer')
      const first = firstLayer?.querySelector('span[data-pdf-run]')?.firstChild
      const second = secondLayer?.querySelector('span[data-pdf-run]:last-of-type')?.firstChild
      const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
      if (!first || !second || !scroll) throw new Error('Both PDF text layers must be mounted')
      const range = document.createRange()
      range.setStart(first, 0)
      range.setEnd(second, second.textContent?.length ?? 0)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
      return selection?.toString() ?? ''
    })
    expect(selectedText).toContain('Browser PDF page 1')
    expect(selectedText).toContain('Browser PDF page 2')
    const selectionToolbar = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await selectionToolbar.waitFor({ state: 'visible' })

    // The selected pages leave the viewport but keep their live text nodes and
    // native range; otherwise a cross-page selection is lost on virtualization.
    await reader.locator('.dsh-pdf-scroll').evaluate((scroll, count) => {
      const windowed = scroll.querySelector<HTMLElement>('.dsh-pdf-windowed-pages')
      if (windowed) { scroll.scrollTop = windowed.offsetHeight / count * 5; return }
      const destination = scroll.querySelector<HTMLElement>(':scope > [data-page-number="6"]')
      if (!destination) throw new Error('Missing page-six scroll slot')
      scroll.scrollTop = destination.offsetTop
    }, LARGE_PAGE_COUNT)
    await reader.locator('[data-pdf-page="6"]').waitFor({ state: 'attached' })
    await expect.poll(() => reader.locator('[data-pdf-page="1"]').evaluate(element => {
      const viewport = element.closest('.dsh-pdf-scroll')!.getBoundingClientRect()
      return element.getBoundingClientRect().bottom < viewport.top
    })).toBe(true)
    expect(await reader.locator('[data-pdf-page="1"] [data-pdf-text="active"]').textContent())
      .toContain('Browser PDF page 1')
    expect(await reader.locator('[data-pdf-page="2"] [data-pdf-text="active"]').textContent())
      .toContain('Browser PDF page 2')
    const preservedText = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(preservedText).toContain('Browser PDF page 1')
    expect(preservedText).toContain('Browser PDF page 2')
    expect(await reader.locator('.dsh-pdf-page').count()).toBeLessThan(20)

    // Page navigation stays in the sidebar in either width, and malformed
    // drafts never navigate or remain visible after submission.
    const pageBeforeInvalid = await pageInput.inputValue()
    await pageInput.fill(String(LARGE_PAGE_COUNT + 1))
    await pageInput.press('Enter')
    await expect.poll(() => pageInput.inputValue()).toBe(pageBeforeInvalid)
    await pageInput.fill('')
    await pageInput.press('Enter')
    await expect.poll(() => pageInput.inputValue()).toBe(pageBeforeInvalid)
    await sidebar.getByRole('tab', { selected: true }).click()
    expect(await sidebar.evaluate(element => element.classList.contains('is-collapsed'))).toBe(true)
    const compactPageInput = sidebar.getByRole('textbox', { name: 'Page' })
    expect(await compactPageInput.isVisible()).toBe(true)
    await compactPageInput.fill('2')
    await compactPageInput.press('Enter')
    await expect.poll(() => compactPageInput.inputValue()).toBe('2')
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 2')
    await compactPageInput.fill('1')
    await compactPageInput.press('Enter')
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 1')

    // Search the actual 128-page document, including pages outside the
    // virtualized viewport. A long scan must yield without losing results.
    await sidebar.getByRole('tab', { selected: true }).click()
    await openSidebarSection(reader, 'Search')
    const searchPanel = reader.locator('.dsh-pdf-search-panel')
    await searchPanel.getByRole('textbox', { name: 'Search' }).fill('Browser PDF page')
    await searchPanel.locator('form button').click()
    await expect.poll(() => searchPanel.locator('.dsh-pdf-search-hit').count(), { timeout: 40_000 }).toBe(4)
    expect(await searchPanel.locator('.dsh-pdf-search-hit').allTextContents())
      .toEqual(expect.arrayContaining([expect.stringContaining(`page ${LARGE_PAGE_COUNT}`)]))

    // The PDF's own named page actions also work through the keyboard-accessible
    // link controls, without relying on pixel-precise clicks on rendered text.
    await reader.locator('[data-pdf-page="1"] .dsh-pdf-keyboard-links button').first().focus()
    await page.keyboard.press('Enter')
    await reader.locator(`[data-pdf-page="${LARGE_PAGE_COUNT}"] canvas[data-pdf-raster-ready="true"]`).first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain(`Browser PDF page ${LARGE_PAGE_COUNT}`)
    await reader.locator(`[data-pdf-page="${LARGE_PAGE_COUNT}"] .dsh-pdf-keyboard-links button`).first().focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => pageInput.inputValue(), { timeout: 20_000 }).toBe('1')

    // A focused page field is not necessarily an unfinished edit. After a
    // committed jump, simply focusing it must not pin the old page on scroll.
    await openSidebarSection(reader, 'Pages')
    await pageInput.fill('81')
    await pageInput.press('Enter')
    await reader.locator('.dsh-pdf-windowed-pages > [data-page-number="81"]').waitFor({ state: 'attached', timeout: 20_000 })
    await expect.poll(() => pageInput.getAttribute('title')).toBe(`81 / ${LARGE_PAGE_COUNT}`)
    // The title updates as soon as page 81 becomes current, while the jump
    // still disables the input until navigation has fully settled.
    await expect.poll(() => pageInput.isEnabled()).toBe(true)
    await pageInput.focus()
    expect(await pageInput.evaluate(input => input === document.activeElement)).toBe(true)
    await reader.locator('.dsh-pdf-scroll').evaluate(scroll => {
      const source = scroll.querySelector<HTMLElement>('.dsh-pdf-windowed-pages > [data-page-number="81"]')
      if (!source) throw new Error('Page 81 is not mounted')
      // offsetHeight rounds each page to integer CSS pixels. Multiplying that
      // rounded value by 57 pages can land on the preceding page; DOMRects
      // retain the same fractional geometry used by the windowed layout.
      const bounds = source.getBoundingClientRect()
      scroll.scrollTop = bounds.top - scroll.getBoundingClientRect().top + scroll.scrollTop
        - (81 - 24) * bounds.height
      scroll.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => pageInput.getAttribute('title'), { timeout: 20_000 }).toBe(`24 / ${LARGE_PAGE_COUNT}`)
    await expect.poll(() => pageInput.inputValue()).toBe('24')
    await expect.poll(() => reader.getByRole('button', { name: `Page 24 / ${LARGE_PAGE_COUNT}` }).getAttribute('aria-current'))
      .toBe('page')

    // A real wheel event must also release a prior explicit destination while
    // leaving the committed page-number field focused and synchronized.
    const pageStride = await reader.locator('.dsh-pdf-windowed-pages > [data-page-number="24"]')
      .evaluate(element => element.getBoundingClientRect().height)
    await reader.locator('.dsh-pdf-scroll').hover()
    await page.mouse.wheel(0, pageStride * 2)
    await expect.poll(() => pageInput.inputValue()).toBe('26')
    await page.mouse.wheel(0, -pageStride * 2)
    await expect.poll(() => pageInput.inputValue()).toBe('24')

    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)
