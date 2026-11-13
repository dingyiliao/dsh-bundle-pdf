import { expect, it, onTestFailed } from 'vitest'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { newEnglishPage, saveFailureShot, launchWebScaffold, seedSession, watchConsole, MODEL_FIXTURE, MODEL_FIXTURE_AVAILABLE, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chooseZoom, documentAction, mountReaderToolRail, saveToolRailShot, setToolRail, toolRailCalls } from '../support/toolbar.ts'
import { FILE_NAME, sourcePdf } from '../support/documents.ts'

it('keeps explanation Send centered and its empty, selecting, sending, unavailable-image and error states usable in the left tool rail', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 500 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-left-tool-rail-explanation'))
    await mountReaderToolRail(page)
    const send = page.locator('.dsh-pdf-explanation-status-send'), area = page.locator('.dsh-pdf-explanation-status-area')
    const states = [{ count: 0 }, { count: 2 }, { count: 2, sending: true }, { count: 2, selectingArea: true },
      { count: 2, imageAvailable: false, error: 'Explanation request failed' }]
    for (const language of ['en', 'zh'] as const) for (const state of states) {
      await setToolRail(page, { language, mode: 'explanation', tasks: 'concurrent', ...state })
      await send.waitFor()
      await expect.poll(() => send.isDisabled()).toBe(!state.count || !!state.sending || !!state.selectingArea)
      expect(await area.isDisabled()).toBe(state.imageAvailable === false || !!state.sending)
      expect(await page.locator('.dsh-pdf-explanation-status-exit').isDisabled()).toBe(false)
      expect(await page.locator('.dsh-pdf-tool-note, .dsh-pdf-tool-ocr, .dsh-pdf-tool-explain').count()).toBe(0)
      expect(await page.locator('.dsh-pdf-mode-count').count()).toBe(state.count ? 1 : 0)
      if (state.count) expect(await page.locator('.dsh-pdf-mode-count').textContent()).toBe(String(state.count))
      if (state.imageAvailable === false) expect(await area.locator('..').getAttribute('data-tooltip')).toBe('Image engine unavailable')
      for (const viewport of [{ width: 1180, height: 500 }, { width: 500, height: 500 }, { width: 320, height: 500 },
        { width: 500, height: 450 }, { width: 240, height: 320 }]) {
        await page.setViewportSize(viewport)
        if (state.error) await setToolRail(page, { language, mode: 'explanation', tasks: 'concurrent', ...state })
        const fixedActions = page.locator('.dsh-pdf-explanation-status-send, .dsh-pdf-explanation-status-exit')
        const fixedLayout = () => fixedActions.evaluateAll(controls => controls.map(element => {
          const bounds = element.getBoundingClientRect(), shell = element.closest('.dsh-pdf-tool-rail-shell')!.getBoundingClientRect()
          const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
          return bounds.top >= shell.top && bounds.bottom <= shell.bottom && bounds.left >= shell.left && bounds.right <= shell.right
            && (hit === element || !!hit && element.contains(hit))
        }).every(Boolean))
        await expect.poll(fixedLayout, { message: `fixed explanation controls at ${viewport.width}×${viewport.height}` }).toBe(true)
        const sendY = (await send.boundingBox())!.y
        // Scrolling an area tool must not move Send / Exit out of the short rail.
        await area.scrollIntoViewIfNeeded()
        expect(Math.abs((await send.boundingBox())!.y - sendY)).toBeLessThanOrEqual(1)
        expect(await fixedLayout()).toBe(true)
        await send.scrollIntoViewIfNeeded()
        await expect.poll(() => send.evaluate(button => {
          const bounds = button.getBoundingClientRect()
          const children = [...button.querySelectorAll<HTMLElement>(':scope > svg, :scope > .dsh-pdf-floating-status-spinner')].filter(child => child.checkVisibility())
            .map(child => child.getBoundingClientRect())
          const left = Math.min(...children.map(child => child.left)), right = Math.max(...children.map(child => child.right))
          const top = Math.min(...children.map(child => child.top)), bottom = Math.max(...children.map(child => child.bottom))
          return { centeredX: Math.abs((left + right - bounds.left - bounds.right) / 2) <= 1,
            centeredY: Math.abs((top + bottom - bounds.top - bounds.bottom) / 2) <= 1 }
        }), { message: `${language} ${JSON.stringify(state)} at ${viewport.width}×${viewport.height}` })
          .toEqual({ centeredX: true, centeredY: true })
        if (state.error) {
          const indicator = page.locator('.dsh-pdf-activity-trigger')
          await indicator.scrollIntoViewIfNeeded()
          if (await indicator.getAttribute('aria-expanded') !== 'true') await indicator.click()
          const error = page.locator('[data-status-id="explanation"]')
          await error.waitFor({ state: 'visible' })
          expect(await error.textContent()).toContain(state.error)
          expect(await error.evaluate(element => {
            const bounds = element.getBoundingClientRect(), reader = element.closest('.dsh-pdf-reader')!.getBoundingClientRect()
            return !element.closest('[data-pdf-tool-rail]') && bounds.left >= 56 && bounds.right <= reader.right - 7
              && bounds.top >= reader.top + 7 && bounds.bottom <= reader.bottom - 7
          })).toBe(true)
        }
        if (language === 'en' && (viewport.width === 240 || viewport.width === 1180 && state.count === 2 && !state.sending && !state.selectingArea && !state.error))
          await saveToolRailShot(page, `explanation-${state.error ? 'error' : state.sending ? 'sending' : state.selectingArea ? 'selecting' : state.count ? 'ready' : 'empty'}-${viewport.width}x${viewport.height}`)
        if (state.error) {
          await page.locator('[data-status-id="explanation"]').getByRole('button', { name: language === 'en' ? 'Dismiss' : '关闭提示', exact: true }).click()
          await expect.poll(() => page.locator('[data-status-id="explanation"]').count()).toBe(0)
          await page.keyboard.press('Escape')
          expect(await page.locator('.dsh-pdf-activity-trigger').evaluate(element => document.activeElement === element)).toBe(true)
        }
      }
    }
    await setToolRail(page, { mode: 'explanation' })
    const materialTrigger = page.locator('.dsh-pdf-explanation-materials-trigger')
    await materialTrigger.click()
    const materials = page.locator('.dsh-pdf-explanation-materials')
    expect(await materials.locator('.dsh-pdf-explanation-material').count()).toBe(2)
    await materials.locator('.dsh-pdf-explanation-material-edit').first().click()
    expect(await toolRailCalls(page)).toContain('edit-question:material-0')
    await materialTrigger.click()
    await materials.locator('.dsh-pdf-explanation-material-remove').nth(1).click()
    expect(await toolRailCalls(page)).toContain('remove-question:material-1')
    await page.keyboard.press('Escape')
    expect(await materialTrigger.evaluate(element => document.activeElement === element)).toBe(true)
    await send.click()
    await area.click()
    await page.locator('.dsh-pdf-explanation-status-exit').click()
    expect(await toolRailCalls(page)).toEqual(expect.arrayContaining(['send', 'select-area', 'exit-explanation']))
    await setToolRail(page, { mode: 'explanation', selectingArea: true })
    await expect.poll(() => area.getAttribute('aria-pressed')).toBe('true')
    expect(await area.getAttribute('aria-label')).toBe('Cancel region selection')
    await area.click()
    await page.locator('.dsh-pdf-explanation-status-exit').click()
    for (const mode of ['note', 'region'] as const) {
      await setToolRail(page, { mode })
      await page.locator('.dsh-pdf-mode-control').getByRole('button', { name: 'Cancel', exact: true }).click()
      await saveToolRailShot(page, `mode-${mode}-240x320`)
    }
    expect((await toolRailCalls(page)).filter(action => action === 'select-area')).toHaveLength(2)
    expect((await toolRailCalls(page)).filter(action => action === 'cancel-mode')).toHaveLength(2)
  } finally { await browser.close() }
}, 45_000)

