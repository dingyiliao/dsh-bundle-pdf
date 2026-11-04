import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, newEnglishPage, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchPdfBrowser as browser } from '../launch.ts'
import { FILE_NAME, documentBytes, openReader } from '../support/panels.ts'
import { openSidebarSection } from '../support/toolbar.ts'

it('navigates sidebar and annotation rows by keyboard, then scrolls both axes through the overlay controls', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let opened: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-panel-navigation-e2e')
    await workspace.attachSession(sessionId)
    const title = 'PDF panel navigation test'
    await scaffold.ctx.sessionController.rename({ sessionId, title })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await documentBytes())
    opened = await browser()
    const page = await newEnglishPage(opened)
    const tripwire = watchConsole(page)
    const reader = await openReader(page, scaffold.authenticatedUrl, title)
    await page.locator('[data-sidebar-right-mode="fullscreen"]').click()
    const captureLayout = async (name: string) => {
      const directory = process.env.DSH_PDF_FLOATING_LAYOUT_SCREENSHOT_DIR
      if (directory) { await mkdir(directory, { recursive: true }); await reader.screenshot({ path: join(directory, `${name}.png`) }) }
    }
    // The default right-hand tab is already at the responsive 45% width cap;
    // give this resize exercise enough room to expand without changing the cap.
    await reader.evaluate(element => { (element as HTMLElement).style.width = '850px' })
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const pagesTab = reader.getByRole('tab', { name: 'Pages', exact: true })
    await pagesTab.focus()
    await pagesTab.press('End')
    await expect.poll(() => reader.getByRole('tab', { name: 'OCR', exact: true }).getAttribute('aria-selected')).toBe('true')
    await page.keyboard.press('Home')
    await expect.poll(() => pagesTab.getAttribute('aria-selected')).toBe('true')
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => reader.getByRole('tab', { name: 'Bookmarks', exact: true }).getAttribute('aria-selected')).toBe('true')

    const divider = sidebar.locator('.dsh-pdf-sidebar-divider')
    await expect.poll(async () => Number(await divider.getAttribute('aria-valuemax'))).toBeGreaterThan(330)
    await expect.poll(() => divider.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return element === document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 40)
    })).toBe(true)
    const beforeWidth = (await sidebar.boundingBox())!.width
    const dividerBox = (await divider.boundingBox())!
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 40)
    await page.mouse.down()
    await page.mouse.move(dividerBox.x - 38, dividerBox.y + 40, { steps: 4 })
    await page.mouse.up()
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(beforeWidth + 5)
    await divider.focus()
    await divider.press('Home')
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThanOrEqual(225)
    await divider.press('End')
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(beforeWidth)
    await divider.press('ArrowLeft')
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(beforeWidth)
    await divider.press('ArrowRight')

    await openSidebarSection(reader, 'Annotations')
    const filter = reader.getByRole('combobox', { name: 'Filter annotations' })
    const list = reader.getByRole('list', { name: 'Annotations' })
    await list.waitFor({ state: 'visible' })
    const rows = list.locator('.dsh-pdf-comment-item')
    expect(await reader.locator('.dsh-pdf-annotation-count').innerText()).toBe('4')
    expect(await rows.count()).toBeGreaterThan(0)
    await rows.first().click()
    await filter.selectOption('Highlight')
    await expect.poll(() => rows.count()).toBe(1)
    await filter.selectOption('all')
    await list.focus()
    await page.keyboard.press('End')
    await expect.poll(() => rows.last().evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Home')
    await expect.poll(() => rows.first().evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => rows.nth(1).evaluate(element => element === document.activeElement)).toBe(true)
    await rows.nth(1).evaluate(element => (element as HTMLElement).blur())

    await reader.evaluate(element => { (element as HTMLElement).style.width = '850px' })
    await captureLayout('reader-wide-fit-light')
    const zoom = reader.locator('.dsh-pdf-toolbar-zoom')
    await zoom.locator('summary').click()
    await reader.locator('.dsh-pdf-zoom-menu').getByRole('button', { name: '150%' }).click()
    const scroller = reader.locator('.dsh-pdf-scroll')
    await expect.poll(() => scroller.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(200)
    await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200)
    const vertical = reader.locator('.dsh-pdf-content').getByRole('scrollbar', { name: 'Vertical scrollbar' })
    const horizontal = reader.locator('.dsh-pdf-content').getByRole('scrollbar', { name: 'Horizontal scrollbar' })
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    const [bodyBounds, toolRailBounds, contentBounds, sidebarBounds, scrollBounds, verticalBounds] = await Promise.all([
      reader.locator('.dsh-pdf-body').boundingBox(), reader.locator('[data-pdf-tool-rail]').boundingBox(), reader.locator('.dsh-pdf-content').boundingBox(),
      sidebar.boundingBox(), scroller.boundingBox(), vertical.boundingBox(),
    ])
    expect(bodyBounds).not.toBeNull()
    expect(toolRailBounds).not.toBeNull()
    expect(contentBounds).not.toBeNull()
    expect(sidebarBounds).not.toBeNull()
    expect(scrollBounds).not.toBeNull()
    expect(verticalBounds).not.toBeNull()
    expect(await sidebar.evaluate(element => getComputedStyle(element).position)).toBe('absolute')
    expect(await sidebar.locator('.dsh-pdf-sidebar-toggle').count()).toBe(0)
    expect(toolRailBounds!.width).toBe(56)
    expect(toolRailBounds!.x).toBeGreaterThan(bodyBounds!.x)
    for (const [canvas, label] of [[contentBounds!, 'content'], [scrollBounds!, 'scrollport']] as const) {
      expect(Math.abs(canvas.x - bodyBounds!.x), label).toBeLessThanOrEqual(1)
      expect(Math.abs(canvas.width - bodyBounds!.width), label).toBeLessThanOrEqual(1)
      expect(Math.abs(canvas.y - bodyBounds!.y), label).toBeLessThanOrEqual(1)
      expect(Math.abs(canvas.height - bodyBounds!.height), label).toBeLessThanOrEqual(1)
    }
    expect(sidebarBounds!.x + sidebarBounds!.width).toBeLessThan(bodyBounds!.x + bodyBounds!.width)
    expect((await sidebar.locator('.dsh-pdf-sidebar-rail-shell').boundingBox())!.y).toBeGreaterThan(bodyBounds!.y)
    expect(sidebarBounds!.y + sidebarBounds!.height).toBeLessThan(bodyBounds!.y + bodyBounds!.height)
    expect(await scroller.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)')
    // The scrollbar remains outside the floating rail, so even a large PDF can
    // be dragged along the far-right edge without a sidebar intercepting it.
    expect(verticalBounds!.x).toBeGreaterThan(sidebarBounds!.x + sidebarBounds!.width)
    expect(Math.abs(verticalBounds!.x + verticalBounds!.width - scrollBounds!.x - scrollBounds!.width + 2))
      .toBeLessThanOrEqual(1)
    const pageSurface = reader.locator('[data-pdf-page="1"] .dsh-pdf-tile-surface')
    await expect.poll(() => reader.evaluate(element => {
      const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')!
      const track = element.querySelector('.dsh-pdf-windowed-pages')!.getBoundingClientRect()
      const paper = element.querySelector('[data-pdf-page="1"]')!.getBoundingClientRect()
      const numericLeft = parseFloat(getComputedStyle(scroll).paddingLeft) + (track.width - paper.width) / 2
      const actualLeft = paper.left - scroll.getBoundingClientRect().left + scroll.scrollLeft
      return Math.abs(actualLeft - numericLeft)
    }), { message: 'numeric page-left matches the rendered PDF, without inherited wrapper padding' }).toBeLessThanOrEqual(1)
    const fixedPageWidth = (await pageSurface.boundingBox())!.width
    const expandedGutter = await scroller.evaluate(element => parseFloat(getComputedStyle(element).paddingRight))
    const toggle = sidebar.getByRole('tab', { selected: true })
    await toggle.click()
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(56)
    const collapsedContent = (await reader.locator('.dsh-pdf-content').boundingBox())!
    expect(Math.abs(collapsedContent.x - contentBounds!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(collapsedContent.width - contentBounds!.width)).toBeLessThanOrEqual(1)
    expect(await scroller.evaluate(element => parseFloat(getComputedStyle(element).paddingRight))).toBeLessThan(expandedGutter - 100)
    expect(Math.abs((await pageSurface.boundingBox())!.width - fixedPageWidth)).toBeLessThanOrEqual(1)
    await toggle.click()
    await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - sidebarBounds!.width)).toBeLessThanOrEqual(1)
    expect(Math.abs((await pageSurface.boundingBox())!.width - fixedPageWidth)).toBeLessThanOrEqual(1)

    // At 150%, both paper edges can be scrolled out from under the floating
    // controls. The paper also paints in the gaps alongside those controls;
    // an extra clipping viewport at the safe reading bounds would fail here.
    await scroller.evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0 })
    await expect.poll(async () => (await pageSurface.boundingBox())!.x)
      .toBeGreaterThan(toolRailBounds!.x + toolRailBounds!.width)
    await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth })
    await expect.poll(async () => {
      const paper = (await pageSurface.boundingBox())!, panel = (await sidebar.boundingBox())!
      return paper.x + paper.width <= panel.x
    }).toBe(true)
    const paperBehindRails = await reader.evaluate(element => {
      const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')!
      const paper = element.querySelector<HTMLElement>('[data-pdf-page="1"]')!
      scroll.scrollLeft = (scroll.scrollWidth - scroll.clientWidth) / 2
      const body = element.querySelector('.dsh-pdf-body')!.getBoundingClientRect()
      const left = element.querySelector('[data-pdf-tool-rail]')!.getBoundingClientRect()
      const right = element.querySelector('.dsh-pdf-sidebar')!.getBoundingClientRect()
      const box = paper.getBoundingClientRect(), y = Math.min(body.bottom - 20, box.top + box.height / 2)
      const points = [left.left - 2, right.right + 2]
      return { hits: points.map(x => {
        const hit = document.elementFromPoint(x, y)
        return x > box.left && x < box.right && !!hit && (hit === paper || paper.contains(hit))
      }), points: points.map(x => ({ x, y })) }
    })
    expect(paperBehindRails.hits).toEqual([true, true])
    expect(await reader.evaluate(element => {
      const body = element.querySelector('.dsh-pdf-body')!.getBoundingClientRect()
      const left = element.querySelector('[data-pdf-tool-rail]')!.getBoundingClientRect()
      const right = element.querySelector('.dsh-pdf-sidebar-rail')!.getBoundingClientRect()
      const panel = element.querySelector('.dsh-pdf-sidebar-main')!.getBoundingClientRect()
      return [[left.left + left.width / 2, body.top + 6], [right.left + right.width / 2, body.top + 6],
        [(panel.right + right.left) / 2, body.top + 80]].every(([x, y]) =>
        !!document.elementFromPoint(x!, y!)?.closest('.dsh-pdf-scroll'))
    }), 'transparent top insets and the panel/rail gap pass pointer input to the PDF').toBe(true)
    for (const point of paperBehindRails.points) {
      await expect.poll(async () => {
        const screenshot = await page.screenshot({ clip: { x: Math.floor(point.x), y: Math.floor(point.y), width: 1, height: 1 } })
        const [red, green, blue] = await page.evaluate(async bytes => {
          const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
          const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close()
          return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
        }, [...screenshot])
        return red! < 235 && green! > red! && blue! > green!
      }, { message: 'native PDF pixels paint beyond the safe reading gutters' }).toBe(true)
    }
    await captureLayout('reader-wide-150-light')
    if (process.env.DSH_PDF_FLOATING_LAYOUT_SCREENSHOT_DIR) {
      await reader.evaluate(element => { (element as HTMLElement).style.width = '500px' })
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
      await captureLayout('reader-narrow-150-light')
      const theme = await page.locator('body').getAttribute('data-ds-dark-theme')
      await page.locator('body').evaluate(element => element.setAttribute('data-ds-dark-theme', ''))
      await captureLayout('reader-narrow-150-dark')
      await page.locator('body').evaluate((element, value) => {
        if (value === null) element.removeAttribute('data-ds-dark-theme'); else element.setAttribute('data-ds-dark-theme', value)
      }, theme)
      await reader.evaluate(element => { (element as HTMLElement).style.width = '850px' })
      await toggle.click()
      await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - sidebarBounds!.width)).toBeLessThanOrEqual(1)
    }
    await scroller.evaluate(element => { element.scrollLeft = 0 })
    await vertical.focus()
    await page.keyboard.press('End')
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(200)
    await page.keyboard.press('Home')
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0)
    await page.keyboard.press('PageDown')
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    await page.keyboard.press('PageUp')
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(40)
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0)
    await page.keyboard.press('Space')
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    await page.keyboard.press('Shift+Space')
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0)
    await horizontal.focus()
    await page.keyboard.press('End')
    await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(200)
    await page.keyboard.press('Home')
    await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBe(0)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBe(40)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBe(0)
    await horizontal.evaluate(element => element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE,
    })))
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await vertical.evaluate(element => element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE,
    })))
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    const verticalDragBounds = (await vertical.boundingBox())!
    await page.mouse.move(verticalDragBounds.x + verticalDragBounds.width / 2, verticalDragBounds.y + 10)
    await page.mouse.down()
    await expect.poll(() => reader.locator('.dsh-pdf-content .dsh-pdf-scrollbars.is-dragging').count()).toBe(1)
    await page.mouse.move(verticalDragBounds.x + verticalDragBounds.width / 2,
      verticalDragBounds.y + verticalDragBounds.height - 10, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => reader.locator('.dsh-pdf-content .dsh-pdf-scrollbars.is-dragging').count()).toBe(0)
    // Pinch-to-zoom follows the mounted page under the pointer and commits a
    // document-local scale; it must not zoom the surrounding Harness window.
    const zoomBeforeGesture = await zoom.locator('summary').getAttribute('aria-label')
    const mountedPage = reader.locator('[data-pdf-page]').last()
    await mountedPage.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        ctrlKey: true, deltaY: -80, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 }))
    })
    await expect.poll(() => zoom.locator('summary').getAttribute('aria-label')).not.toBe(zoomBeforeGesture)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await opened?.close()
    await scaffold.close()
  }
}, 90_000)
