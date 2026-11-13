import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { launchPdfBrowser } from '../launch.ts'
import { LARGE_PAGE_COUNT, manyPageSourcePdf } from '../support/documents.ts'
import { FILE_NAME, openReader } from '../support/panels.ts'
import { launchWebScaffold, ROOT, saveFailureShot, seedSession, SESSION, watchConsole } from '../support/scaffold.ts'
import { openSidebarSection } from '../support/toolbar.ts'

const readyCanvas = 'canvas[data-pdf-raster-ready="true"]'
const nativePageWidth = 400 // manyPageSourcePdf uses a 400 × 560 page.
const previewDpr = .75

function paintedAtDpr(surface: Locator, expectedDpr: number) {
  return surface.evaluate((element, { expectedDpr, nativePageWidth, readyCanvas }) => {
    const width = element.getBoundingClientRect().width
    const canvases = [...element.querySelectorAll<HTMLCanvasElement>(readyCanvas)]
    return width > 0 && canvases.length > 0 && canvases.every(canvas =>
      canvas.width > 0 && canvas.height > 0
      && Math.abs(Number(canvas.dataset.pdfRasterScale) * nativePageWidth - expectedDpr * width) <= 2)
  }, { expectedDpr, nativePageWidth, readyCanvas })
}

function paintFrames(page: Page) {
  return page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

function visiblePages(scroller: Locator) {
  return scroller.evaluate(element => {
    const view = element.getBoundingClientRect()
    return [...element.querySelectorAll<HTMLElement>('[data-pdf-page]')]
      .filter(page => {
        const box = page.getBoundingClientRect()
        return box.bottom > view.top && box.top < view.bottom
      }).map(page => Number(page.dataset.pdfPage))
  })
}

function scrollPerFrame(scroller: Locator, destination: number, step: number) {
  return scroller.evaluate((element, { destination, step }) => new Promise<void>(resolve => {
    const top = Math.max(0, Math.min(destination, element.scrollHeight - element.clientHeight))
    const advance = () => {
      const remaining = top - element.scrollTop
      if (Math.abs(remaining) <= 1) { resolve(); return }
      element.scrollTop += Math.sign(remaining) * Math.min(Math.abs(remaining), step)
      requestAnimationFrame(advance)
    }
    requestAnimationFrame(advance)
  }), { destination, step })
}

it('keeps painted tiles while dragging or scrolling rapidly and restores sharp, selectable pages', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Awaited<ReturnType<typeof launchPdfBrowser>> | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-drag-performance-e2e')
    const title = 'PDF drag performance test'
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await manyPageSourcePdf())

    browser = await launchPdfBrowser()
    const page = await browser.newPage({ viewport: { width: 1680, height: 900 },
      locale: 'en-US', timezoneId: 'Asia/Shanghai', deviceScaleFactor: 2 })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-drag-performance'))
    type Phase = 'setup' | 'divider' | 'divider-release' | 'scrollbar' | 'scrollbar-release' | 'normal-scroll' | 'rapid-scroll'
    let phase: Phase = 'setup'
    const requests: Array<{ phase: Phase; action: string; page: number; rasterWidth?: number }> = []
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/api/pdf.native')) return
      const payload = request.postDataJSON()?.payload as { action?: string; page?: number; tile?: {
        page: number; rasterWidth: number
      } } | undefined
      if (payload?.action === 'tile' && payload.tile) requests.push({ phase, action: 'tile', ...payload.tile })
      if (payload?.page && (payload.action === 'text' || payload.action === 'links')) {
        requests.push({ phase, action: payload.action, page: payload.page })
      }
    })

    const reader = await openReader(page, scaffold.authenticatedUrl, title)
    await page.locator('[data-sidebar-right-mode="fullscreen"]').click()
    await reader.evaluate(element => { (element as HTMLElement).style.width = '900px' })
    await openSidebarSection(reader, 'Bookmarks')
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    const scroller = reader.locator('.dsh-pdf-scroll')
    const firstPage = reader.locator('[data-pdf-page="1"]')
    const surface = firstPage.locator('.dsh-pdf-tile-surface')
    await expect.poll(() => paintedAtDpr(surface, 2)).toBe(true)
    await expect.poll(() => firstPage.locator('.dsh-pdf-text-layer').textContent()).toContain('Browser PDF page 1')
    const beforeWidth = (await surface.boundingBox())!.width
    const beforeEpoch = await surface.getAttribute('data-pdf-ready-epoch')
    expect(beforeEpoch).not.toBeNull()
    const retained = await surface.locator(readyCanvas).first().elementHandle()
    const retainedFraction = await retained.evaluate(canvas =>
      canvas.getBoundingClientRect().width / canvas.parentElement!.getBoundingClientRect().width)
    expect(retainedFraction).toBeGreaterThan(0)

    const divider = sidebar.locator('.dsh-pdf-sidebar-divider')
    await expect.poll(() => divider.evaluate(element => {
      const box = element.getBoundingClientRect()
      return element === document.elementFromPoint(box.left + box.width / 2, box.top + 40)
    })).toBe(true)
    const dividerBox = (await divider.boundingBox())!
    const dividerX = dividerBox.x + dividerBox.width / 2
    const dividerY = dividerBox.y + 40
    const initialSidebarWidth = Number(await divider.getAttribute('aria-valuenow'))
    const maximumSidebarWidth = Number(await divider.getAttribute('aria-valuemax'))
    const finalOffset = Math.min(80, maximumSidebarWidth - initialSidebarWidth)
    expect(finalOffset).toBeGreaterThan(66)
    await divider.evaluate(element => {
      const divider = element as HTMLElement
      divider.addEventListener('pointerdown', event => {
        divider.dataset.testPointerId = String(event.pointerId)
        divider.dataset.testPointerX = String(event.clientX)
      }, { once: true })
    })
    phase = 'divider'
    await page.mouse.move(dividerX, dividerY)
    await page.mouse.down()
    let previousWidth = beforeWidth
    for (const offset of [24, 56]) {
      await page.mouse.move(dividerX - offset, dividerY)
      await expect.poll(async () => (await surface.boundingBox())!.width).toBeLessThan(previousWidth - 10)
      await paintFrames(page)
      expect(await surface.getAttribute('data-pdf-ready-epoch')).toBe(beforeEpoch)
      const frame = await retained.evaluate(element => {
        const canvas = element as HTMLCanvasElement
        const surface = canvas.parentElement
        if (!canvas.isConnected || !surface || !canvas.width || !canvas.height) return null
        return canvas.getBoundingClientRect().width / surface.getBoundingClientRect().width
      })
      expect(frame).not.toBeNull()
      expect(frame!).toBeCloseTo(retainedFraction, 2)
      previousWidth = (await surface.boundingBox())!.width
    }
    const intermediateRasters = requests.filter(request => request.phase === 'divider' && request.action === 'tile' && request.page === 1)
    expect(intermediateRasters.every(request => Math.abs(request.rasterWidth! - 2 * beforeWidth) <= 2),
      'fit-width drag should reuse its existing raster, even after multiple intermediate widths').toBe(true)
    phase = 'divider-release'
    const handoff = await divider.evaluate(async (element, offset) => {
      const divider = element as HTMLElement
      const sidebar = divider.closest<HTMLElement>('.dsh-pdf-sidebar')!
      const pointerId = Number(divider.dataset.testPointerId)
      if (!pointerId) throw new Error('Expected a real pointerdown on the sidebar divider')
      const pointer = { bubbles: true, pointerId, pointerType: 'mouse', isPrimary: true,
        clientX: Number(divider.dataset.testPointerX) - offset }
      delete divider.dataset.testPointerId
      delete divider.dataset.testPointerX
      const oldWidth = sidebar.getBoundingClientRect().width
      const widths: number[] = []
      let transitioned = false
      const transitionStarted = (event: TransitionEvent) => {
        if (event.target === sidebar && event.propertyName === 'width') transitioned = true
      }
      sidebar.addEventListener('transitionrun', transitionStarted)
      // These two events run in the same task while the final width rAF is pending.
      divider.dispatchEvent(new PointerEvent('pointermove', { ...pointer, buttons: 1 }))
      divider.dispatchEvent(new PointerEvent('pointerup', { ...pointer, button: 0 }))
      try {
        for (let frame = 0; frame < 4; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          widths.push(sidebar.getBoundingClientRect().width)
          transitioned ||= sidebar.getAnimations().some(animation =>
            animation instanceof CSSTransition && animation.transitionProperty === 'width')
        }
      } finally { sidebar.removeEventListener('transitionrun', transitionStarted) }
      return { oldWidth, widths, transitioned }
    }, finalOffset)
    await page.mouse.up()
    const finalSidebarWidth = initialSidebarWidth + finalOffset
    await expect.poll(() => divider.getAttribute('aria-valuenow')).toBe(String(finalSidebarWidth))
    await expect.poll(() => sidebar.getAttribute('data-resizing')).toBeNull()
    expect(handoff.transitioned, 'a pointerup with the final width pending must not animate sidebar width').toBe(false)
    expect(handoff.widths.some(width => Math.abs(width - finalSidebarWidth) <= 1)).toBe(true)
    expect(handoff.widths.every(width => Math.min(Math.abs(width - handoff.oldWidth), Math.abs(width - finalSidebarWidth)) <= 1)).toBe(true)
    await expect.poll(async () => (await surface.boundingBox())!.width).toBeLessThan(previousWidth - 10)
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch')).not.toBe(beforeEpoch)
    await expect.poll(() => paintedAtDpr(surface, 2)).toBe(true)
    const finalPageWidth = (await surface.boundingBox())!.width
    const releaseRasters = requests.filter(request => request.phase === 'divider-release' && request.action === 'tile' && request.page === 1)
    expect(releaseRasters.length).toBeGreaterThan(0)
    expect(releaseRasters.every(request => Math.abs(request.rasterWidth! - 2 * finalPageWidth) <= 2),
      'the divider handoff should request only the final full-resolution raster').toBe(true)

    const vertical = reader.locator('.dsh-pdf-content').getByRole('scrollbar', { name: 'Vertical scrollbar' })
    const thumb = vertical.locator('.dsh-pdf-scrollbar-thumb')
    await thumb.waitFor({ state: 'visible' })
    const trackBox = (await vertical.boundingBox())!
    const thumbBox = (await thumb.boundingBox())!
    const thumbX = thumbBox.x + thumbBox.width / 2
    const thumbY = thumbBox.y + thumbBox.height / 2
    const lastPage = reader.locator(`[data-pdf-page="${LARGE_PAGE_COUNT}"]`)
    const lastSurface = lastPage.locator('.dsh-pdf-tile-surface')
    const lastText = lastPage.locator('.dsh-pdf-text-layer')
    const visibleAtStart = await visiblePages(scroller)
    phase = 'scrollbar'
    await page.mouse.move(thumbX, thumbY)
    await page.mouse.down()
    await page.mouse.move(thumbX, trackBox.y + trackBox.height - 2)
    await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
    await lastSurface.locator(readyCanvas).first().waitFor({ state: 'visible' })
    await expect.poll(() => paintedAtDpr(lastSurface, previewDpr)).toBe(true)
    const lastWidth = (await lastSurface.boundingBox())!.width
    const previewWidth = lastWidth * previewDpr
    const duringScroll = requests.filter(request => request.phase === 'scrollbar' && request.page === LARGE_PAGE_COUNT)
    const duringScrollTiles = duringScroll.filter(request => request.action === 'tile')
    expect(duringScrollTiles.length).toBeGreaterThan(0)
    expect(duringScrollTiles.every(request => Math.abs(request.rasterWidth! - previewWidth) <= Math.max(2, previewWidth * .01)),
      `only preview raster is requested for the dragged-to page: ${JSON.stringify(duringScrollTiles)}`).toBe(true)
    const visibleDuringDrag = new Set([...visibleAtStart, ...await visiblePages(scroller)])
    const previewTiles = requests.filter(request => request.phase === 'scrollbar' && request.action === 'tile'
      && Math.abs(request.rasterWidth! - previewWidth) <= 2)
    expect(previewTiles.every(request => visibleDuringDrag.has(request.page)), 'the scrollbar drag skips offscreen prefetch').toBe(true)
    expect(await lastText.locator('span[data-pdf-run]').count(), JSON.stringify({
      textState: await lastText.getAttribute('data-pdf-text'), fidelity: await lastText.getAttribute('data-pdf-text-fidelity'),
      previewTiles: duringScrollTiles,
    })).toBe(0)

    phase = 'scrollbar-release'
    await page.mouse.up()
    await expect.poll(() => paintedAtDpr(lastSurface, 2)).toBe(true)
    await expect.poll(() => lastText.textContent()).toContain(`Browser PDF page ${LARGE_PAGE_COUNT}`)
    await expect.poll(() => requests.filter(request => request.phase === 'scrollbar-release' && request.page === LARGE_PAGE_COUNT)
      .map(request => request.action)).toEqual(expect.arrayContaining(['tile', 'text', 'links']))

    // Each fixture page has the same size. Measure the final mounted wrapper
    // to find cold destinations without touching the reader's navigation API.
    const normalPage = LARGE_PAGE_COUNT - 4
    const rapidPage = 115 // This fixture page has a text layer to restore.
    const { lastTop, stride } = await lastPage.evaluate(element => {
      const wrapper = element.closest<HTMLElement>('.dsh-pdf-windowed-page')!
      return { lastTop: Number.parseFloat(wrapper.style.top), stride: wrapper.getBoundingClientRect().height }
    })
    const destination = (pageNumber: number) => lastTop - stride * (LARGE_PAGE_COUNT - pageNumber)
    const normalSurface = reader.locator(`[data-pdf-page="${normalPage}"] .dsh-pdf-tile-surface`)
    phase = 'normal-scroll'
    await scrollPerFrame(scroller, destination(normalPage), 12)
    await expect.poll(() => paintedAtDpr(normalSurface, 2)).toBe(true)
    const normalTiles = requests.filter(request => request.phase === 'normal-scroll' && request.action === 'tile')
    expect(normalTiles.some(request => request.page === normalPage)).toBe(true)
    expect(normalTiles.every(request => Math.abs(request.rasterWidth! - 2 * lastWidth) <= 2),
      'slow reading scroll keeps full resolution').toBe(true)

    phase = 'rapid-scroll'
    await scrollPerFrame(scroller, destination(rapidPage), 240)
    expect(requests.some(request => request.phase === 'rapid-scroll' && request.action === 'tile'
      && Math.abs(request.rasterWidth! - previewWidth) <= 2), 'rapid ordinary scroll requests a low-resolution preview').toBe(true)
    const rapidDestination = reader.locator(`[data-pdf-page="${rapidPage}"]`)
    await expect.poll(() => paintedAtDpr(rapidDestination.locator('.dsh-pdf-tile-surface'), 2)).toBe(true)
    await expect.poll(() => rapidDestination.locator('.dsh-pdf-text-layer').textContent()).toContain(`Browser PDF page ${rapidPage}`)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
