import { expect, it, onTestFailed } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, newEnglishPage, saveFailureShot, EXPECTED, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { plainPdf } from '../../fixtures/plain-pdf.ts'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { expectUnannotatedPage, expectUniformHighlight, highlightPixels, screenshotPagePixels } from '../support/pixels.ts'
import { captureToolbarEditsAria, openSidebarSection } from '../support/toolbar.ts'
import { savedHighlightColors, sourcePdf } from '../support/documents.ts'

it('keeps one new highlight uniform across overlapping quads before and after save', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-overlap-highlight-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF overlapping highlight test' })
    const path = join(scaffold.workspaceCwd, 'reader-overlap-highlight-e2e.pdf')
    await writeFile(path, plainPdf([{ size: [240, 160], operators: '0.75 g 0 0 240 80 re f\n' }]))

    // Seed a real Host edit so the browser renders its unsaved SVG preview.
    // Each quad has a flat area and shares one overlapping 30-point strip.
    const service = scaffold.ctx.get('pdf') as { dispatch(sessionId: string, input: Record<string, unknown>,
      agent: { session: { id: string; header: { cwd?: string } } }, signal: AbortSignal): Promise<unknown> } | undefined
    expect(service).toBeDefined()
    const resolved = await scaffold.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const signal = new AbortController().signal
    const address = `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path.split('/').map(encodeURIComponent).join('/')}`
    const opened = await service!.dispatch(sessionId, { action: 'open', sessionId, address }, resolved.agent, signal) as { id: string; revision: number }
    const edited = await service!.dispatch(sessionId, { action: 'change', sessionId, id: opened.id, revision: opened.revision,
      operations: [{ type: 'add', annotation: {
        id: 'overlapping-quads', page: 1, subtype: 'Highlight', rect: [20, 40, 150, 120],
        quadPoints: [20, 120, 100, 120, 20, 40, 100, 40, 70, 120, 150, 120, 70, 40, 150, 40],
        color: [1, 0.38431, 0],
      } }],
    }, resolved.agent, signal) as { dirty: boolean }
    expect(edited.dirty).toBe(true)

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-overlap-highlight-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF overlapping highlight test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: 'reader-overlap-highlight-e2e.pdf', exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay path').first().waitFor({ state: 'visible' })
    expect(await reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay path').count()).toBe(1)
    expectUniformHighlight(await highlightPixels(page))

    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    await toolbar.getByRole('button', { name: 'Region screenshot', exact: true }).click()
    const box = await reader.locator('[data-pdf-page="1"]').boundingBox()
    expect(box).not.toBeNull()
    const point = (x: number, y: number) => ({ x: box!.x + x * box!.width / 240, y: box!.y + (160 - y) * box!.height / 160 })
    const start = point(10, 130), end = point(170, 30)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 8 })
    await page.mouse.up()
    const preview = reader.getByRole('dialog', { name: 'Screenshot preview' })
    await preview.waitFor({ state: 'visible' })
    expectUnannotatedPage(await screenshotPagePixels(page))
    await preview.getByRole('button', { name: 'Close', exact: true }).click()

    const save = toolbar.getByRole('button', { name: 'Save', exact: true })
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay').waitFor({ state: 'detached' })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible' })
    expectUniformHighlight(await highlightPixels(page))
    const annotations = reader.locator('.dsh-pdf-comments')
    await expect.poll(() => annotations.locator('.dsh-pdf-comment-item').count()).toBe(1)
    const note = toolbar.getByRole('button', { name: 'Note', exact: true })
    await note.click()
    await expect.poll(() => note.getAttribute('aria-pressed')).toBe('true')
    await reader.locator('[data-pdf-page="1"].dsh-pdf-mode-note').click({ position: { x: 185, y: 90 } })
    const commentCard = reader.locator('.dsh-pdf-page-comment-card')
    await commentCard.getByRole('textbox', { name: 'Note' }).fill('Point-anchored note')
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    // Applying the note crosses an RPC and a subsequent Client render. Give
    // the observable list the same bounded budget as other PDF mutations.
    await expect.poll(() => annotations.locator('.dsh-pdf-comment-item').count(), { timeout: 20_000 }).toBe(2)
    const noteToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await expect.poll(() => noteToolbar.count()).toBe(0)
    const noteCard = reader.locator('.dsh-pdf-page-comment-card[data-card-kind="note"]')
    await noteCard.getByRole('button', { name: 'Change note color' }).click()
    // The color menu shares the Reader's overlay portal with other tool menus.
    const noteColors = reader.getByTestId('pdf-note-colors')
    await noteColors.waitFor({ state: 'visible' })
    expect(await noteColors.locator('.dsh-pdf-highlight-swatch').count()).toBe(5)
    await noteColors.locator('[data-testid="pdf-highlight-swatch-1"]').click()
    await expect.poll(() => noteCard.evaluate(element => (element as HTMLElement).style.getPropertyValue('--pdf-note-tint')))
      .toBe('#ff9f0a')
    const closeNote = noteCard.getByRole('button', { name: 'Close note', exact: true })
    await closeNote.click()
    const noteMarker = reader.locator('[data-pdf-note-id]')
    await expect.poll(() => noteMarker.count()).toBe(1)
    const markerBefore = await noteMarker.boundingBox()
    expect(markerBefore).not.toBeNull()
    // A region containing the visible note marker must contain only the PDF
    // page pixels, not the Reader marker or the native note appearance.
    await toolbar.getByRole('button', { name: 'Region screenshot', exact: true }).click()
    const noteCenter = { x: markerBefore!.x + markerBefore!.width / 2,
      y: markerBefore!.y + markerBefore!.height / 2 }
    await page.mouse.move(noteCenter.x - 28, noteCenter.y - 28)
    await page.mouse.down()
    await page.mouse.move(noteCenter.x + 28, noteCenter.y + 28, { steps: 8 })
    await page.mouse.up()
    const barePreview = reader.getByRole('dialog', { name: 'Screenshot preview' })
    await barePreview.waitFor({ state: 'visible' })
    const yellowPixels = await barePreview.getByRole('img').evaluate(async element => {
      const image = element as HTMLImageElement
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let yellow = 0
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > 225 && pixels[index + 1] > 185 && pixels[index + 2] < 155) yellow++
      }
      canvas.width = 0; canvas.height = 0
      return yellow
    })
    expect(yellowPixels).toBe(0)
    await barePreview.getByRole('button', { name: 'Close', exact: true }).click()
    await noteMarker.click()
    await noteCard.waitFor({ state: 'visible' })
    await expect.poll(() => noteMarker.count()).toBe(0)
    const moveHandle = noteCard.getByRole('button', { name: /Move note card/ })
    const handleBox = await moveHandle.boundingBox()
    expect(handleBox).not.toBeNull()
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 26, handleBox!.y + handleBox!.height / 2 + 20, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => noteCard.getAttribute('data-moving')).toBe(null)
    await noteCard.getByRole('button', { name: 'Close note', exact: true }).click()
    await expect.poll(() => noteMarker.count()).toBe(1)
    const markerAfter = await noteMarker.boundingBox()
    expect(markerAfter).not.toBeNull()
    expect(markerAfter!.x).toBeGreaterThan(markerBefore!.x + 10)
    expect(markerAfter!.y).toBeGreaterThan(markerBefore!.y + 8)
    // A closed note is also movable. Drag it into opposite page corners,
    // then open it and verify the floating editor never leaves the reader.
    const pageBox = await reader.locator('[data-pdf-page="1"]').boundingBox()
    const scrollBox = await reader.locator('.dsh-pdf-scroll').boundingBox()
    const sidebarBox = await reader.locator('.dsh-pdf-sidebar').boundingBox()
    expect(pageBox).not.toBeNull()
    expect(scrollBox).not.toBeNull()
    expect(sidebarBox).not.toBeNull()
    const right = Math.min(pageBox!.x + pageBox!.width - 13, scrollBox!.x + scrollBox!.width - 13,
      sidebarBox!.x - 19)
    const bottom = Math.min(pageBox!.y + pageBox!.height - 13, scrollBox!.y + scrollBox!.height - 13)
    const top = Math.max(pageBox!.y + 13, scrollBox!.y + 13)
    for (const [index, corner] of [{ x: right, y: bottom }, { x: pageBox!.x + 13, y: top }].entries()) {
      const before = await noteMarker.boundingBox()
      expect(before).not.toBeNull()
      await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2)
      await page.mouse.down()
      await page.mouse.move(corner.x, corner.y, { steps: 8 })
      await page.mouse.up()
      await expect.poll(() => noteMarker.getAttribute('data-moving'), { timeout: 20_000 }).toBe(null)
      await expect.poll(async () => {
        const moved = await noteMarker.boundingBox()
        return moved ? Math.hypot(moved.x + moved.width / 2 - corner.x, moved.y + moved.height / 2 - corner.y) : Infinity
      }, { timeout: 20_000 }).toBeLessThan(30)
      expect(await noteCard.count()).toBe(0)
      await noteMarker.click()
      await noteCard.waitFor({ state: 'visible' })
      const cardBox = await noteCard.boundingBox()
      const readerBox = await reader.locator('.dsh-pdf-content').boundingBox()
      expect(cardBox).not.toBeNull()
      expect(readerBox).not.toBeNull()
      expect(cardBox!.x).toBeGreaterThanOrEqual(readerBox!.x)
      expect(cardBox!.y).toBeGreaterThanOrEqual(readerBox!.y)
      expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(readerBox!.x + readerBox!.width)
      expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(readerBox!.y + readerBox!.height)
      if (index === 1) {
        const resize = noteCard.getByRole('button', { name: /Resize note/ })
        const grip = await resize.boundingBox()
        expect(grip).not.toBeNull()
        await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2)
        await page.mouse.down()
        await page.mouse.move(grip!.x + grip!.width / 2 + 48, grip!.y + grip!.height / 2 + 32, { steps: 6 })
        await page.mouse.up()
        await expect.poll(async () => (await noteCard.boundingBox())?.width ?? 0).toBeGreaterThan(cardBox!.width + 20)
        const enlarged = await noteCard.boundingBox()
        expect(enlarged!.height).toBeGreaterThan(cardBox!.height + 12)
        await noteCard.getByRole('button', { name: 'Close note', exact: true }).click()
        await noteMarker.click()
        const reopened = await noteCard.boundingBox()
        expect(reopened!.width).toBeCloseTo(enlarged!.width, 0)
        expect(reopened!.height).toBeCloseTo(enlarged!.height, 0)
      }
      await noteCard.getByRole('button', { name: 'Close note', exact: true }).click()
      await expect.poll(() => noteMarker.count()).toBe(1)
    }
    await openSidebarSection(reader, 'Annotations')
    expect(await annotations.locator('.dsh-pdf-comment-item').first().innerText()).toContain('Highlight')
    expect(await annotations.locator('.dsh-pdf-comment-item').last().innerText()).toContain('Point-anchored note')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)