it('requires a question before saving an explanation passage, then edits or removes its page mark', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-explanation-mark-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF explanation mark test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-explanation-mark-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF explanation mark test' }).click()
    const reader = page.locator('.dsh-pdf-reader')
    if (!await reader.isVisible()) {
      const column = page.locator('[data-rightbar-col]')
      if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
      await column.locator('[data-sidebar-right-guide-entry="files"]').click()
      await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
      await column.locator('[data-files-reload]').click()
      await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()
    }
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page one')
    const mainToolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const statusRail = reader.locator('.dsh-pdf-main-toolbar')
    await mainToolbar.getByRole('button', { name: 'Note', exact: true }).click()
    await statusRail.locator('[data-status-id="note-mode"]').waitFor({ state: 'visible' })
    expect(await reader.locator('.dsh-pdf-notice').filter({ hasText: 'Click on the page to place a note.' }).count()).toBe(0)
    await mainToolbar.getByRole('button', { name: 'Region screenshot' }).click()
    const regionStatus = statusRail.locator('[data-status-id="region-selection"]')
    await regionStatus.waitFor({ state: 'visible' })
    expect(await statusRail.locator('[data-status-id="note-mode"]').count()).toBe(0)
    const regionContent = reader.locator('.dsh-pdf-content')
    const originalRegionContentStyle = await regionContent.getAttribute('style')
    try {
      await regionContent.evaluate(element => {
        const style = (element as HTMLElement).style
        style.flex = 'none'
        style.width = '1000px'
      })
      await regionStatus.evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished))
      })
      const [regionToolbarBox, regionStatusBox] = await Promise.all([
        mainToolbar.boundingBox(), regionStatus.boundingBox(),
      ])
      expect(regionStatusBox!.y).toBeGreaterThanOrEqual(regionToolbarBox!.y)
      expect(regionStatusBox!.x).toBeGreaterThanOrEqual(regionToolbarBox!.x)
      expect(regionStatusBox!.x + regionStatusBox!.width)
        .toBeLessThanOrEqual(regionToolbarBox!.x + regionToolbarBox!.width)
    } finally {
      await regionContent.evaluate((element, style) => {
        if (style === null) element.removeAttribute('style')
        else element.setAttribute('style', style)
      }, originalRegionContentStyle)
    }
    await reader.locator('.dsh-pdf-scroll').focus()
    await page.keyboard.press('Escape')
    await regionStatus.waitFor({ state: 'hidden' })
    expect(await reader.locator('.dsh-pdf-mode-region').count()).toBe(0)
    const stableBack = await mainToolbar.locator('.dsh-pdf-toolbar-back-split').elementHandle()
    const stableSave = await mainToolbar.locator('.dsh-pdf-save-control').elementHandle()
    if (!stableBack || !stableSave) throw new Error('Fixed reader toolbar controls are unavailable')
    const stableControlY = [(await stableBack.boundingBox())!.y, (await stableSave.boundingBox())!.y]
    await mainToolbar.getByRole('button', { name: 'Start explanation mode' }).focus()
    await page.keyboard.press('Enter')
    const modeControl = mainToolbar.locator('.dsh-pdf-mode-explanation')
    const status = reader.locator('.dsh-pdf-mode-explanation')
    await status.waitFor({ state: 'visible' })
    await expect.poll(() => status.locator('.dsh-pdf-explanation-select-text').evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.press('Tab')
    expect(await status.evaluate(element => element.contains(document.activeElement))).toBe(true)
    expect(await stableBack.evaluate(element => element === document.querySelector('.dsh-pdf-toolbar-back-split'))).toBe(true)
    expect(await stableSave.evaluate(element => element === document.querySelector('.dsh-pdf-save-control'))).toBe(true)
    expect(Math.abs((await stableBack.boundingBox())!.y - stableControlY[0])).toBeLessThanOrEqual(1)
    expect(Math.abs((await stableSave.boundingBox())!.y - stableControlY[1])).toBeLessThanOrEqual(1)
    expect(await statusRail.locator('[data-status-id="region-selection"]').count()).toBe(0)
    expect(await mainToolbar.getByRole('button', { name: 'Note', exact: true }).count()).toBe(0)
    // Explanation replaces the ordinary capture action with its own image
    // question entry. The text-only session keeps that sole action disabled.
    expect(await mainToolbar.getByRole('button', { name: 'Region screenshot' }).count()).toBe(0)
    expect(await mainToolbar.getByRole('button', { name: 'Select image region' }).isDisabled()).toBe(true)
    expect(await status.getByRole('button', { name: 'Select image region' }).count()).toBe(1)
    expect(await status.getByRole('button', { name: 'Send for explanation' }).isDisabled()).toBe(true)
    const [toolbarBox, statusBox, modeBox, contentBox, controlsBox] = await Promise.all([
      mainToolbar.boundingBox(), status.boundingBox(), modeControl.boundingBox(), reader.locator('.dsh-pdf-content').boundingBox(),
      reader.locator('.dsh-pdf-tool-rail').boundingBox(),
    ])
    expect(toolbarBox).not.toBeNull()
    expect(statusBox).not.toBeNull()
    expect(modeBox).not.toBeNull()
    expect(contentBox).not.toBeNull()
    expect(controlsBox).not.toBeNull()
    expect(modeBox!.x).toBeGreaterThanOrEqual(toolbarBox!.x)
    expect(modeBox!.x + modeBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width)
    expect(statusBox!.x).toBeGreaterThanOrEqual(toolbarBox!.x)
    expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width)
    expect(statusBox!.y).toBeGreaterThanOrEqual(toolbarBox!.y)
    expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(toolbarBox!.y + toolbarBox!.height)
    if (process.env.DSH_PDF_FLOATING_PREVIEW_PATH) {
      await reader.screenshot({ path: process.env.DSH_PDF_FLOATING_PREVIEW_PATH.replace(/\.png$/, '-explanation.png') })
    }
    const content = reader.locator('.dsh-pdf-content')
    const originalContentStyle = await content.getAttribute('style')
    try {
      await content.evaluate(element => {
        const style = (element as HTMLElement).style
        style.flex = 'none'
        style.width = '1000px'
      })
      const [wideToolbar, wideStatus, wideContent] = await Promise.all([
        mainToolbar.boundingBox(), status.boundingBox(), content.boundingBox(),
      ])
      expect(wideContent!.width).toBe(1000)
      expect(wideStatus!.y).toBeGreaterThanOrEqual(wideToolbar!.y)
      expect(wideStatus!.y + wideStatus!.height).toBeLessThanOrEqual(wideToolbar!.y + wideToolbar!.height)
      expect(wideStatus!.x).toBeGreaterThanOrEqual(wideToolbar!.x)
      expect(wideStatus!.x + wideStatus!.width).toBeLessThanOrEqual(wideToolbar!.x + wideToolbar!.width)
      const overflowingActions = await status.evaluate(element => {
        const card = element.getBoundingClientRect()
        return [...element.querySelectorAll('button')].filter(button => button.getBoundingClientRect().right > card.right + 1)
          .map(button => button.getAttribute('aria-label') ?? button.textContent?.trim())
      })
      expect(overflowingActions).toEqual([])
    } finally {
      await content.evaluate((element, style) => {
        if (style === null) element.removeAttribute('style')
        else element.setAttribute('style', style)
      }, originalContentStyle)
    }
    const originalReaderStyle = await reader.getAttribute('style')
    try {
      await reader.evaluate(element => { (element as HTMLElement).style.width = '365px' })
      await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(365)
      const [narrowToolbar, narrowMode, narrowSidebar, narrowReader] = await Promise.all([
        mainToolbar.boundingBox(), modeControl.boundingBox(), reader.locator('.dsh-pdf-sidebar').boundingBox(),
        reader.boundingBox(),
      ])
      expect(narrowToolbar).not.toBeNull(); expect(narrowMode).not.toBeNull()
      expect(narrowSidebar).not.toBeNull(); expect(narrowReader).not.toBeNull()
      expect(narrowMode!.x + narrowMode!.width).toBeLessThanOrEqual(narrowToolbar!.x + narrowToolbar!.width)
      expect(narrowToolbar!.x).toBeGreaterThan(narrowReader!.x)
      expect(narrowToolbar!.width).toBe(56)
      expect(narrowToolbar!.x + narrowToolbar!.width).toBeLessThanOrEqual(narrowReader!.x + narrowReader!.width - 11)
      // Floating rails remain independently usable, including at the narrowest width.
      expect(narrowToolbar!.x + narrowToolbar!.width).toBeLessThanOrEqual(narrowSidebar!.x)
    } finally {
      await reader.evaluate((element, style) => {
        if (style === null) element.removeAttribute('style')
        else element.setAttribute('style', style)
      }, originalReaderStyle)
    }
    const selectFirstWordForExplanation = async () => {
      await expect.poll(async () => reader.locator('[data-pdf-page="1"] [data-pdf-text="active"] span[data-pdf-run]').count(), { timeout: 15_000 }).toBeGreaterThan(0)
      return reader.evaluate(element => {
      const layer = element.querySelector('[data-pdf-page="1"] [data-pdf-text="active"]')
      const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
      const first = layer?.querySelector<HTMLElement>('span[data-pdf-run]')
      if (!first || !scroll) throw new Error('PDF text layer is not ready for explanation selection')
      const glyphs = [...layer!.querySelectorAll<HTMLElement>('span[data-pdf-run]')]
        .filter(span => span.dataset.pdfRun === first.dataset.pdfRun)
      if (!glyphs.map(span => span.textContent).join('').startsWith('Browser')) {
        throw new Error('The PDF test page needs a positioned initial word')
      }
      let offset = 7
      const endSpan = glyphs.find(span => {
        const length = span.textContent?.length ?? 0
        if (offset <= length) return true
        offset -= length
        return false
      })
      const start = glyphs[0]?.firstChild, end = endSpan?.firstChild
      if (!start || !end) throw new Error('PDF glyph text nodes are unavailable')
      const range = document.createRange()
      range.setStart(start, 0)
      range.setEnd(end, offset)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
      })
    }
    await selectFirstWordForExplanation()

    const editor = reader.getByRole('dialog', { name: 'Ask about this passage' })
    await editor.waitFor({ state: 'visible', timeout: 10_000 })
    const passageQuestion = editor.getByRole('textbox')
    const saveQuestion = editor.getByRole('button', { name: 'Save', exact: true })
    if (process.env.PDF_EXPLANATION_SCREENSHOT) {
      await page.screenshot({ path: process.env.PDF_EXPLANATION_SCREENSHOT })
    }
    await expect.poll(() => page.evaluate(() => {
      const active = document.activeElement
      return active?.closest('.dsh-pdf-explanation-question-editor') ? 'question editor'
        : `${active?.tagName ?? 'none'} ${active?.getAttribute('class') ?? ''}`
    })).toBe('question editor')
    expect(await saveQuestion.isDisabled()).toBe(true)
    await passageQuestion.fill('  ')
    expect(await saveQuestion.isDisabled()).toBe(true)
    const preview = reader.locator('[data-pdf-explanation-preview]')
    await expect.poll(() => preview.count()).toBe(1)
    expect(await preview.first().evaluate(element => ({ tag: element.tagName, hidden: element.getAttribute('aria-hidden') })))
      .toEqual({ tag: 'SPAN', hidden: 'true' })
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(0)
    expect(await reader.getByRole('button', { name: 'Edit question for passage 1' }).count()).toBe(0)
    await passageQuestion.fill('Why is this passage important?')
    expect(await saveQuestion.isEnabled()).toBe(true)
    // Pausing an unfinished question must retain its text without creating a
    // counted material. Re-entering after ordinary reading has moved away must
    // reveal the original passage and focus its editor, rather than leaving the
    // whole explanation rail disabled behind an off-screen editor.
    await status.getByRole('button', { name: 'Exit explanation mode' }).click()
    await editor.waitFor({ state: 'hidden' })
    // In this narrow Files column both fit-width test pages can fit at once;
    // use a genuine scrollable scale so the pending anchor really leaves view.
    await chooseZoom(reader, '200%')
    const pendingPage = reader.getByRole('textbox', { name: 'Page', exact: true })
    await pendingPage.fill('2')
    await pendingPage.press('Enter')
    await expect.poll(() => pendingPage.inputValue()).toBe('2')
    await reader.locator('[data-pdf-page="2"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => pendingPage.isEnabled()).toBe(true)
    await expect.poll(() => mainToolbar.getByRole('button', { name: 'Start explanation mode' }).isEnabled()).toBe(true)
    await reader.locator('.dsh-pdf-scroll').evaluate(root => { root.scrollTop = root.scrollHeight })
    await expect.poll(() => pendingPage.inputValue()).toBe('2')
    const awayFromPending = await reader.locator('.dsh-pdf-scroll').evaluate(root => root.scrollTop)
    // Hold animation frames after mode entry so a real page step supersedes
    // the return navigation before it can finish its layout commit.
    await page.clock.install()
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 500))
    try {
      await mainToolbar.getByRole('button', { name: 'Start explanation mode' }).evaluate((button: HTMLButtonElement) => button.click())
      await expect.poll(() => pendingPage.isDisabled()).toBe(true)
      await reader.locator('.dsh-pdf-page-step:enabled').first().evaluate((button: HTMLButtonElement) => button.click())
    } finally { await page.clock.resume() }
    await status.waitFor({ state: 'hidden' })
    await editor.waitFor({ state: 'hidden' })
    await reader.getByText('The page is not ready yet. Please retry.', { exact: true }).waitFor({ state: 'visible' })
    // Failure preserves the uncounted question and unlocks ordinary reading.
    // Explicit mode entry can then resume it after the newer navigation ends.
    await expect.poll(() => pendingPage.isEnabled()).toBe(true)
    await expect.poll(() => mainToolbar.getByRole('button', { name: 'Start explanation mode' }).isEnabled()).toBe(true)
    await mainToolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    await editor.waitFor({ state: 'visible' })
    await expect.poll(() => passageQuestion.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await passageQuestion.inputValue()).toBe('Why is this passage important?')
    expect(await status.locator('.dsh-pdf-mode-count').count()).toBe(0)
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(0)
    expect(awayFromPending - await reader.locator('.dsh-pdf-scroll').evaluate(root => root.scrollTop)).toBeGreaterThan(30)
    await chooseZoom(reader, 'Fit width')
    await saveQuestion.click()
    await editor.waitFor({ state: 'hidden' })
    await expect.poll(() => preview.count()).toBe(0)
    const marker = reader.getByRole('button', { name: 'Edit question for passage 1' })
    await marker.waitFor({ state: 'visible' })
    expect(await status.getByRole('button', { name: 'Send for explanation' }).isEnabled()).toBe(true)
    const marks = reader.locator('[data-pdf-explanation-mark]')
    await expect.poll(() => marks.count()).toBe(1)
    expect(await marks.first().evaluate(element => ({
      tag: element.tagName,
      visible: element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0,
      color: getComputedStyle(element).backgroundColor,
    }))).toMatchObject({ tag: 'DIV', visible: true })
    expect(await marks.first().evaluate(element => getComputedStyle(element).backgroundColor))
      .not.toBe('rgba(0, 0, 0, 0)')
    expect(await reader.locator('.dsh-pdf-explanation-overlay polygon').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-explanation-index').allTextContents()).toEqual(['1'])
    // Switching modes preserves both fixed tool groups and the saved material.
    // The list can reopen the question without moving an already visible anchor.
    await mainToolbar.getByRole('button', { name: 'Exit explanation mode' }).focus()
    await page.keyboard.press('Enter')
    await status.waitFor({ state: 'hidden' })
    await expect.poll(() => mainToolbar.getByRole('button', { name: 'Start explanation mode' }).evaluate(element => document.activeElement === element)).toBe(true)
    expect(await marks.count()).toBe(0)
    await page.keyboard.press('Enter')
    await status.waitFor({ state: 'visible' })
    await expect.poll(() => status.locator('.dsh-pdf-mode-count').textContent()).toBe('1')
    await expect.poll(() => marks.count()).toBe(1)
    const beforeListEdit = await reader.locator('.dsh-pdf-scroll').evaluate(root => root.scrollTop)
    await status.locator('.dsh-pdf-explanation-materials-trigger').click()
    const materials = reader.locator('.dsh-pdf-explanation-materials')
    // The popover is portaled outside the rail. Its close/delete artwork must
    // remain painted even though ordinary toolbar icons default to hidden.
    for (const icon of [materials.getByRole('button', { name: 'Close explanation materials', exact: true }).locator('svg'),
      materials.getByRole('button', { name: 'Delete passage question 1', exact: true }).locator('svg')]) {
      expect(await icon.evaluate(element => {
        const box = element.getBoundingClientRect()
        return getComputedStyle(element).display !== 'none' && box.width >= 14 && box.height >= 14
      })).toBe(true)
    }
    await materials.getByRole('button', { name: 'Edit question for passage 1', exact: true }).click()
    await editor.waitFor({ state: 'visible' })
    expect(await passageQuestion.inputValue()).toBe('Why is this passage important?')
    expect(Math.abs(await reader.locator('.dsh-pdf-scroll').evaluate(root => root.scrollTop) - beforeListEdit)).toBeLessThanOrEqual(1)
    await editor.getByRole('button', { name: 'Cancel' }).click()
    const [markBox, statusBoxAfterSave] = await Promise.all([marks.first().boundingBox(), status.boundingBox()])
    expect(markBox).not.toBeNull()
    expect(statusBoxAfterSave).not.toBeNull()
    await marker.click()
    await editor.waitFor({ state: 'visible' })
    expect(await editor.getByRole('textbox').inputValue()).toBe('Why is this passage important?')
    await expect.poll(() => editor.getByRole('textbox').evaluate(element => document.activeElement === element)).toBe(true)
    await editor.getByRole('textbox').fill(' ')
    expect(await editor.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    await editor.getByRole('textbox').fill('A discarded edit')
    await editor.getByRole('button', { name: 'Cancel' }).click()
    await marker.click()
    expect(await editor.getByRole('textbox').inputValue()).toBe('Why is this passage important?')
    await expect.poll(() => editor.getByRole('textbox').evaluate(element => document.activeElement === element)).toBe(true)
    await editor.getByRole('textbox').fill('Why is the revised passage important?')
    await expect.poll(() => editor.getByRole('textbox').inputValue()).toBe('Why is the revised passage important?')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await marker.click()
    await expect.poll(() => editor.getByRole('textbox').inputValue()).toBe('Why is the revised passage important?')
    await editor.getByRole('button', { name: /Delete|Remove passage/ }).click()
    await expect.poll(() => marks.count()).toBe(0)
    expect(await marker.count()).toBe(0)
    expect(await status.getByRole('button', { name: 'Send for explanation' }).isDisabled()).toBe(true)
    // Recreate a passage and send it through the ordinary Session prompt API.
    // This proves the browser action becomes a visible user turn, not merely a
    // local draft that disappears when the PDF tab closes.
    await selectFirstWordForExplanation()
    await editor.waitFor({ state: 'visible' })
    await editor.getByRole('textbox').fill('Explain this first word in context.')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => status.getByRole('button', { name: 'Send for explanation' }).isEnabled()).toBe(true)
    if (process.env.DSH_PDF_EXPLANATION_SCREENSHOT_DIR) {
      const directory = process.env.DSH_PDF_EXPLANATION_SCREENSHOT_DIR
      await mkdir(directory, { recursive: true })
      const readerStyle = await reader.getAttribute('style')
      const enterFullscreen = page.locator('[data-sidebar-right-mode="fullscreen"]')
      const changeDock = await enterFullscreen.isVisible()
      if (changeDock) await enterFullscreen.click()
      try {
        await reader.evaluate(element => { Object.assign((element as HTMLElement).style, { width: '900px', height: '640px' }) })
        await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(900)
        await reader.screenshot({ path: join(directory, 'explanation-real-wide.png') })
        await status.locator('.dsh-pdf-explanation-materials-trigger').click()
        await reader.locator('.dsh-pdf-explanation-materials').waitFor({ state: 'visible' })
        await reader.screenshot({ path: join(directory, 'explanation-real-materials.png') })
        await page.keyboard.press('Escape')
        await reader.evaluate(element => { Object.assign((element as HTMLElement).style, { width: '350px', height: '320px' }) })
        await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(350)
        await expect.poll(() => reader.evaluate(element => element.clientHeight)).toBe(320)
        await reader.screenshot({ path: join(directory, 'explanation-real-narrow-short.png') })
      } finally {
        await reader.evaluate((element, style) => {
          if (style === null) element.removeAttribute('style')
          else element.setAttribute('style', style)
        }, readerStyle)
        if (changeDock) await page.locator('[data-sidebar-right-mode="push"]').click()
      }
    }
    // A lost connection must keep the question as an editable draft and show
    // why the ordinary Session prompt could not be queued. The user can retry
    // after reconnecting rather than reconstructing the PDF selection.
    await page.context().setOffline(true)
    await status.getByRole('button', { name: 'Send for explanation' }).click()
    await reader.locator('.dsh-pdf-activity-trigger').click()
    const explanationError = reader.locator('[data-status-id="explanation"]')
    await explanationError.waitFor({ state: 'visible', timeout: 10_000 })
    expect((await explanationError.textContent())?.trim()).toBeTruthy()
    expect(await reader.locator('.dsh-pdf-activity-trigger').getAttribute('aria-expanded')).toBe('true')
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(1)
    await expect.poll(() => status.getByRole('button', { name: 'Retry explanation', exact: true }).isEnabled()).toBe(true)
    await page.context().setOffline(false)
    await page.keyboard.press('Escape')
    await status.getByRole('button', { name: 'Retry explanation', exact: true }).click()
    await status.waitFor({ state: 'hidden', timeout: 20_000 })
    await expect.poll(() => page.locator('[class*="centerCol"]')
      .getByText('Explain this first word in context.', { exact: false }).count(),
      { timeout: 20_000 }).toBeGreaterThan(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)

it.skipIf(!MODEL_FIXTURE_AVAILABLE)('captures an explanation image on another page only after a vision model is selected', async () => {
  // The real replay adapter publishes image-input metadata without issuing a
  // model call; the question stays a draft until the user explicitly sends it.
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: ROOT, enabled: true }] },
    replayFixture: MODEL_FIXTURE,
    replayProvidersOnly: true,
  })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-explanation-region-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF explanation image test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-explanation-region-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF explanation image test' }).click()
    const column = page.locator('[data-rightbar-col]')
    if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    const status = reader.locator('.dsh-pdf-mode-explanation')
    const imageRegion = toolbar.getByRole('button', { name: 'Select image region' })
    await status.waitFor({ state: 'visible' })
    expect(await imageRegion.count()).toBe(1)
    expect(await status.getByRole('button', { name: 'Select image region' }).count()).toBe(1)
    // The seeded text-only model must not offer a screenshot it cannot read.
    await expect.poll(() => imageRegion.isDisabled()).toBe(true)
    await status.getByRole('button', { name: 'Exit explanation mode' }).click()
    await status.waitFor({ state: 'hidden' })
    const selection = await scaffold.ctx.sessionController.selectModel({ sessionId,
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    expect(selection).toMatchObject({ selected: { model: 'deepseek-v4-flash-vision-exp' } })
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    await status.waitFor({ state: 'visible' })
    await expect.poll(() => imageRegion.isEnabled()).toBe(true)

    // Area selection is a reversible mode; cancelling it must leave the
    // explanation draft available for the next actual region selection.
    await imageRegion.click()
    await expect.poll(() => toolbar.getByRole('button', { name: 'Cancel region selection' }).getAttribute('aria-pressed')).toBe('true')
    await toolbar.getByRole('button', { name: 'Cancel region selection' }).click()
    await expect.poll(() => imageRegion.getAttribute('aria-pressed')).toBe('false')

    const secondPage = reader.locator('[data-pdf-page="2"]')
    await secondPage.scrollIntoViewIfNeeded()
    await secondPage.locator('canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await chooseZoom(reader, '200%')
    const scroll = reader.locator('.dsh-pdf-scroll')
    await scroll.evaluate(root => {
      const wrap = root.querySelector<HTMLElement>('[data-page-number="2"]')!
      const stage = wrap.querySelector<HTMLElement>('.dsh-pdf-page-stage')!
      root.scrollTop = wrap.offsetTop + stage.offsetHeight - root.clientHeight + 24
    })
    await imageRegion.click()
    await reader.locator('.dsh-pdf-mode-region[data-pdf-page="2"]').waitFor({ state: 'visible' })
    const box = await secondPage.boundingBox()
    const bar = await toolbar.boundingBox()
    if (!box || !bar) throw new Error('The second PDF page is not available for region selection')
    const scrollBox = (await reader.locator('.dsh-pdf-scroll').boundingBox())!
    const padding = await scroll.evaluate(root => ({ left: parseFloat(getComputedStyle(root).paddingLeft), right: parseFloat(getComputedStyle(root).paddingRight) }))
    const start = { x: Math.max(box.x + 52, scrollBox.x + padding.left + 20), y: Math.max(box.y + box.height - 150, scrollBox.y + 18) }
    const end = { x: Math.min(box.x + box.width - 20, scrollBox.x + scrollBox.width - padding.right - 12, start.x + 180),
      y: Math.min(box.y + box.height - 20, start.y + 75) }
    expect(end.x - start.x).toBeGreaterThan(20)
    expect(end.y - start.y).toBeGreaterThan(20)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 8 })
    await page.mouse.up()

    const editor = reader.getByRole('dialog', { name: 'Ask about this passage' })
    await editor.waitFor({ state: 'visible', timeout: 10_000 })
    const save = editor.getByRole('button', { name: 'Save', exact: true })
    expect(await save.isDisabled()).toBe(true)
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(0)
    await editor.getByRole('textbox').fill('What does this part of the second page show?')
    await save.click()
    await editor.waitFor({ state: 'hidden', timeout: 20_000 })
    const regionMark = secondPage.locator('[data-pdf-explanation-mark][data-pdf-explanation-kind="region"]')
    await regionMark.waitFor({ state: 'visible' })
    expect(await status.getByRole('button', { name: 'Send for explanation' }).isEnabled()).toBe(true)
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(1)
    const pageField = reader.getByRole('textbox', { name: 'Page', exact: true })
    const editFromList = async () => {
      await status.locator('.dsh-pdf-explanation-materials-trigger').click()
      await reader.locator('.dsh-pdf-explanation-materials').getByRole('button', { name: 'Edit question for passage 1', exact: true }).click()
      await editor.waitFor({ state: 'visible' })
      expect(await editor.getByRole('textbox').inputValue()).toBe('What does this part of the second page show?')
      expect(await pageField.inputValue()).toBe('2')
    }
    // The material is near the bottom of a tall page. Jumping only to the page
    // start would leave its question anchor offscreen and the editor hidden.
    await scroll.evaluate(async root => {
      const wrap = root.querySelector<HTMLElement>('[data-page-number="2"]')!
      root.scrollTop = wrap.offsetTop - 20
      root.dispatchEvent(new Event('scroll', { bubbles: true }))
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    })
    expect(await regionMark.evaluate(element => {
      const bounds = element.getBoundingClientRect(), viewport = element.closest('.dsh-pdf-scroll')!.getBoundingClientRect()
      return bounds.top >= viewport.bottom || bounds.bottom <= viewport.top
    })).toBe(true)
    const samePageTop = await scroll.evaluate(root => root.scrollTop)
    await editFromList()
    expect(await scroll.evaluate(root => root.scrollTop)).toBeGreaterThan(samePageTop + 100)
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await pageField.fill('1'); await pageField.press('Enter')
    await expect.poll(() => pageField.isEnabled()).toBe(true)
    await editFromList()
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    // Reloading the source creates a new document content version. Its saved
    // explanation question must not be offered against the replacement view.
    await (await documentAction(reader, 'Reload source')).click()
    await status.waitFor({ state: 'hidden', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-explanation-mark]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)

it.skipIf(!MODEL_FIXTURE_AVAILABLE)('stops accepting explanation passages and image regions at the visible item limit', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: ROOT, enabled: true }] },
    replayFixture: MODEL_FIXTURE,
    replayProvidersOnly: true,
  })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-explanation-limit-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF explanation limit test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())
    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-explanation-limit-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF explanation limit test' }).click()
    const column = page.locator('[data-rightbar-col]')
    if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] [data-pdf-text="active"] span[data-pdf-run]').first()
      .waitFor({ state: 'attached', timeout: 20_000 })
    const selection = await scaffold.ctx.sessionController.selectModel({ sessionId,
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    expect(selection).toMatchObject({ selected: { model: 'deepseek-v4-flash-vision-exp' } })
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    const modeControl = toolbar.locator('.dsh-pdf-mode-explanation')
    const status = reader.locator('.dsh-pdf-mode-explanation')
    await status.waitFor({ state: 'visible' })
    const editor = reader.getByRole('dialog', { name: 'Ask about this passage' })
    const selectPassage = () => reader.evaluate(element => {
      const layer = element.querySelector('[data-pdf-page="1"] [data-pdf-text="active"]')
      const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
      const first = layer?.querySelector<HTMLElement>('span[data-pdf-run]')
      if (!first || !scroll) throw new Error('PDF passage is not available for selection')
      const glyphs = [...layer!.querySelectorAll<HTMLElement>('span[data-pdf-run]')]
        .filter(span => span.dataset.pdfRun === first.dataset.pdfRun)
      let offset = 7
      const last = glyphs.find(span => {
        const length = span.textContent?.length ?? 0
        if (offset <= length) return true
        offset -= length
        return false
      })
      if (!glyphs[0]?.firstChild || !last?.firstChild) throw new Error('PDF passage glyphs are unavailable')
      const range = document.createRange()
      range.setStart(glyphs[0].firstChild, 0)
      range.setEnd(last.firstChild, offset)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
    })
    for (let index = 1; index <= 20; index++) {
      await selectPassage()
      await editor.waitFor({ state: 'visible' })
      await editor.getByRole('textbox').fill(`Question ${index} about the same passage?`)
      await editor.getByRole('button', { name: 'Save', exact: true }).click()
      await editor.waitFor({ state: 'hidden' })
      await expect.poll(() => modeControl.locator('.dsh-pdf-mode-count').textContent()).toBe(String(index))
    }
    const imageRegion = toolbar.getByRole('button', { name: 'Select image region' })
    await expect.poll(() => imageRegion.isDisabled()).toBe(true)
    await selectPassage()
    await reader.locator('.dsh-pdf-activity-trigger').click()
    const explanationError = reader.locator('[data-status-id="explanation"]')
    await explanationError.waitFor({ state: 'visible' })
    await expect.poll(() => explanationError.textContent())
      .toContain('Up to 20 passages or regions can be explained together.')
    expect(await editor.count()).toBe(0)
    expect(await imageRegion.isDisabled()).toBe(true)
    await expect.poll(() => reader.locator('.dsh-pdf-mode-region').count()).toBe(0)
    expect(await modeControl.locator('.dsh-pdf-mode-count').textContent()).toBe('20')
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(20)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)
