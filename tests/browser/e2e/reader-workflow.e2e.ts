import { expect, it, onTestFailed } from 'vitest'
import { assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, newEnglishPage, openSettings, saveFailureShot, EXPECTED, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { FILE_NAME, NOTE, savedNoteContents, sourcePdf } from '../support/documents.ts'
import { chooseZoom, documentAction, expectFloatingToolRails, expectIconOnlyMainToolbar, fileActions, openSidebarSection } from '../support/toolbar.ts'

it('loads the installed PDF plugin and saves a browser-created note into the real PDF file', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const entries = [...scaffold.ctx.loader.entries()]
    const entry = entries.find(row => row.options.id === 'pdf-reader')
    const activation = {
      pdfService: !!scaffold.ctx.get('pdf'),
      entries: entries.filter(row => row.options.id.startsWith('pdf-')).map(row => ({
        id: row.options.id, name: row.options.name, state: row.fiber?.state, disabled: row.disabled,
      })),
    }
    expect(entry?.fiber?.state, `PDF plugin activation: ${JSON.stringify(activation)}`).toBe(2)
    expect(activation.pdfService, 'The active PDF reader plugin must provide the shared Host document service').toBe(true)
    const profileRequire = createRequire(join(scaffold.harnessHome, 'profiles', 'scaffold', 'package.json'))
    expect(realpathSync(profileRequire.resolve('@dylanl1/dsh-plugin-pdf'))).toBe(realpathSync(join(ROOT, 'dist', 'index.js')))

    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-reader-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF browser test' })
    const path = join(scaffold.workspaceCwd, FILE_NAME)
    const original = await sourcePdf()
    await writeFile(path, original)

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    const ocrSwitch = settings.getByRole('switch', { name: 'OCR' })
    // OCR availability is now determined by the Host for the active session,
    // rather than a user-facing toggle in PDF settings.
    expect(await ocrSwitch.count()).toBe(0)
    expect(await settings.getByRole('combobox', { name: 'OCR engine' }).count()).toBe(1)
    expect(await settings.getByRole('textbox', { name: 'Recognition languages' }).count()).toBe(0)
    expect(await settings.getByRole('spinbutton', { name: 'Recognition timeout (milliseconds)' }).count()).toBe(0)
    expect(await settings.getByLabel('Source language').count()).toBe(0)
    expect(await settings.getByLabel('Default annotation color').count()).toBe(0)
    const translationEngine = settings.getByRole('combobox', { name: 'Translation engine' })
    await translationEngine.waitFor({ state: 'visible' })
    await expect.poll(() => translationEngine.inputValue()).toBe('dsh-model')
    const translationOptions = await translationEngine.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))
    expect(translationOptions).toContain('dsh-model')
    expect(translationOptions).not.toContain('none')
    expect(await settings.getByRole('combobox', { name: 'Target language' }).count()).toBe(0)
    expect(await settings.getByRole('spinbutton', { name: 'PDF size limit (bytes)' }).count()).toBe(0)
    const historyCapacity = settings.getByRole('spinbutton', { name: 'Navigation history capacity' })
    await expect.poll(() => historyCapacity.isEnabled()).toBe(true)
    await historyCapacity.fill('101')
    await historyCapacity.blur()
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'pdf-reader')?.value).toMatchObject({ historyCapacity: 101 })
    await expect.poll(() => settings.locator('.dsh-pdf-settings-save-status').textContent()).toMatch(/^Settings are up to date/)
    await page.keyboard.press('Escape')
    await openSettings(page, 'en')
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    await expect.poll(() => historyCapacity.inputValue()).toBe('101')
    await settings.getByRole('button', { name: 'Restore defaults' }).click()
    await expect.poll(() => historyCapacity.inputValue()).toBe('100')
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'pdf-reader')?.value).toMatchObject({ historyCapacity: 100 })
    await expect.poll(() => settings.locator('.dsh-pdf-settings-save-status').textContent()).toMatch(/^Settings are up to date/)
    await page.keyboard.press('Escape')
    await page.getByRole('treeitem').filter({ hasText: 'PDF browser test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(async failure => {
      throw new Error(`${String(failure)}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page one')
    await openSidebarSection(reader, 'Pages')
    const pagesHeading = reader.locator('.dsh-pdf-thumbnail-panel > .dsh-pdf-panel-heading h3')
    await pagesHeading.waitFor({ state: 'visible' })
    await expect.poll(() => pagesHeading.evaluate(element =>
      new DOMMatrix(getComputedStyle(element.parentElement!).transform).m41)).toBe(0)
    const pagesInset = await pagesHeading.evaluate(element => element.getBoundingClientRect().left
      - element.closest('.dsh-pdf-thumbnail-panel')!.getBoundingClientRect().left)
    await reader.getByRole('button', { name: 'Page 1 / 2' }).waitFor({ state: 'visible' })
    await reader.getByRole('button', { name: 'Page 2 / 2' }).waitFor({ state: 'visible' })
    await openSidebarSection(reader, 'Bookmarks')
    const bookmarksHeading = reader.locator('.dsh-pdf-bookmark-panel > .dsh-pdf-panel-heading h3')
    await bookmarksHeading.waitFor({ state: 'visible' })
    const bookmarksInset = await bookmarksHeading.evaluate(element => element.getBoundingClientRect().left
      - element.closest('.dsh-pdf-bookmark-panel')!.getBoundingClientRect().left)
    expect(pagesInset).toBeGreaterThanOrEqual(9)
    expect(bookmarksInset).toBeGreaterThanOrEqual(9)
    expect(Math.abs(pagesInset - bookmarksInset)).toBeLessThanOrEqual(1)
    await openSidebarSection(reader, 'Annotations')
    expect(await reader.getByRole('tab', { name: 'Notes', exact: true }).count()).toBe(0)
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const save = toolbar.getByRole('button', { name: 'Save', exact: true })
    const content = reader.locator('.dsh-pdf-content')
    await expectFloatingToolRails(reader)
    const [toolbarBox, contentBox] = await Promise.all([toolbar.boundingBox(), content.boundingBox()])
    expect(toolbarBox).not.toBeNull()
    expect(contentBox).not.toBeNull()
    const firstPageBox = await reader.locator('[data-pdf-page="1"]').boundingBox()
    expect(firstPageBox).not.toBeNull()
    // The tool column and scrolling document occupy independent layout columns.
    expect(firstPageBox!.y + firstPageBox!.height).toBeGreaterThan(contentBox!.y)
    expect(firstPageBox!.y).toBeLessThan(contentBox!.y + contentBox!.height)
    const material = await toolbar.evaluate(element => {
      const surface = getComputedStyle(element.querySelector('.dsh-pdf-tool-rail-shell')!)
      return { backgroundImage: surface.backgroundImage, backdropFilter: surface.backdropFilter,
        containerBackdropFilter: getComputedStyle(element).backdropFilter,
        stackingIsolation: getComputedStyle(element).isolation }
    })
    expect(material.backgroundImage).toContain('linear-gradient')
    expect(material.backdropFilter).toContain('blur(24px)')
    expect(material.containerBackdropFilter).toBe('none')
    expect(await toolbar.locator(':scope > .dsh-pdf-tool-rail-shell.dsh-pdf-glass').count()).toBe(1)
    await page.emulateMedia({ contrast: 'more' })
    expect(await toolbar.evaluate(element => getComputedStyle(element.querySelector('.dsh-pdf-tool-rail-shell')!).backdropFilter)).toBe('none')
    await page.emulateMedia({ contrast: 'no-preference' })
    expect(await toolbar.locator('.dsh-pdf-tools > summary').evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap')
    const zoomTrigger = toolbar.locator('.dsh-pdf-toolbar-zoom')
    const zoomControl = zoomTrigger.locator('summary')
    expect(await zoomControl.locator('svg').count()).toBe(1)
    expect(await zoomControl.getAttribute('aria-label')).toBe('Zoom: Fit width')
    const zoomIdleBackground = await zoomControl.evaluate(element => getComputedStyle(element).backgroundColor)
    await zoomControl.hover()
    await expect.poll(() => zoomControl.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(zoomIdleBackground)
    await zoomControl.evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)))
    const zoomHoverBackground = await zoomControl.evaluate(element => getComputedStyle(element).backgroundColor)
    expect(await zoomControl.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    await zoomControl.click()
    const zoomMenu = reader.locator('.dsh-pdf-zoom-menu')
    expect(await zoomMenu.getByRole('button', { name: 'Fit width' }).getAttribute('aria-pressed')).toBe('true')
    expect(await zoomMenu.getByRole('button', { name: 'Fit page' }).count()).toBe(1)
    await page.mouse.move(0, 0)
    await expect.poll(() => zoomControl.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(zoomHoverBackground)
    const [zoomMenuBox, zoomToolbarBox] = await Promise.all([zoomMenu.boundingBox(), toolbar.boundingBox()])
    expect(zoomMenuBox).not.toBeNull()
    expect(zoomToolbarBox).not.toBeNull()
    expect(zoomMenuBox!.x).toBeGreaterThanOrEqual(zoomToolbarBox!.x + zoomToolbarBox!.width)
    const zoomReaderBox = (await reader.boundingBox())!
    expect(zoomMenuBox!.x + zoomMenuBox!.width).toBeLessThanOrEqual(zoomReaderBox.x + zoomReaderBox.width - 7)
    expect(await zoomMenu.getByRole('button', { name: '100%' }).evaluate(element => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
    })).toBe(true)
    await zoomMenu.getByRole('button', { name: '100%' }).click()
    await zoomMenu.waitFor({ state: 'hidden' })
    expect(await zoomControl.getAttribute('aria-label')).toBe('Zoom: 100%')
    // Both dropdowns use the same decorative arrow inside one click target.
    const zoomArrow = zoomControl.locator('.dsh-pdf-toolbar-chevron')
    expect(await zoomArrow.count()).toBe(1)
    expect(await zoomArrow.evaluate(element => element.parentElement?.tagName)).toBe('SUMMARY')
    expect(await toolbar.locator('.dsh-pdf-toolbar-zoom button.dsh-pdf-toolbar-chevron').count()).toBe(0)
    expect((await zoomArrow.boundingBox())!.width).toBeGreaterThan(2)
    await zoomArrow.click()
    await zoomMenu.waitFor({ state: 'visible' })
    await zoomControl.click()
    await zoomMenu.waitFor({ state: 'hidden' })
    await chooseZoom(reader, 'Fit width')
    expect(await zoomControl.getAttribute('aria-label')).toBe('Zoom: Fit width')
    await reader.evaluate(element => { element.style.maxHeight = '220px' })
    await zoomControl.click()
    await expect.poll(() => zoomMenu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const [shortMenu, shortReader] = await Promise.all([zoomMenu.boundingBox(), reader.boundingBox()])
    expect(shortMenu).not.toBeNull()
    expect(shortReader).not.toBeNull()
    expect(shortMenu!.y + shortMenu!.height).toBeLessThanOrEqual(shortReader!.y + shortReader!.height + 1)
    await zoomMenu.getByRole('button', { name: '300%' }).click()
    expect(await zoomControl.getAttribute('aria-label')).toBe('Zoom: 300%')
    await chooseZoom(reader, 'Fit width')
    await reader.evaluate(element => { element.style.maxHeight = '' })
    await page.mouse.move(0, 0)
    const saveDescription = reader.locator('.dsh-pdf-save-control [role="status"]')
    expect(await reader.locator('.dsh-pdf-save-feedback').count()).toBe(0)
    expect(await save.getAttribute('data-save-state')).toBe('saved')
    expect(await save.isDisabled()).toBe(true)
    // This tab can mount below the responsive threshold. The wide-reader
    // scenario below owns the exact toolbar snapshot; here verify semantics.
    await expectIconOnlyMainToolbar(toolbar)

    // The desktop Mac shell uses this platform CSS and Electron app regions.
    // Chromium here verifies the selectable text layer and deferred selection
    // capture through the installed plugin; native macOS remains a separate check.
    await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin' })
    const textSpan = reader.locator('[data-pdf-page="1"] .dsh-pdf-text-layer span[data-pdf-run]').first()
    await textSpan.waitFor({ state: 'visible' })
    // Earlier bookmark/zoom actions can leave the first line outside the
    // reading viewport. Return to the page start before a real pointer drag.
    const selectionScroll = reader.locator('.dsh-pdf-scroll')
    await selectionScroll.evaluate(element => { element.scrollTo({ top: 0, left: 0, behavior: 'instant' }) })
    await expect.poll(() => selectionScroll.evaluate(element => element.scrollTop)).toBe(0)
    expect(await textSpan.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-user-select'))).toBe('text')
    expect(await reader.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
    // PDFium positions one span per glyph; the first span contains only "B".
    // Measure the full fixture line to exercise a real cross-glyph drag.
    const textLineBox = () => textSpan.evaluate(element => {
      const glyphs = [...element.parentElement!.querySelectorAll<HTMLElement>('span[data-pdf-run]')]
      const label = 'Browser PDF page one'
      if (!glyphs.map(glyph => glyph.textContent).join('').startsWith(label)) {
        throw new Error('The PDF text layer does not contain the fixture line')
      }
      let remaining = label.length
      const boxes: DOMRect[] = []
      for (const glyph of glyphs) {
        if (remaining <= 0) break
        boxes.push(glyph.getBoundingClientRect())
        remaining -= glyph.textContent?.length ?? 0
      }
      const left = Math.min(...boxes.map(box => box.left)), top = Math.min(...boxes.map(box => box.top))
      const right = Math.max(...boxes.map(box => box.right)), bottom = Math.max(...boxes.map(box => box.bottom))
      return { x: left, y: top, width: right - left, height: bottom - top }
    })
    await expect.poll(async () => (await textLineBox()).y).toBeGreaterThanOrEqual(contentBox!.y)
    const textBox = await textLineBox()
    await page.mouse.move(textBox.x + 8, textBox.y + textBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(textBox.x + textBox.width * 0.75, textBox.y + textBox.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toMatch(/rowser PDF pag/)
    const selectionToolbar = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await selectionToolbar.waitFor({ state: 'visible' })
    const selectionToolbarBox = await selectionToolbar.boundingBox()
    expect(selectionToolbarBox).not.toBeNull()
    expect(selectionToolbarBox!.x).toBeGreaterThanOrEqual(contentBox!.x)
    expect(selectionToolbarBox!.x + selectionToolbarBox!.width).toBeLessThanOrEqual(contentBox!.x + contentBox!.width + 1)
    expect(selectionToolbarBox!.y).toBeGreaterThanOrEqual(contentBox!.y)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(scaffold.authenticatedUrl).origin })
    await selectionToolbar.getByRole('button', { name: 'Copy text' }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/rowser PDF pag/)
    await selectionToolbar.getByRole('button', { name: 'Copied' }).waitFor({ state: 'visible' })
    await selectionToolbar.getByRole('button', { name: 'Translate', exact: true }).click()
    const translationPanel = reader.locator('.dsh-pdf-translation-panel')
    const panelTargetLanguage = translationPanel.locator('.dsh-pdf-translation-language-trigger')
    await panelTargetLanguage.waitFor({ state: 'visible' })
    await expect.poll(() => panelTargetLanguage.getAttribute('aria-label')).toBe('Target language: Chinese')
    await panelTargetLanguage.click()
    const languageMenu = translationPanel.locator('.dsh-pdf-translation-language-menu')
    expect((await languageMenu.getByRole('button').allTextContents()).map(label => label.trim()))
      .toEqual(['Chinese', 'English', 'Japanese', 'Korean', 'French', 'German'])
    await expect.poll(() => languageMenu.getByRole('button', { name: 'Chinese', exact: true }).getAttribute('aria-pressed'))
      .toBe('true')
    await panelTargetLanguage.focus()
    await page.keyboard.press('Escape')
    await languageMenu.waitFor({ state: 'hidden' })
    await translationPanel.getByRole('button', { name: 'Close translation' }).focus()
    await page.keyboard.press('Escape')
    await translationPanel.locator('.dsh-pdf-translation-content').waitFor({ state: 'hidden' })
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    const modeControl = toolbar.locator('.dsh-pdf-mode-explanation')
    const explanationStatus = reader.locator('.dsh-pdf-mode-explanation')
    await explanationStatus.waitFor({ state: 'visible' })
    const explanationEditor = reader.getByRole('dialog', { name: 'Ask about this passage' })
    const selectExcerpt = async (start: number, end: number) => {
      await reader.evaluate((element, offsets) => {
        const layer = element.querySelector('[data-pdf-page="1"] .dsh-pdf-text-layer')
        const glyphs = [...layer?.querySelectorAll<HTMLElement>('span[data-pdf-run]') ?? []]
        const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
        if (!scroll || !glyphs.map(glyph => glyph.textContent).join('').startsWith('Browser PDF page one')) {
          throw new Error('PDF text layer is not ready for explanation selection')
        }
        const position = (offset: number) => {
          for (const glyph of glyphs) {
            const length = glyph.textContent?.length ?? 0
            if (offset <= length && glyph.firstChild) return { node: glyph.firstChild, offset }
            offset -= length
          }
          throw new Error('PDF selection offset exceeds the fixture line')
        }
        const first = position(offsets[0]), last = position(offsets[1])
        const range = document.createRange()
        range.setStart(first.node, first.offset)
        range.setEnd(last.node, last.offset)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
        scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
      }, [start, end] as [number, number])
      await explanationEditor.waitFor({ state: 'visible' })
    }
    await selectExcerpt(0, 7)
    const explanationMarks = reader.locator('[data-pdf-explanation-mark]')
    expect(await explanationMarks.count()).toBe(0)
    await explanationEditor.getByRole('textbox').fill('Why does the first passage matter?')
    // Recapturing the same PDF glyphs must preserve the question already typed
    // into the in-progress explanation draft.
    await selectExcerpt(0, 7)
    expect(await explanationEditor.getByRole('textbox').inputValue()).toBe('Why does the first passage matter?')
    await explanationEditor.getByRole('button', { name: 'Save', exact: true }).click()
    // Saving a text passage is a Host round trip (selector re-extraction and
    // evidence persistence); the mark appears after that completes.
    await expect.poll(() => explanationMarks.count()).toBeGreaterThan(0)
    await explanationEditor.waitFor({ state: 'hidden' })
    await expect.poll(() => modeControl.locator('.dsh-pdf-mode-count').textContent()).toBe('1')
    expect(await explanationMarks.first().evaluate(element => element.tagName)).toBe('DIV')
    expect(await explanationMarks.first().evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    expect(await reader.locator('.dsh-pdf-explanation-overlay polygon').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-explanation-index').allTextContents()).toEqual(['1'])
    expect(await save.isDisabled()).toBe(true)
    await selectExcerpt(8, 15)
    await explanationEditor.getByRole('textbox').fill('How does the second passage differ?')
    await explanationEditor.getByRole('button', { name: 'Save', exact: true }).click()
    await explanationEditor.waitFor({ state: 'hidden' })
    await expect.poll(() => reader.locator('.dsh-pdf-explanation-index').allTextContents()).toEqual(['1', '2'])
    expect(await save.isDisabled()).toBe(true)
    await modeControl.locator('.dsh-pdf-explanation-materials-trigger').click()
    await reader.locator('.dsh-pdf-explanation-materials').getByRole('button', { name: 'Delete passage question 1', exact: true }).click()
    await page.keyboard.press('Escape')
    expect(await reader.locator('.dsh-pdf-explanation-index').allTextContents()).toEqual(['1'])
    await reader.getByRole('button', { name: 'Edit question for passage 1' }).click()
    expect(await explanationEditor.getByRole('textbox').inputValue())
      .toBe('How does the second passage differ?')
    await explanationEditor.getByRole('button', { name: 'Cancel' }).click()
    await explanationStatus.getByRole('button', { name: 'Exit explanation mode' }).click()
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(0)
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 8, y: 8 } })
    await selectionToolbar.waitFor({ state: 'hidden' })

    // The compact menu is the short-reader presentation; tall readers expose these commands directly.
    const menuViewport = page.viewportSize()!
    await page.setViewportSize({ ...menuViewport, height: 600 })
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    const toolsMenu = fileActions(reader)
    const fileItem = toolsMenu.getByRole('button', { name: 'Save as', exact: true })
    const noteTool = toolbar.getByRole('button', { name: 'Note', exact: true })
    const menuMaterial = await toolsMenu.evaluate(element => {
      const pod = element.closest('.dsh-pdf-reader')!.querySelector('.dsh-pdf-tool-rail-shell')!
      const menu = getComputedStyle(element), surface = getComputedStyle(pod)
      return { backgroundImage: menu.backgroundImage, backdropFilter: menu.backdropFilter,
        toolbarBackgroundImage: surface.backgroundImage, toolbarBackdropFilter: surface.backdropFilter }
    })
    expect(menuMaterial.backgroundImage).toBe(menuMaterial.toolbarBackgroundImage)
    expect(menuMaterial.backdropFilter).toBe(menuMaterial.toolbarBackdropFilter)
    expect(await toolsMenu.evaluate(element => getComputedStyle(element).borderRadius)).toBe('12px')
    expect(await fileItem.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('0px')
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await page.setViewportSize(menuViewport)
    const noteIdleBackground = await noteTool.evaluate(element => getComputedStyle(element).backgroundColor)
    await noteTool.hover()
    await expect.poll(() => noteTool.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(noteIdleBackground)
    await noteTool.click()
    await expect.poll(() => noteTool.getAttribute('aria-pressed')).toBe('true')
    await reader.locator('[data-pdf-page="1"].dsh-pdf-mode-note').click({ position: { x: 120, y: 140 } })
    const notePanel = reader.locator('.dsh-pdf-comments')
    const commentCard = reader.locator('.dsh-pdf-page-comment-card')
    const noteEditor = commentCard.getByRole('textbox', { name: 'Note' })
    await commentCard.waitFor({ state: 'visible' })
    await expect.poll(() => noteEditor.evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.type(NOTE)
    expect(await noteEditor.inputValue()).toBe(NOTE)
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => reader.getByRole('toolbar', { name: 'Selected annotation' }).count()).toBe(0)
    const noteCardPalette = await commentCard.evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, foreground: style.color, border: style.borderTopColor }
    })
    const closedNoteMarker = reader.locator('[data-pdf-page="1"] .dsh-pdf-note-marker[data-pdf-note-id]')
    await expect.poll(() => closedNoteMarker.count()).toBe(0)
    await commentCard.getByRole('button', { name: 'Close note', exact: true }).click()
    await expect.poll(() => closedNoteMarker.count()).toBe(1)
    await closedNoteMarker.first().waitFor({ state: 'visible' })
    const noteMarkerPalette = await closedNoteMarker.first().evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, foreground: style.color, border: style.borderTopColor }
    })
    expect(noteMarkerPalette).toEqual(noteCardPalette)
    await expect.poll(() => save.getAttribute('data-save-state')).toBe('dirty')
    expect(await saveDescription.textContent()).toBe('Unsaved changes')
    const [feedbackBox, feedbackContentBox, feedbackToolbarBox, feedbackControlsBox] = await Promise.all([
      save.boundingBox(), content.boundingBox(), toolbar.boundingBox(), reader.locator('.dsh-pdf-tool-rail').boundingBox(),
    ])
    expect(feedbackBox).not.toBeNull()
    expect(feedbackContentBox).not.toBeNull()
    expect(feedbackToolbarBox).not.toBeNull()
    // Save feedback stays in the command's fixed footprint, including while
    // the right sidebar changes width; it never adds a separate status bar.
    expect(feedbackControlsBox).not.toBeNull()
    expect(feedbackBox!.x).toBeGreaterThanOrEqual(feedbackToolbarBox!.x)
    expect(feedbackBox!.x + feedbackBox!.width).toBeLessThanOrEqual(feedbackToolbarBox!.x + feedbackToolbarBox!.width)
    expect(feedbackToolbarBox!.x + feedbackToolbarBox!.width)
      .toBeLessThanOrEqual(feedbackControlsBox!.x + feedbackControlsBox!.width)
    expect(feedbackBox!.y).toBeGreaterThanOrEqual(feedbackToolbarBox!.y)
    expect(feedbackBox!.y + feedbackBox!.height).toBeLessThanOrEqual(feedbackToolbarBox!.y + feedbackToolbarBox!.height)
    await expect.poll(() => save.isEnabled()).toBe(true).catch(async failure => {
      throw new Error(`${String(failure)}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
    // The Host has durably recorded this draft. It must not veto a Desktop
    // window unload merely because the original PDF still needs saving.
    expect(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    })).toBe(false)
    await openSidebarSection(reader, 'Annotations')
    await notePanel.locator('.dsh-pdf-comment-item').filter({ hasText: NOTE }).waitFor({ state: 'visible' })
    await expect.poll(() => notePanel.locator('.dsh-pdf-comment-item').getByText(NOTE, { exact: true }).count()).toBe(1)
    await expectIconOnlyMainToolbar(toolbar)

    // Sidebar width changes never remove the independent tool column's primary actions.
    const originalReaderWidth = await reader.evaluate(element => (element as HTMLElement).style.width)
    const originalContentSizing = await content.evaluate(element => {
      const style = (element as HTMLElement).style
      return { flex: style.flex, width: style.width }
    })
    const narrowMenuViewport = page.viewportSize()!
    await page.setViewportSize({ ...narrowMenuViewport, height: 600 })
    for (const paneWidth of [700, 400]) {
      await reader.evaluate((element, width) => { (element as HTMLElement).style.width = `${width}px` }, paneWidth)
      await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(paneWidth)
      await expectFloatingToolRails(reader)
      await expectIconOnlyMainToolbar(toolbar)
      const [zoomWidth, fileWidth] = await Promise.all([
        zoomControl.evaluate(element => element.getBoundingClientRect().width),
        toolbar.locator('.dsh-pdf-tools > summary').evaluate(element => element.getBoundingClientRect().width),
      ])
      expect(zoomWidth).toBeGreaterThanOrEqual(40)
      expect(Math.abs(zoomWidth - fileWidth)).toBeLessThanOrEqual(1)
      for (const name of ['Back', 'Undo PDF edit', 'Redo PDF edit', 'Save', 'Note', 'OCR page', 'Start explanation mode', 'Region screenshot'])
        expect(await toolbar.getByRole('button', { name, exact: true }).isVisible(), `${name} at ${paneWidth}px`).toBe(true)
      if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR)
        await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, `pdf-toolbar-${paneWidth}.png`) })
      await zoomControl.click()
      await zoomMenu.waitFor({ state: 'visible' })
      const popup = (await reader.locator('.dsh-pdf-zoom-menu').boundingBox())!
      const readerBox = (await reader.boundingBox())!, railBox = (await toolbar.boundingBox())!
      expect(popup.x).toBeGreaterThanOrEqual(railBox.x + railBox.width)
      expect(popup.x + popup.width).toBeLessThanOrEqual(readerBox.x + readerBox.width - 7)
      await zoomControl.click()
      await zoomMenu.waitFor({ state: 'hidden' })
      if (paneWidth === 400) {
        await toolbar.locator('.dsh-pdf-tools > summary').click()
        const menu = fileActions(reader)
        expect(await menu.getByRole('button', { name: 'Save as', exact: true }).isEnabled()).toBe(true)
        expect(await menu.getByRole('button', { name: 'Discard all changes', exact: true }).isEnabled()).toBe(true)
        for (const name of ['Back', 'Save', 'Note', 'OCR page', 'Start explanation mode', 'Region screenshot'])
          expect(await menu.getByRole('button', { name, exact: true }).count()).toBe(0)
        await menu.getByRole('button', { name: 'Save as', exact: true }).click()
        const saveAsDialog = reader.getByRole('dialog', { name: 'Save a PDF copy', exact: true })
        await saveAsDialog.getByRole('textbox', { name: 'File name' }).waitFor({ state: 'visible' })
        await saveAsDialog.getByRole('button', { name: 'Cancel' }).click()
        await saveAsDialog.waitFor({ state: 'hidden' })
        expect(await toolbar.locator('.dsh-pdf-toolbar-save').isEnabled()).toBe(true)
      }
    }
    await reader.evaluate((element, width) => { (element as HTMLElement).style.width = width }, originalReaderWidth)
    await page.setViewportSize(narrowMenuViewport)

    await expect.poll(() => reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').count()).toBeGreaterThan(0)
    await reader.evaluate(element => {
      const owner = window as typeof window & { __pdfPaintWatch?: { blanks: number; frame: number; active: boolean } }
      const watch = { blanks: 0, frame: 0, active: true }
      owner.__pdfPaintWatch = watch
      const sample = () => {
        if (!watch.active) return
        if (!element.querySelector('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]')) watch.blanks++
        watch.frame = requestAnimationFrame(sample)
      }
      sample()
    })
    await save.evaluate(element => {
      const owner = window as typeof window & {
        __pdfSaveFeedbackStates?: { state: string | null; at: number }[]
        __pdfSaveFeedbackObserver?: MutationObserver
      }
      owner.__pdfSaveFeedbackStates = []
      const record = () => {
        owner.__pdfSaveFeedbackStates!.push({
          state: element.getAttribute('data-save-state'), at: performance.now(),
        })
      }
      owner.__pdfSaveFeedbackObserver = new MutationObserver(record)
      owner.__pdfSaveFeedbackObserver.observe(element, { attributes: true, attributeFilter: ['data-save-state'] })
    })
    await save.click()
    await expect.poll(() => page.evaluate(() => {
      const owner = window as typeof window & { __pdfSaveFeedbackStates?: { state: string | null }[] }
      return owner.__pdfSaveFeedbackStates?.some(value => value.state === 'saved-success') ?? false
    }), { timeout: 5000 }).toBe(true).catch(async failure => {
      const states = await page.evaluate(() => {
        const owner = window as typeof window & { __pdfSaveFeedbackStates?: { state: string | null }[] }
        return owner.__pdfSaveFeedbackStates
      })
      throw new Error(`${String(failure)}\nFeedback states: ${JSON.stringify(states)}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(() => save.getAttribute('data-save-state'), { timeout: 5000 }).toBe('saved')
    expect(await saveDescription.textContent()).toBe('All changes saved')
    expect(await reader.locator('.dsh-pdf-save-feedback').count()).toBe(0)
    const feedbackStates = await page.evaluate(() => {
      const owner = window as typeof window & {
        __pdfSaveFeedbackStates?: { state: string | null; at: number }[]
        __pdfSaveFeedbackObserver?: MutationObserver
      }
      owner.__pdfSaveFeedbackObserver?.disconnect()
      const states = owner.__pdfSaveFeedbackStates ?? []
      delete owner.__pdfSaveFeedbackStates
      delete owner.__pdfSaveFeedbackObserver
      return states
    })
    const savedAt = feedbackStates.find(value => value.state === 'saved-success')?.at
    const hiddenAt = feedbackStates.find(value => savedAt !== undefined && value.at > savedAt && value.state === 'saved')?.at
    expect(savedAt).toBeDefined()
    expect(hiddenAt).toBeDefined()
    expect(hiddenAt! - savedAt!).toBeGreaterThanOrEqual(1900)
    await expect.poll(() => savedNoteContents(path)).toEqual([NOTE])
    await expect.poll(() => reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').count()).toBeGreaterThan(0)
    const blankFrames = await page.evaluate(() => {
      const owner = window as typeof window & { __pdfPaintWatch?: { blanks: number; frame: number; active: boolean } }
      const watch = owner.__pdfPaintWatch
      if (!watch) throw new Error('PDF paint watch was not installed')
      watch.active = false
      cancelAnimationFrame(watch.frame)
      delete owner.__pdfPaintWatch
      return watch.blanks
    })
    expect(blankFrames).toBe(0)
    expect(Buffer.from(await readFile(path)).equals(Buffer.from(original))).toBe(false)
    const savedNoteAria = await captureStableAria(page, '.dsh-pdf-comments', scaffold.workspaceCwd)
    expect(savedNoteAria).toMatch(/- time: [A-Z][a-z]{2} \d{1,2}, \d{4}/)
    await compareOrRefreshGolden(
      join(EXPECTED, 'saved-note.expected.md'),
      savedNoteAria.replace(/[A-Z][a-z]{2} \d{1,2}, \d{4}/g, '{{date}}'),
      webSnapshotMode(),
    )

    // Saving rematerializes the PDF and can assign a new annotation identity.
    // Select the saved row rather than relying on the pre-save selection.
    await notePanel.locator('.dsh-pdf-comment-item').filter({ hasText: NOTE }).click()
    const selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    const noteEditField = commentCard.getByRole('textbox', { name: 'Note' })
    await expect.poll(() => selectedToolbar.count()).toBe(0)
    await commentCard.waitFor({ state: 'visible' })
    expect(await noteEditField.count()).toBe(0)
    expect(await selectedToolbar.getByLabel('Selected annotation color').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-comment-connector').count()).toBe(0)
    await commentCard.getByRole('button', { name: 'Edit note', exact: true }).click()
    expect(await selectedToolbar.count()).toBe(0)
    await noteEditField.fill('Edited standalone note')
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => save.isEnabled()).toBe(true)
    const editedNoteFrame = await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().elementHandle()
    expect(editedNoteFrame).not.toBeNull()
    // Hold the same-resource refresh caused by Save. The old complete frame
    // and toolbar remain visible, so a single user click must wait for the
    // replacement display owner rather than disappear in the ownership gap.
    let releaseResourceOpen!: () => void
    const pendingResourceOpen = new Promise<void>(resolve => { releaseResourceOpen = resolve })
    let holdResourceOpen = true, heldResourceOpens = 0
    await page.route('**/api/pdf.dispatch.v2', async route => {
      if (holdResourceOpen && route.request().method() === 'POST' && route.request().postDataJSON()?.payload?.action === 'open') {
        heldResourceOpens++
        await pendingResourceOpen
      }
      try { await route.continue() } catch { /* A superseded resource open is cancelled. */ }
    })
    try {
      await save.click()
      await expect.poll(() => heldResourceOpens).toBeGreaterThan(0)
      const screenshotCommand = toolbar.getByRole('button', { name: 'Region screenshot', exact: true })
      expect(await screenshotCommand.isEnabled()).toBe(true)
      expect(await reader.locator('canvas[data-pdf-raster-ready="true"]').count()).toBeGreaterThan(0)
      await screenshotCommand.click()
      expect(await reader.locator('.dsh-pdf-mode-region').count()).toBe(0)
    } finally {
      holdResourceOpen = false
      releaseResourceOpen()
    }
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(() => savedNoteContents(path)).toEqual(['Edited standalone note'])
    // The disk write can precede Client acceptance and native replacement.
    // Entering a mode before that handoff would let the saved revision reset it.
    await expect.poll(() => save.getAttribute('data-save-state')).toMatch(/^saved(?:-success)?$/)
    await expect.poll(() => editedNoteFrame!.evaluate(canvas => canvas.isConnected)).toBe(false)
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible' })

    // Exercise the same cropped native render path used to prepare OCR images.
    const cropRequests: unknown[] = []
    page.on('request', request => {
      if (!request.url().endsWith('/api/pdf.native') || request.method() !== 'POST') return
      const body = request.postDataJSON()
      if (body.payload?.action === 'tile') cropRequests.push(body.payload.tile)
    })
    // The bundled OCR engine is available even without a session model.
    await expect.poll(() => toolbar.getByRole('button', { name: 'OCR page' }).isEnabled()).toBe(true)
    // The click above completes after the replacement is published, without
    // requiring a second click. Keep exercising capture and all later actions.
    await reader.locator('.dsh-pdf-mode-region').first().waitFor({ state: 'visible' })
    await expect.poll(() => reader.locator('.dsh-pdf-mode-inline').getAttribute('aria-label')).toBe('Drag to capture an area')
    expect(await reader.locator('.dsh-pdf-notice').filter({ hasText: 'Drag to capture an area' }).count()).toBe(0)
    // Mode changes stay inside the tool column; allow page geometry to settle
    // before calculating where to begin the drag.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await textSpan.scrollIntoViewIfNeeded()
    // A line must be inside the reading viewport before a real pointer drag.
    const obscuredText = await textLineBox()
    const floatingBoxes = await reader.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements
      .map(element => element.getBoundingClientRect()).map(box => ({ y: box.y, bottom: box.bottom })))
    const interactionSafeBottom = Math.max((await reader.locator('.dsh-pdf-scroll').boundingBox())!.y,
      ...floatingBoxes.map(box => box.bottom))
    if (obscuredText && obscuredText.y - 3 < interactionSafeBottom + 8) {
      const clearance = interactionSafeBottom + 12 - (obscuredText.y - 3)
      await reader.locator('.dsh-pdf-scroll').evaluate((element, delta) => { element.scrollTop -= delta }, clearance)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    }
    const shotText = await textLineBox()
    expect(shotText.y - 3).toBeGreaterThanOrEqual(interactionSafeBottom + 8)
    const sidebarBox = await reader.locator('.dsh-pdf-sidebar').boundingBox()
    const visibleTextWidth = sidebarBox
      ? Math.min(shotText.width, sidebarBox.x - shotText.x - 12)
      : shotText.width
    expect(visibleTextWidth).toBeGreaterThan(20)
    await page.mouse.move(shotText.x - 3, shotText.y - 3)
    await page.mouse.down()
    await page.mouse.move(shotText.x + visibleTextWidth, shotText.y + shotText.height + 3, { steps: 8 })
    await page.mouse.up()
    const screenshotStatus = reader.locator('[data-status-id="screenshot"]')
    await screenshotStatus.waitFor({ state: 'attached', timeout: 5_000 }).catch(async failure => {
      throw new Error(`${String(failure)}\nScreenshot did not enter capture phase: ${JSON.stringify({ shotText,
        mode: await reader.locator('.dsh-pdf-mode-region').count(), errors: tripwire.pageErrors })}`)
    })
    const preview = reader.getByRole('dialog', { name: 'Screenshot preview' })
    await preview.waitFor({ state: 'visible', timeout: 15_000 }).catch(async failure => {
      const dragStart = await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y)
        const root = document.querySelector('.dsh-pdf-scroll')
        return { target: target?.outerHTML.slice(0, 250), rootScrollTop: root?.scrollTop,
          mode: document.querySelector('.dsh-pdf-mode-region')?.getAttribute('class') }
      }, { x: shotText.x - 3, y: shotText.y - 3 })
      throw new Error(`${String(failure)}\nScreenshot drag: ${JSON.stringify({ shotText, dragStart,
        status: await screenshotStatus.innerText(), cropRequests,
        toolbar: await toolbar.boundingBox(), page: await reader.locator('[data-pdf-page="1"]').boundingBox() })}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
    await expect.poll(() => preview.getByRole('button', { name: 'Recognize region' }).isEnabled()).toBe(true)
    const screenshotInk = await preview.getByRole('img').evaluate(async element => {
      const image = element as HTMLImageElement
      await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      canvas.getContext('2d')!.drawImage(image, 0, 0)
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let ink = 0
      for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 120 && pixels[index + 1] < 120 && pixels[index + 2] < 120) ink++
      canvas.width = 0; canvas.height = 0; return ink
    })
    expect(screenshotInk, JSON.stringify({ shotText, cropRequests, page: await reader.locator('[data-pdf-page="1"]').boundingBox() })).toBeGreaterThan(100)
    await preview.getByRole('button', { name: 'Close', exact: true }).click()

    const firstPage = reader.locator('[data-pdf-page="1"]')
    const secondPage = reader.locator('[data-pdf-page="2"]')
    const widthBeforePinch = await firstPage.evaluate(element => element.offsetWidth)
    await firstPage.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      for (let index = 0; index < 24; index++) element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -7,
        clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
      }))
    })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    const firstPreview = await firstPage.boundingBox(), secondPreview = await secondPage.boundingBox()
    // Numeric stage previews may use separate transforms for mixed page sizes.
    // Assert the user-visible enlargement and deferred layout, rather than
    // requiring the superseded whole-track CSS transform implementation.
    expect(firstPreview!.width).toBeGreaterThan(widthBeforePinch)
    expect(await firstPage.evaluate(element => element.offsetWidth)).toBe(widthBeforePinch)
    expect(firstPreview && secondPreview && secondPreview.y - firstPreview.y - firstPreview.height).toBeGreaterThanOrEqual(0)
    await expect.poll(() => firstPage.evaluate(element => element.offsetWidth)).toBeGreaterThan(widthBeforePinch)
    await expect.poll(() => firstPage.evaluate(element => Math.abs(element.getBoundingClientRect().width - element.offsetWidth))).toBeLessThanOrEqual(1)
    const firstCommitted = await firstPage.boundingBox(), secondCommitted = await secondPage.boundingBox()
    expect(firstCommitted && secondCommitted && secondCommitted.y - firstCommitted.y - firstCommitted.height).toBeGreaterThanOrEqual(0)

    // The keyboard commands operate on the PDF draft, not an input. Deleting a
    // saved note can be undone, redone, and finally reverted by a confirmed
    // source reload without changing the on-disk PDF.
    await openSidebarSection(reader, 'Annotations')
    const savedRow = notePanel.locator('.dsh-pdf-comment-item').filter({ hasText: 'Edited standalone note' })
    await savedRow.click()
    await expect.poll(() => selectedToolbar.count()).toBe(0)
    await commentCard.waitFor({ state: 'visible' })
    await reader.locator('.dsh-pdf-scroll').focus()
    await page.keyboard.press('Delete')
    await expect.poll(() => savedRow.count()).toBe(0)
    await page.keyboard.press('Control+z')
    await expect.poll(() => savedRow.count()).toBe(1)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(() => savedRow.count()).toBe(0)
    await (await documentAction(reader, 'Reload source')).click()
    const reloadDialog = reader.locator('.dsh-pdf-dialog').filter({ hasText: 'Reload the source PDF and discard' })
    await reloadDialog.waitFor({ state: 'visible' })
    await reloadDialog.getByRole('button', { name: 'Cancel' }).click()
    expect(await savedRow.count()).toBe(0)
    await (await documentAction(reader, 'Reload source')).click()
    await reloadDialog.getByRole('button', { name: 'Reload source' }).click()
    await expect.poll(() => savedRow.count()).toBe(1)
    expect(await savedNoteContents(path)).toEqual(['Edited standalone note'])
    await savedRow.click()
    await expect.poll(() => selectedToolbar.count()).toBe(0)
    await commentCard.waitFor({ state: 'visible' })
    await reader.locator('.dsh-pdf-scroll').focus()
    await page.keyboard.press('Delete')
    await expect.poll(() => savedRow.count()).toBe(0)
    await content.evaluate(element => {
      const style = (element as HTMLElement).style
      style.flex = '0 0 400px'
      style.width = '400px'
    })
    await (await documentAction(reader, 'Discard all changes')).click()
    await expect.poll(() => savedRow.count()).toBe(1)
    await content.evaluate((element, sizing) => {
      const style = (element as HTMLElement).style
      style.flex = sizing.flex
      style.width = sizing.width
    }, originalContentSizing)

    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(EXPECTED, [
      'opened-toolbar.expected.md', 'dirty-toolbar.expected.md', 'saved-note.expected.md',
    ])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