it('highlights from the split button, then edits and persists five quick colors', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-highlight-colors-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF quick colors test' })
    const path = join(scaffold.workspaceCwd, 'reader-quick-colors-e2e.pdf')
    await writeFile(path, await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-quick-colors-browser'))
    const openReader = async () => {
      await page.getByRole('treeitem').filter({ hasText: 'PDF quick colors test' }).click()
      const reader = page.locator('.dsh-pdf-reader')
      if (!await reader.isVisible()) {
        const column = page.locator('[data-rightbar-col]')
        if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
        await column.locator('[data-sidebar-right-guide-entry="files"]').click()
        await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
        await column.locator('[data-files-reload]').click()
        await column.locator('[data-files-entry="file"]')
          .getByRole('button', { name: 'reader-quick-colors-e2e.pdf', exact: true }).click()
      }
      await reader.waitFor({ state: 'visible', timeout: 20_000 })
      await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
      await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
        .toContain('Browser PDF page one')
      return reader
    }
    const selectText = async () => {
      const selected = await page.locator('.dsh-pdf-reader').evaluate(element => {
        const layer = element.querySelector('[data-pdf-page="1"] .dsh-pdf-text-layer')
        const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
        const glyphs = [...layer?.querySelectorAll<HTMLElement>('span[data-pdf-run]') ?? []]
        const label = 'Browser PDF page one'
        if (!scroll || !glyphs.map(glyph => glyph.textContent).join('').startsWith(label)) {
          throw new Error('PDF text layer is not ready for selection')
        }
        let remaining = label.length
        const last = glyphs.find(glyph => {
          const length = glyph.textContent?.length ?? 0
          if (remaining <= length) return true
          remaining -= length
          return false
        })
        const firstText = glyphs[0]?.firstChild, lastText = last?.firstChild
        if (!firstText || !lastText) throw new Error('PDF glyph text nodes are unavailable')
        // Select text that a reader can actually see. Merely finding an active
        // text layer does not mean its absolute-positioned glyphs are inside the
        // PDF scrollport after earlier pane layout/scroll restoration.
        last?.scrollIntoView({ block: 'center', inline: 'center' })
        const range = document.createRange()
        range.setStart(firstText, 0)
        range.setEnd(lastText, remaining)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
        return selection?.toString() ?? ''
      })
      expect(selected).toContain('Browser PDF page one')
      const toolbar = page.locator('.dsh-pdf-reader').getByRole('toolbar', { name: 'Selected text actions' })
      // A synthetic Range can precede Page's onView effect. Retry the same
      // keyboard capture path until the Reader has registered its page view.
      await expect.poll(async () => {
        return page.locator('.dsh-pdf-reader').evaluate(reader => {
          const scroll = reader.querySelector<HTMLElement>('.dsh-pdf-scroll')!
          scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
          const element = reader.querySelector<HTMLElement>('.dsh-pdf-context-toolbar[aria-label="Selected text actions"]')!
          const bounds = scroll.getBoundingClientRect()
          const range = window.getSelection()?.getRangeAt(0).getBoundingClientRect()
          const main = reader.querySelector<HTMLElement>('.dsh-pdf-main-toolbar')?.getBoundingClientRect()
          const toolbarBounds = element.getBoundingClientRect()
          return { active: element.getAttribute('aria-hidden'), visible: element.dataset.visible,
            scroll: [bounds.left, bounds.top, bounds.right, bounds.bottom],
            range: range ? [range.left, range.top, range.right, range.bottom] : null,
            mainBottom: main?.bottom, toolbarSize: [toolbarBounds.width, toolbarBounds.height] }
        })
      }, { timeout: 10_000 }).toMatchObject({ active: 'false', visible: 'true' })
      await toolbar.waitFor({ state: 'visible' })
      return toolbar
    }

    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    let reader = await openReader()
    let selectionToolbar = await selectText()
    const save = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
      .getByRole('button', { name: 'Save', exact: true })
    expect(await save.isDisabled()).toBe(true)
    expect(await reader.locator('.dsh-pdf-annotation-overlay path').count()).toBe(0)
    const selectionActions = selectionToolbar.locator('.dsh-pdf-selection-actions > button, .dsh-pdf-selection-highlight > button')
    expect(await selectionActions.evaluateAll(buttons => buttons.length > 0 && buttons.every(button =>
      button.getAttribute('aria-label') && button.querySelector('svg') && !button.textContent?.trim()))).toBe(true)
    await selectionToolbar.getByRole('button', { name: 'Highlight colors' }).click()
    // Menus live in the Reader overlay layer, outside the text-action toolbar.
    const selectionColors = reader.getByTestId('pdf-selection-highlight-colors')
    await selectionColors.waitFor({ state: 'visible' })
    expect(await reader.locator('.dsh-pdf-annotation-overlay path').count()).toBe(0)
    expect(await save.isDisabled()).toBe(true)
    await selectionColors.getByTestId('pdf-highlight-swatch-1').click()
    const firstOverlay = reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay path').first()
    await firstOverlay.waitFor({ state: 'visible' })
    await expect.poll(() => firstOverlay.getAttribute('fill')).toBe('rgb(255,159,10)')
    await expect.poll(() => save.isEnabled()).toBe(true)
    await compareOrRefreshGolden(
      join(EXPECTED, 'dirty-toolbar.expected.md'),
      await captureToolbarEditsAria(page, scaffold.workspaceCwd),
      webSnapshotMode(),
    )
    let selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await selectedToolbar.waitFor({ state: 'visible' })
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await selectedToolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-highlight-toolbar.png') })
    }
    expect(await selectedToolbar.locator('.dsh-pdf-annotation-kind').textContent()).toBe('Highlight')
    expect(await selectedToolbar.getByRole('button', { name: 'Comment', exact: true }).count()).toBe(1)
    await selectedToolbar.getByRole('button', { name: 'Delete annotation' }).waitFor({ state: 'visible' })
    expect(await selectedToolbar.locator('summary[aria-label="More annotation actions"]').count()).toBe(0)
    expect(await selectedToolbar.getByRole('button', { name: 'Deselect' }).count()).toBe(1)
    const sidebarToggle = reader.getByRole('tab', { selected: true })
    if (await sidebarToggle.getAttribute('aria-expanded') === 'true') await sidebarToggle.click()
    await expect.poll(() => sidebarToggle.getAttribute('aria-expanded')).toBe('false')
    await selectedToolbar.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect.poll(() => sidebarToggle.getAttribute('aria-expanded')).toBe('false')
    const commentEditor = reader.locator('.dsh-pdf-page-comment-card').getByRole('textbox', { name: 'Comment' })
    await expect.poll(() => commentEditor.evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.type('Typed without clicking the editor')
    expect(await commentEditor.inputValue()).toBe('Typed without clicking the editor')
    await commentEditor.fill('')
    // The comment card and mark toolbar coexist; Cancel returns to the mark.
    await reader.locator('.dsh-pdf-page-comment-card').getByRole('button', { name: 'Cancel' }).click()
    await selectedToolbar.waitFor({ state: 'visible' })
    let quickColors = selectedToolbar.getByTestId('pdf-highlight-colors')
    await quickColors.waitFor({ state: 'visible' })
    expect(await quickColors.locator('.dsh-pdf-highlight-palette-wheel').count()).toBe(1)
    const swatches = () => quickColors.locator('[data-testid^="pdf-highlight-swatch-"]')
    const swatchCore = (index: number) => quickColors.getByTestId(`pdf-highlight-swatch-${index}`)
      .locator('.dsh-pdf-highlight-swatch-core')
    await expect.poll(() => swatches().count()).toBe(5)
    const palette = quickColors.getByTestId('pdf-highlight-palette')
    const add = quickColors.getByTestId('pdf-highlight-add-color')
    expect(await add.count()).toBe(0)

    await quickColors.getByTestId('pdf-highlight-swatch-4').click({ button: 'right' })
    const menu = page.getByTestId('pdf-highlight-color-menu')
    await menu.waitFor({ state: 'visible' })
    await menu.getByTestId('pdf-highlight-delete-color').click()
    await expect.poll(() => swatches().count()).toBe(4)
    await quickColors.getByTestId('pdf-highlight-swatch-3').click({ button: 'right' })
    await menu.waitFor({ state: 'visible' })
    await menu.getByTestId('pdf-highlight-edit-color').fill('#35b954')
    await expect.poll(() => swatchCore(3)
      .evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(53, 185, 84)')
    // Editing a saved swatch changes only the palette, not the PDF annotation.
    expect(await firstOverlay.getAttribute('fill')).toBe('rgb(255,159,10)')
    // Choosing a palette color recolors the selected annotation, and that
    // color can be saved into the now-available fifth quick slot.
    await palette.fill('#128ace')
    await expect.poll(() => firstOverlay.getAttribute('fill')).toBe('rgb(18,138,206)')
    await expect.poll(() => add.isEnabled()).toBe(true)
    await add.click()
    await expect.poll(() => swatches().count()).toBe(5)
    expect(await add.count()).toBe(0)

    await quickColors.getByTestId('pdf-highlight-swatch-4').click({ button: 'right' })
    await menu.waitFor({ state: 'visible' })
    await menu.getByTestId('pdf-highlight-edit-color').fill('#a1b2c3')
    await expect.poll(() => swatchCore(4)
      .evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(161, 178, 195)')
    expect(await firstOverlay.getAttribute('fill')).toBe('rgb(18,138,206)')
    await quickColors.getByTestId('pdf-highlight-swatch-4').click()
    await expect.poll(() => firstOverlay.getAttribute('fill')).toBe('rgb(161,178,195)')
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(async () => (await savedHighlightColors(path)).length).toBe(1)

    // The palette belongs to the user, not to this Reader instance. Reloading
    // the DSH client must retain its edited five-slot bar.
    await page.reload({ waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    reader = await openReader()
    selectionToolbar = await selectText()
    await selectionToolbar.getByRole('button', { name: 'Highlight', exact: true }).click()
    const newHighlight = reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay g[data-annotation-id]').last()
    await newHighlight.waitFor({ state: 'visible' })
    const newHighlightId = await newHighlight.getAttribute('data-annotation-id')
    expect(newHighlightId).toBeTruthy()
    await expect.poll(() => reader.locator(`[data-pdf-page="1"] .dsh-pdf-annotation-overlay g[data-annotation-id="${newHighlightId}"] path`)
      .getAttribute('fill')).toBe('rgb(255,255,0)')
    selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await selectedToolbar.waitFor({ state: 'visible' })
    quickColors = selectedToolbar.getByTestId('pdf-highlight-colors')
    await quickColors.waitFor({ state: 'visible' })
    await expect.poll(() => quickColors.locator('[data-testid^="pdf-highlight-swatch-"]').count()).toBe(5)
    await expect.poll(() => swatchCore(4)
      .evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(161, 178, 195)')

    // The overlay is transient: once native tiles repaint, a dynamic `path:last`
    // locator can silently switch to the older highlight. Assert the visible
    // selected color now, then verify both saved annotation colors from the PDF.
    const selectedColor = () => quickColors.locator('.dsh-pdf-highlight-palette-current')
      .evaluate(element => getComputedStyle(element).backgroundColor)
    await quickColors.getByTestId('pdf-highlight-swatch-4').click()
    await expect.poll(selectedColor).toBe('rgb(161, 178, 195)')
    await expect.poll(() => quickColors.getByTestId('pdf-highlight-swatch-4').getAttribute('aria-pressed')).toBe('true')
    await quickColors.getByTestId('pdf-highlight-swatch-0').click()
    await expect.poll(selectedColor).toBe('rgb(255, 255, 0)')
    await expect.poll(() => quickColors.getByTestId('pdf-highlight-swatch-0').getAttribute('aria-pressed')).toBe('true')
    await quickColors.getByTestId('pdf-highlight-swatch-4').click()
    await expect.poll(selectedColor).toBe('rgb(161, 178, 195)')
    await expect.poll(() => quickColors.getByTestId('pdf-highlight-swatch-4').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(async () => {
      const colors = await savedHighlightColors(path)
      return colors.length === 2 && colors.every(color => color.every((channel, index) =>
        Math.abs(channel - [161 / 255, 178 / 255, 195 / 255][index]) < 1e-6))
    }).toBe(true)

    // A disk write precedes the Client accepting its saved revision. Wait for
    // that handoff before entering Note mode: accepting a revision resets modes.
    await expect.poll(() => save.getAttribute('data-save-state')).toMatch(/^saved(?:-success)?$/)
    const mainToolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    await expect.poll(() => mainToolbar.getAttribute('aria-busy')).not.toBe('true')
    // Placing a free note should open the annotation editor ready for typing.
    const note = mainToolbar.getByRole('button', { name: 'Note', exact: true })
    await note.click()
    await expect.poll(() => note.getAttribute('aria-pressed')).toBe('true')
    const notePage = reader.locator('[data-pdf-page="1"].dsh-pdf-mode-note')
    await notePage.waitFor({ state: 'visible' })
    await notePage.scrollIntoViewIfNeeded()
    const placement = { x: 180, y: 90 }
    expect(await notePage.evaluate((element, point) => {
      const box = element.getBoundingClientRect()
      return document.elementFromPoint(box.left + point.x, box.top + point.y)?.closest('[data-pdf-page]') === element
    }, placement), 'the placement point must hit the visible PDF page, not a toolbar or sidebar').toBe(true)
    await notePage.click({ position: placement })
    const noteEditor = reader.locator('.dsh-pdf-page-comment-card').getByRole('textbox', { name: 'Note' })
    await expect.poll(() => noteEditor.evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.type('Free note starts here')
    await expect.poll(() => noteEditor.inputValue()).toBe('Free note starts here')
    await reader.locator('.dsh-pdf-page-comment-card').getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => save.getAttribute('data-save-state')).toBe('dirty')
    await reader.locator('.dsh-pdf-page-comment-card').getByRole('button', { name: 'Close note', exact: true }).click()
    await expect.poll(() => reader.locator('[data-pdf-page="1"] [data-pdf-note-id]').count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)

it('gives underline and strike-out the same color bar as a highlight', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-text-mark-colors-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF text mark colors test' })
    const name = 'reader-text-mark-colors-e2e.pdf'
    await writeFile(join(scaffold.workspaceCwd, name), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-text-mark-colors-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF text mark colors test' }).click()
    await page.locator('[data-sidebar-right-expand]').click()
    const column = page.locator('[data-rightbar-col]')
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents()).toContain('Browser PDF page one')

    const selectLine = async () => {
      const selected = await reader.evaluate(async element => {
        const layer = element.querySelector('[data-pdf-page="1"] .dsh-pdf-text-layer')
        const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
        const glyphs = [...layer?.querySelectorAll<HTMLElement>('span[data-pdf-run]') ?? []]
        const label = 'Browser PDF page one'
        if (!scroll || !glyphs.map(glyph => glyph.textContent).join('').startsWith(label)) {
          throw new Error('PDF text layer is not ready for selection')
        }
        let remaining = label.length
        const last = glyphs.find(glyph => {
          const length = glyph.textContent?.length ?? 0
          if (remaining <= length) return true
          remaining -= length
          return false
        })
        last?.scrollIntoView({ block: 'center', inline: 'center' })
        // Let the virtualized page settle after scrolling before taking a
        // browser Range; otherwise it can point at glyphs about to unmount.
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        const settled = [...element.querySelectorAll<HTMLElement>('[data-pdf-page="1"] .dsh-pdf-text-layer span[data-pdf-run]')]
        if (!settled.map(glyph => glyph.textContent).join('').startsWith(label)) {
          throw new Error('PDF text layer changed while scrolling to the selection')
        }
        remaining = label.length
        const settledLast = settled.find(glyph => {
          const length = glyph.textContent?.length ?? 0
          if (remaining <= length) return true
          remaining -= length
          return false
        })
        const firstText = settled[0]?.firstChild, lastText = settledLast?.firstChild
        if (!firstText || !lastText) throw new Error('PDF glyph text nodes are unavailable')
        const range = document.createRange()
        range.setStart(firstText, 0)
        range.setEnd(lastText, remaining)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
        return selection?.toString() ?? ''
      })
      expect(selected).toContain('Browser PDF page one')
      const selectionToolbar = reader.getByRole('toolbar', { name: 'Selected text actions' })
      await expect.poll(() => reader.evaluate(element => {
        const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')!
        scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
        const toolbar = element.querySelector<HTMLElement>('.dsh-pdf-context-toolbar[aria-label="Selected text actions"]')
        return { active: toolbar?.getAttribute('aria-hidden'), visible: toolbar?.dataset.visible }
      }), { timeout: 10_000 }).toMatchObject({ active: 'false', visible: 'true' })
      await selectionToolbar.waitFor({ state: 'visible' })
      return selectionToolbar
    }

    const selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    // Each mark is created from the selection toolbar, then inspected through the
    // selected-annotation toolbar, where all three must offer the same color bar.
    // The kind badge must show the mark's own action icon, not a bare color dot.
    const markIcons = new Map([['Underline', 'M6 4v8a6 6 0 0 0 12 0V4M4 21h16'], ['Strike out', 'M17 5c-1.4-1-3.2-1.5-5-1.5']])
    // label = the action on the selection toolbar; kind = what the badge reads once selected.
    for (const label of ['Underline', 'Strike out'] as const) {
      const selectionToolbar = await selectLine()
      await selectionToolbar.getByRole('button', { name: label, exact: true }).click()
      await selectedToolbar.waitFor({ state: 'visible' })
      await expect.poll(() => selectedToolbar.locator('.dsh-pdf-annotation-kind').textContent()).toBe(label)
      const badge = selectedToolbar.locator('.dsh-pdf-annotation-kind')
      expect(await badge.locator('svg').count()).toBe(1)
      const drawn = await badge.locator('svg path').first().getAttribute('d')
      expect(drawn).toContain(markIcons.get(label))
      const colorBar = selectedToolbar.getByTestId('pdf-highlight-colors')
      await colorBar.waitFor({ state: 'visible' })
      expect(await colorBar.locator('[data-testid^="pdf-highlight-swatch-"]').count()).toBe(5)
      expect(await colorBar.locator('.dsh-pdf-highlight-palette-wheel').count()).toBe(1)
      // Choosing a saved color applies it to this mark, exactly like a highlight.
      await colorBar.getByTestId('pdf-highlight-swatch-1').click()
      await expect.poll(() => colorBar.getByTestId('pdf-highlight-swatch-1').getAttribute('aria-pressed')).toBe('true')
      await selectedToolbar.getByRole('button', { name: 'Deselect' }).click()
      await selectedToolbar.waitFor({ state: 'hidden' })
    }
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)
