import { expect, it, onTestFailed } from 'vitest'
import { build } from 'esbuild'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { newEnglishPage, saveFailureShot, launchWebScaffold, seedSession, watchConsole, ROOT, SESSION } from '../support/scaffold.ts'
import { recordWheelZoomHandoff, zoomHandoffScenarios } from '../zoom-handoff.ts'
import { type Browser } from 'playwright'
import { FILE_NAME, sourcePdf } from '../support/documents.ts'
import { chooseZoom } from '../support/toolbar.ts'

it('keeps the same PDF point and painted pixels through wheel zoom commits, centering clamps and mixed page sizes', async () => {
  const bundle = await build({ entryPoints: [join(ROOT, 'tests/modules/viewer/wheel-zoom-handoff.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') } })
  const css = (await Promise.all(['reader.css', 'windowed-pages.css'].map(file => readFile(join(ROOT, 'src/client', file), 'utf8')))).join('\n')
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    onTestFailed(() => saveFailureShot(page, 'pdf-wheel-zoom-handoff'))
    await page.setContent(`<style>html,body{margin:0}#zoom-handoff-root{width:900px;height:600px}${css}</style><div id="zoom-handoff-root"></div>`)
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    for (const scenario of zoomHandoffScenarios) {
      const result = await page.evaluate(recordWheelZoomHandoff, scenario)
      if (process.env.DSH_PDF_ZOOM_TRACE_DIR) {
        await mkdir(process.env.DSH_PDF_ZOOM_TRACE_DIR, { recursive: true })
        await writeFile(join(process.env.DSH_PDF_ZOOM_TRACE_DIR, `${scenario.name.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`), JSON.stringify(result, null, 2))
      }
      console.info(`PDF wheel handoff: ${JSON.stringify({ name: result.name, maxHandoffX: result.maxHandoffX,
        maxHandoffY: result.maxHandoffY, missingFrames: result.missingFrames, missingPageFrames: result.missingPageFrames })}`)
      expect(result.errors, scenario.name).toEqual([])
      expect(result.missingPageFrames, scenario.name).toBe(0)
      expect(result.samples.every(sample => sample.sameElement), `${scenario.name}: keep the page and its painted fallback mounted`).toBe(true)
      expect(result.maxHandoffX, `${scenario.name}: no horizontal snap after the last gesture frame`).toBeLessThanOrEqual(1)
      expect(result.maxHandoffY, `${scenario.name}: no vertical snap after the last gesture frame`).toBeLessThanOrEqual(1)
      expect(result.missingFrames, `${scenario.name}: previously painted pixels remain covered, not merely a canvas element`).toBe(0)
      expect(result.samples.some(sample => sample.testedPixels > 1), `${scenario.name}: sample more than one real raster pixel`).toBe(true)
    }
    expect(errors).toEqual([])
  } finally { await browser.close() }
}, 40_000)

it('keeps the last complete PDF frame through consecutive in-flight zoom renders', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  let releaseTiles: (() => void) | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-zoom-frame-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF zoom frame test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-consecutive-zoom'))
    let blockTiles = false, requestedTiles = 0
    let blocked = new Promise<void>(resolve => { releaseTiles = resolve })
    await page.route('**/api/pdf.native', async route => {
      const request = route.request()
      if (request.method() === 'POST' && request.postDataJSON()?.payload?.action === 'tile' && blockTiles) {
        requestedTiles++
        await blocked
      }
      try { await route.continue() } catch { /* A superseded zoom cancels its tile request. */ }
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF zoom frame test' }).click()
    const column = page.locator('[data-rightbar-col]')
    if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    const surface = reader.locator('[data-pdf-page="1"] .dsh-pdf-tile-surface')
    // The toolbar mounts before the PDF owns a working copy. Wait for a real
    // frame so the first zoom command belongs to the opened document.
    await surface.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-page="1"] .dsh-pdf-text-layer span').count()).toBeGreaterThan(0)
    await chooseZoom(reader, '100%')
    await reader.locator('.dsh-pdf-toolbar-zoom summary[aria-label="Zoom: 100%"]').waitFor({ state: 'visible' })
    await expect.poll(() => surface.evaluate(host => {
      const ready = (host as HTMLElement).dataset.pdfReadyEpoch
      const canvases = [...host.querySelectorAll<HTMLCanvasElement>('canvas[data-pdf-raster-ready="true"]')]
      const rasterScale = Math.min(window.devicePixelRatio || 1, 2)
      return { width: host.getBoundingClientRect().width, complete: !!ready && canvases.length > 0 && canvases.every(canvas =>
        canvas.dataset.tileEpoch === ready && Number(canvas.dataset.pdfRasterScale) === rasterScale
          && canvas.width > 0 && canvas.height > 0) }
    }), { timeout: 20_000 }).toEqual({ width: 400, complete: true })
    const initialEpoch = await surface.getAttribute('data-pdf-ready-epoch')
    expect(initialEpoch).not.toBeNull()

    // Keep raster replies in flight across multiple zoom changes. Each scale
    // effect is committed, but none can become the next complete frame yet.
    blockTiles = true
    await chooseZoom(reader, '125%')
    await expect.poll(() => requestedTiles).toBeGreaterThan(0)
    await chooseZoom(reader, '150%')
    await expect.poll(() => requestedTiles).toBeGreaterThan(1)
    await chooseZoom(reader, '200%')
    await expect.poll(() => requestedTiles).toBeGreaterThan(2)
    const fallback = await surface.locator('canvas[data-pdf-raster-ready="true"]').evaluateAll(canvases =>
      canvases.map(canvas => ({ epoch: (canvas as HTMLCanvasElement).dataset.tileEpoch,
        width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height })))
    expect(fallback.length).toBeGreaterThan(0)
    expect(fallback.every(canvas => canvas.epoch === initialEpoch && canvas.width > 0 && canvas.height > 0)).toBe(true)

    releaseTiles()
    releaseTiles = undefined
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch'), { timeout: 20_000 }).not.toBe(initialEpoch)
    const finalEpoch = await surface.getAttribute('data-pdf-ready-epoch')
    expect(await surface.locator('canvas[data-pdf-raster-ready="true"]').evaluateAll((canvases, epoch) =>
      canvases.every(canvas => (canvas as HTMLCanvasElement).dataset.tileEpoch === epoch), finalEpoch)).toBe(true)

    // Fixed zoom keeps its logical page size. Fit-width follows the safe reading
    // gutters while the full-width canvas remains underneath the floating panel.
    await chooseZoom(reader, '100%')
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch')).not.toBe(finalEpoch)
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const sidebarToggle = sidebar.getByRole('tab', { selected: true })
    const fixedWidth = (await surface.boundingBox())!.width
    await sidebarToggle.click()
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    expect(Math.abs((await surface.boundingBox())!.width - fixedWidth)).toBeLessThanOrEqual(1)
    const fixedEpoch = await surface.getAttribute('data-pdf-ready-epoch')
    await chooseZoom(reader, 'Fit width')
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch'), { timeout: 20_000 }).not.toBe(fixedEpoch)
    await expect.poll(async () => Math.abs((await surface.boundingBox())!.width - fixedWidth)).toBeGreaterThan(1)
    const fitWidth = (await surface.boundingBox())!.width
    const fitEpoch = await surface.getAttribute('data-pdf-ready-epoch')
    const pageBeforeToggle = await reader.getByRole('textbox', { name: 'Page', exact: true }).inputValue()
    await sidebarToggle.click()
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    await expect.poll(async () => Math.abs((await surface.boundingBox())!.width - fitWidth)).toBeGreaterThan(10)
    expect(await reader.getByRole('textbox', { name: 'Page', exact: true }).inputValue()).toBe(pageBeforeToggle)
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch'), { timeout: 20_000 }).not.toBe(fitEpoch)
    const beforeResize = await surface.getAttribute('data-pdf-ready-epoch')
    // Let the 64 ms text-layer debounce from the preceding zoom settle before
    // observing the sidebar drag; otherwise its rebuild is attributed to the drag.
    await page.waitForTimeout(150)
    blockTiles = true
    blocked = new Promise<void>(resolve => { releaseTiles = resolve })
    const resizeRequestStart = requestedTiles
    const initialCanvasCount = await surface.locator('canvas[data-pdf-raster-ready="true"]').count()
    const resizeFrames = await reader.evaluate(async element => {
      const startingWidth = element.clientWidth
      const raster = element.querySelector<HTMLElement>('[data-pdf-page="1"] .dsh-pdf-tile-surface')!
      const textLayer = element.querySelector<HTMLElement>('[data-pdf-page="1"] .dsh-pdf-text-layer')!
      let blanks = 0, textBlanks = 0, textRebuilds = 0, peakCanvases = 0, last = performance.now()
      const observer = new MutationObserver(records => { textRebuilds += records.filter(record => record.type === 'childList').length })
      observer.observe(textLayer, { childList: true })
      const intervals: number[] = []
      // Each width lands in a separate paint frame, like resizing the reader.
      for (const width of Array.from({ length: 9 }, (_, index) => startingWidth - (8 - index) * 20)) {
        element.style.width = `${width}px`
        await new Promise<void>(resolve => requestAnimationFrame(now => {
          intervals.push(now - last); last = now
          const canvases = [...raster.querySelectorAll<HTMLCanvasElement>('canvas[data-pdf-raster-ready="true"]')]
          if (!canvases.some(canvas => canvas.width > 0 && canvas.height > 0)) blanks++
          if (!textLayer.querySelector('span')) textBlanks++
          peakCanvases = Math.max(peakCanvases, canvases.length)
          resolve()
        }))
      }
      observer.disconnect()
      const sorted = [...intervals].sort((a, b) => a - b)
      return { blanks, textBlanks, textRebuilds, peakCanvases, frames: intervals.length,
        p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] }
    })
    await expect.poll(() => requestedTiles).toBeGreaterThan(resizeRequestStart)
    expect(resizeFrames.frames).toBe(9)
    expect(resizeFrames.blanks).toBe(0)
    expect(resizeFrames.textBlanks).toBe(0)
    expect(resizeFrames.textRebuilds).toBeLessThanOrEqual(1)
    expect(resizeFrames.peakCanvases).toBeLessThanOrEqual(initialCanvasCount + 4)
    console.info(`PDF viewport resize (blocked tiles): ${JSON.stringify(resizeFrames)}`)
    const visibleEpoch = await surface.getAttribute('data-pdf-ready-epoch')
    expect(visibleEpoch).not.toBeNull()
    expect(await surface.locator('canvas[data-pdf-raster-ready="true"]').evaluateAll((canvases, epoch) =>
      canvases.length > 0 && canvases.every(canvas => (canvas as HTMLCanvasElement).dataset.tileEpoch === epoch
        && (canvas as HTMLCanvasElement).width > 0), visibleEpoch)).toBe(true)
    releaseTiles()
    releaseTiles = undefined
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch'), { timeout: 20_000 }).not.toBe(beforeResize)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    releaseTiles?.()
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
