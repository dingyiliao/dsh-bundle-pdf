import { expect, it, onTestFailed } from 'vitest'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { newEnglishPage, saveFailureShot, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, EXPECTED, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser, type Locator } from 'playwright'
import { build } from 'esbuild'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { ToolRailFixture, captureToolbarEditsAria, expectFloatingToolRails, expectIconOnlyMainToolbar, fileActions, mountReaderToolRail, openSidebarSection, saveToolRailShot, setToolRail, toolRailCalls } from '../support/toolbar.ts'
import { FILE_NAME, sourcePdf } from '../support/documents.ts'

it('floats the 56px left tool rail above a full-width canvas with one glass shell and three persistent groups at narrow widths and short heights', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 600 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-left-tool-rail-layout'))
    await mountReaderToolRail(page)
    const rail = page.locator('[data-pdf-tool-rail]')
    expect(await rail.locator('[data-tool-group]').evaluateAll(groups => groups.map(group => group.getAttribute('data-tool-group'))))
      .toEqual(['navigation', 'interaction', 'document'])
    const inspect = () => rail.evaluate(element => {
      const bounds = element.getBoundingClientRect(), body = element.parentElement!.getBoundingClientRect()
      const content = element.parentElement!.querySelector('.dsh-pdf-content')!.getBoundingClientRect()
      const podElements = [...element.querySelectorAll<HTMLElement>('[data-tool-group]')]
      const pods = podElements.map(pod => pod.getBoundingClientRect())
      const shell = element.querySelector<HTMLElement>('.dsh-pdf-tool-rail-shell')!
      const shellStyle = getComputedStyle(shell)
      const back = element.querySelector<HTMLElement>('.dsh-pdf-toolbar-back-split')!
      const history = back.querySelector<HTMLElement>('.dsh-pdf-split-action-trigger')!
      const navigation = element.querySelector<HTMLElement>('[data-tool-group="navigation"]')!.getBoundingClientRect()
      const zoomChevron = element.querySelector<HTMLElement>('.dsh-pdf-toolbar-zoom .dsh-pdf-toolbar-chevron')!.getBoundingClientRect()
      return { width: bounds.width, fullCanvas: Math.abs(content.left - body.left) < 1 && Math.abs(content.right - body.right) < 1,
        railInset: bounds.left > body.left && shell.getBoundingClientRect().top > body.top && shell.getBoundingClientRect().bottom < body.bottom,
        railBottom: bounds.bottom, bodyBottom: body.bottom,
        glassShell: shellStyle.backgroundImage !== 'none' && shellStyle.backdropFilter.includes('blur')
          && element.querySelectorAll('.dsh-pdf-glass').length === 1,
        transparentGroups: podElements.every(pod => getComputedStyle(pod).backgroundImage === 'none'
          && getComputedStyle(pod).backdropFilter === 'none'),
        backFits: back.getBoundingClientRect().width <= 40.5 && history.getBoundingClientRect().width >= 16
          && [...element.querySelectorAll<HTMLElement>('[data-tool-group="navigation"] button, [data-tool-group="navigation"] summary')]
            .every(control => { const box = control.getBoundingClientRect(); return box.left >= navigation.left - .5 && box.right <= navigation.right + .5 }),
        zoomChevronVisible: zoomChevron.width > 0 && zoomChevron.height > 0,
        podsInside: pods.every(pod => pod.left >= bounds.left && pod.right <= bounds.right),
        navigationInside: pods[0]!.top >= bounds.top && pods[0]!.bottom <= bounds.bottom,
        documentInside: pods[2]!.top >= bounds.top && pods[2]!.bottom <= bounds.bottom,
        pageTopReserved: content.top !== body.top,
        horizontalOverflow: element.parentElement!.scrollWidth > element.parentElement!.clientWidth }
    })
    for (const language of ['en', 'zh'] as const) for (const mode of ['text', 'explanation', 'note', 'region'] as const) {
      await setToolRail(page, { language, mode, tasks: 'concurrent' })
      for (const viewport of [{ width: 1180, height: 600 }, { width: 500, height: 600 }, { width: 320, height: 600 },
        { width: 240, height: 600 }, { width: 500, height: 450 }, { width: 1180, height: 320 }, { width: 500, height: 320 },
        { width: 320, height: 320 }, { width: 240, height: 320 }]) {
        await page.setViewportSize(viewport)
        await expect.poll(inspect, { message: `${language} ${mode} at ${viewport.width}×${viewport.height}` })
          .toMatchObject({ width: 56, glassShell: true, transparentGroups: true, backFits: true, zoomChevronVisible: true,
            podsInside: true, navigationInside: true, documentInside: true,
            pageTopReserved: false, horizontalOverflow: false, fullCanvas: true, railInset: true })
        expect(await rail.locator('[data-overflow-hidden]').count()).toBe(0)
        expect(await rail.getByRole('group', { name: language === 'en' ? 'Tools' : '工具', exact: true }).count()).toBe(0)
        // Every primary action remains reachable in the middle group's short-height scroller.
        for (const selector of mode === 'explanation'
          ? ['.dsh-pdf-explanation-select-text', '.dsh-pdf-explanation-status-area', '.dsh-pdf-explanation-materials-trigger']
          : ['.dsh-pdf-tool-explain', '.dsh-pdf-tool-note', '.dsh-pdf-tool-screenshot', '.dsh-pdf-tool-ocr']) {
          const button = rail.locator(selector)
          await button.scrollIntoViewIfNeeded()
          expect(await button.evaluate(element => {
            const bounds = element.getBoundingClientRect(), rail = element.closest('[data-pdf-tool-rail]')!.getBoundingClientRect()
            const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
            return bounds.top >= rail.top && bounds.bottom <= rail.bottom && bounds.left >= rail.left && bounds.right <= rail.right
              && (hit === element || !!hit && element.contains(hit))
          })).toBe(true)
        }
        if (language === 'en' && mode === 'text' || language === 'zh' && mode === 'explanation' && viewport.width === 320)
          await saveToolRailShot(page, `${language}-${mode}-${viewport.width}x${viewport.height}`)
      }
    }
    // Below the normal desktop reading height, the intact rail may scroll as a
    // fallback. It must preserve every command rather than overlap its groups.
    await page.setViewportSize({ width: 320, height: 260 })
    await setToolRail(page, { mode: 'explanation', tasks: 'concurrent' })
    for (const selector of ['.dsh-pdf-toolbar-back-split > button:first-child', '.dsh-pdf-toolbar-zoom > summary',
      '.dsh-pdf-explanation-select-text', '.dsh-pdf-explanation-status-area', '.dsh-pdf-explanation-materials-trigger',
      '.dsh-pdf-explanation-status-send', '.dsh-pdf-explanation-status-exit', '.dsh-pdf-toolbar-save',
      '.dsh-pdf-tools > summary', '.dsh-pdf-activity-trigger']) {
      const control = rail.locator(selector)
      await control.scrollIntoViewIfNeeded()
      expect(await control.evaluate(element => {
        const box = element.getBoundingClientRect(), shell = element.closest('.dsh-pdf-rail-shell')!.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return box.top >= shell.top && box.bottom <= shell.bottom && (hit === element || !!hit && element.contains(hit))
      })).toBe(true)
    }
    await saveToolRailShot(page, 'emergency-scroll-320x260')
    if (process.env.DSH_PDF_TOOL_RAIL_PREVIEW_DIR) {
      await page.setViewportSize({ width: 1180, height: 600 })
      await setToolRail(page, { mode: 'explanation', context: true, tasks: 'concurrent' })
      await page.evaluate(() => {
        document.body.dataset.dsDarkTheme = 'true'
        document.documentElement.style.cssText = '--dsw-alias-bg-base:#1d1f23; --dsw-alias-bg-layer-1:#282b30; --dsw-alias-label-primary:#eceef1; --dsw-alias-label-secondary:#a2a7b0; --dsw-alias-border-l2:#484e57; --dsw-alias-bg-document-preview:#171a1e; --dsw-alias-interactive-bg-hover:#3e444d; --dsw-alias-button-primary-fill:#eceef1; --dsw-alias-label-primary-foreground:#171a1e;'
      })
      await saveToolRailShot(page, 'dark-explanation-context-1180x600')
    }
  } finally { await browser.close() }
}, 60_000)

it('keeps left tool rail document commands expanded when height permits and gives both 56px sidebars matching one-piece interactive glass shells', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 }, reducedMotion: 'reduce' })
    onTestFailed(() => saveFailureShot(page, 'pdf-matching-sidebar-pods'))
    await mountReaderToolRail(page)
    const left = page.locator('[data-pdf-tool-rail]'), right = page.locator('.dsh-pdf-sidebar')
    const direct = left.locator('.dsh-pdf-document-direct')
    const compact = left.locator('.dsh-pdf-document-menu')
    await expect.poll(() => direct.isVisible()).toBe(true)
    expect(await compact.isVisible()).toBe(false)
    for (const [name, action] of [['Save as', 'save-as'], ['Reload source', 'reload'], ['Discard all changes', 'discard']] as const) {
      await direct.getByRole('button', { name, exact: true }).click()
      expect(await toolRailCalls(page)).toContain(action)
    }
    const hoverChanges = async (control: Locator) => {
      await page.mouse.move(600, 300)
      const before = await control.evaluate(element => getComputedStyle(element).backgroundColor)
      await control.hover()
      await expect.poll(() => control.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(before)
      await page.keyboard.press('Tab')
      await control.focus()
      expect(await control.evaluate(element => element.matches(':focus-visible')
        && (getComputedStyle(element).outlineStyle !== 'none' || getComputedStyle(element).boxShadow !== 'none'))).toBe(true)
    }
    await hoverChanges(left.locator('.dsh-pdf-toolbar-zoom > summary'))
    await hoverChanges(direct.getByRole('button', { name: 'Save as', exact: true }))
    await hoverChanges(right.getByRole('tab', { name: 'Search', exact: true }))
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
    expect(await right.locator('.dsh-pdf-sidebar-rail .dsh-pdf-glass').count()).toBe(1)
    expect(await left.locator('.dsh-pdf-tool-rail-shell.dsh-pdf-glass').count()).toBe(1)
    expect(await right.locator('.dsh-pdf-sidebar-sections, .dsh-pdf-sidebar-compact-nav')
      .evaluateAll(groups => groups.every(group => getComputedStyle(group).backgroundImage === 'none'
        && getComputedStyle(group).backdropFilter === 'none'))).toBe(true)
    expect(await left.locator('.dsh-pdf-tool-history').evaluate(element => getComputedStyle(element).flexDirection)).toBe('column')
    const pageInput = right.getByRole('textbox', { name: 'Page', exact: true })
    await pageInput.fill('1146')
    await pageInput.press('Enter')
    expect(await right.locator('.dsh-pdf-page-total').textContent()).toBe('1151')
    expect(await pageInput.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    const material = () => page.locator('.dsh-pdf-reader').evaluate(element => {
      const pods = [...element.querySelectorAll<HTMLElement>('.dsh-pdf-tool-rail-shell, .dsh-pdf-sidebar-rail-shell')]
      const left = getComputedStyle(pods[0]!)
      return pods.every(pod => {
        const style = getComputedStyle(pod)
        return style.borderRadius === left.borderRadius && style.backgroundImage === left.backgroundImage
          && style.backdropFilter === left.backdropFilter && style.backgroundImage !== 'none'
      })
    })
    expect(await material()).toBe(true)
    for (const viewport of [{ width: 1180, height: 800 }, { width: 760, height: 800 },
      { width: 380, height: 600 }, { width: 320, height: 320 }]) {
      await page.setViewportSize(viewport)
      for (const sidebarExpanded of viewport.width >= 760 ? [false, true] : [false]) {
        await setToolRail(page, { sidebarExpanded, sidebarSection: 'bookmarks' })
        await expect.poll(() => right.getByRole('tab', { name: 'Bookmarks', exact: true }).getAttribute('aria-expanded'))
          .toBe(String(sidebarExpanded))
        await expect.poll(() => page.locator('.dsh-pdf-body').evaluate(element => {
          const body = element.getBoundingClientRect(), left = element.querySelector('[data-pdf-tool-rail]')!.getBoundingClientRect()
          const content = element.querySelector('.dsh-pdf-content')!.getBoundingClientRect(), right = element.querySelector('.dsh-pdf-sidebar')!.getBoundingClientRect()
          return { fullCanvas: Math.abs(content.left - body.left) < 1 && Math.abs(content.right - body.right) < 1,
            floatingRails: left.left > body.left && right.right < body.right
              && element.querySelector('.dsh-pdf-tool-rail-shell')!.getBoundingClientRect().top > body.top
              && element.querySelector('.dsh-pdf-sidebar-rail-shell')!.getBoundingClientRect().top > body.top,
            bounded: left.right <= right.left && right.right <= body.right && content.width > 0 && element.scrollWidth <= element.clientWidth,
            railWidth: left.width, rightWidth: right.width }
        }), { message: `floating rails at ${viewport.width}×${viewport.height}, expanded=${sidebarExpanded}` })
          .toMatchObject({ fullCanvas: true, floatingRails: true, bounded: true, railWidth: 56, ...(!sidebarExpanded ? { rightWidth: 56 } : {}) })
        if (sidebarExpanded) {
          await expect.poll(() => right.locator('.dsh-pdf-sidebar-main').evaluate(element => {
            const box = element.getBoundingClientRect(), body = element.closest('.dsh-pdf-body')!
            const left = body.querySelector('[data-pdf-tool-rail]')!.getBoundingClientRect(), rail = body.querySelector('.dsh-pdf-sidebar-rail')!.getBoundingClientRect()
            return box.left > left.right && box.right <= rail.left && box.width > 100 && getComputedStyle(element).borderRadius === '18px'
          })).toBe(true)
          expect(await right.getByRole('heading', { name: 'Bookmarks', exact: true }).isVisible()).toBe(true)
        }
        expect(await right.locator('.dsh-pdf-sidebar-rail').evaluate(element => {
          const rail = element.getBoundingClientRect(), center = (rail.left + rail.right) / 2
          return [...element.querySelectorAll<HTMLElement>('.dsh-pdf-sidebar-tab, .dsh-pdf-page-input, .dsh-pdf-page-step')]
            .every(control => { const box = control.getBoundingClientRect(); return Math.abs((box.left + box.right) / 2 - center) <= .5 })
        })).toBe(true)
        await saveToolRailShot(page, `matching-pods-${sidebarExpanded ? 'expanded' : 'collapsed'}-${viewport.width}x${viewport.height}`)
      }
    }
    await expect.poll(() => direct.isVisible()).toBe(false)
    expect(await compact.isVisible()).toBe(true)
    await compact.locator('summary').click()
    const menu = page.locator('.dsh-pdf-tools-menu').filter({ has: page.getByRole('button', { name: 'Save as', exact: true }) })
    await menu.getByRole('button', { name: 'Save as', exact: true }).click()
    expect(await toolRailCalls(page)).toContain('save-as')
    await page.keyboard.press('Escape')
    for (const tab of await right.getByRole('tab').all()) {
      await tab.scrollIntoViewIfNeeded()
      expect(await tab.evaluate(element => {
        const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return hit === element || !!hit && element.contains(hit)
      })).toBe(true)
    }
    await page.setViewportSize({ width: 1180, height: 600 })
    await compact.locator('summary').click()
    await menu.waitFor({ state: 'visible' })
    await page.setViewportSize({ width: 1180, height: 800 })
    await expect.poll(() => compact.locator('summary').getAttribute('aria-expanded')).toBe('false')
    expect(await menu.isVisible()).toBe(false)
    expect(await direct.isVisible()).toBe(true)
    await setToolRail(page, { sidebarExpanded: true, sidebarSection: 'bookmarks' })
    await page.evaluate(() => {
      document.body.dataset.dsDarkTheme = 'true'
      document.documentElement.style.cssText = '--dsw-alias-bg-base:#1d1f23; --dsw-alias-bg-layer-1:#282b30; --dsw-alias-label-primary:#eceef1; --dsw-alias-label-secondary:#a2a7b0; --dsw-alias-border-l2:#484e57; --dsw-alias-bg-document-preview:#171a1e; --dsw-alias-interactive-bg-hover:#3e444d; --dsw-alias-button-primary-fill:#eceef1; --dsw-alias-label-primary-foreground:#171a1e;'
    })
    expect(await material()).toBe(true)
    await saveToolRailShot(page, 'matching-pods-expanded-dark-1180x800')
  } finally { await browser.close() }
}, 45_000)

it('keeps one persistent page navigation capsule editable through sidebar expansion, collapse and short-height scrolling', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 600 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-persistent-page-navigation'))
    await mountReaderToolRail(page)
    const sidebar = page.locator('.dsh-pdf-sidebar')
    const pagination = sidebar.locator('.dsh-pdf-sidebar-compact-nav')
    const input = pagination.getByRole('textbox', { name: 'Page', exact: true })
    const toggle = sidebar.getByRole('tab', { selected: true })
    expect(await sidebar.locator('.dsh-pdf-sidebar-toggle').count()).toBe(0)
    const initialInput = await input.elementHandle()
    const initialBounds = (await pagination.boundingBox())!
    for (const expanded of [true, false, true]) {
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe(String(expanded))
      await expect.poll(() => pagination.evaluate(element => {
        const bounds = element.getBoundingClientRect(), reader = element.closest('.dsh-pdf-reader')!.getBoundingClientRect()
        return { visible: getComputedStyle(element).visibility, opacity: getComputedStyle(element).opacity,
          inert: (element as HTMLElement).inert, inside: bounds.bottom <= reader.bottom && bounds.top >= reader.top }
      })).toEqual({ visible: 'visible', opacity: '1', inert: false, inside: true })
      expect(await sidebar.getByRole('textbox', { name: 'Page', exact: true }).count()).toBe(1)
      expect(await sidebar.locator('.dsh-pdf-page-input').count()).toBe(1)
      expect(await sidebar.locator('.dsh-pdf-sidebar-footer').count()).toBe(0)
      expect(await input.evaluate((element, original) => element === original, initialInput)).toBe(true)
      const bounds = (await pagination.boundingBox())!
      expect(Math.abs(bounds.x - initialBounds.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(bounds.y - initialBounds.y)).toBeLessThanOrEqual(1)
      await page.evaluate(() => (window as typeof window & { __pdfToolbarLayoutFixture: ToolRailFixture }).__pdfToolbarLayoutFixture.resetCalls())
      await input.fill('6')
      await input.press('Enter')
      await input.blur()
      await expect.poll(() => toolRailCalls(page)).toEqual(['page:6'])
      await pagination.getByRole('button', { name: 'Next page', exact: true }).click()
      await expect.poll(() => input.inputValue()).toBe('7')
      await expect.poll(() => toolRailCalls(page)).toEqual(['page:6', 'page:7'])
      await pagination.getByRole('button', { name: 'Previous page', exact: true }).click()
      await expect.poll(() => input.inputValue()).toBe('6')
      await expect.poll(() => toolRailCalls(page)).toEqual(['page:6', 'page:7', 'page:6'])
    }
    // A short host scrolls section tabs, never the persistent page controls.
    await page.setViewportSize({ width: 1180, height: 320 })
    for (const expanded of [false, true]) {
      await setToolRail(page, { sidebarExpanded: expanded })
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe(String(expanded))
      await expect.poll(() => pagination.evaluate(element => {
        const bounds = element.getBoundingClientRect(), reader = element.closest('.dsh-pdf-reader')!.getBoundingClientRect()
        return bounds.top >= reader.top && bounds.bottom <= reader.bottom && element.getAttribute('aria-hidden') !== 'true'
      })).toBe(true)
      for (const tab of await sidebar.getByRole('tab').all()) {
        await tab.scrollIntoViewIfNeeded()
        expect(await tab.evaluate(element => {
          const bounds = element.getBoundingClientRect(), hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
          return hit === element || !!hit && element.contains(hit)
        })).toBe(true)
      }
      await input.fill('9')
      await input.press('Enter')
      await expect.poll(() => input.inputValue()).toBe('9')
    }
    await saveToolRailShot(page, 'persistent-paging-expanded-1180x320')
  } finally { await browser.close() }
}, 30_000)

it('keeps left tool rail actions direct, file commands complete and menus opening to the right with real concurrent task statuses', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 600 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-left-tool-rail-commands'))
    await mountReaderToolRail(page)
    const rail = page.locator('[data-pdf-tool-rail]')
    for (const [selector, action] of [['.dsh-pdf-tool-ocr', 'ocr'], ['.dsh-pdf-tool-explain', 'explanation'],
      ['.dsh-pdf-tool-screenshot', 'screenshot'], ['.dsh-pdf-tool-note', 'note'], ['.dsh-pdf-toolbar-save', 'save'],
      ['.dsh-pdf-tool-history .dsh-pdf-toolbar-undo', 'undo'], ['.dsh-pdf-tool-history .dsh-pdf-toolbar-redo', 'redo']] as const) {
      await rail.locator(selector).click()
      expect(await toolRailCalls(page)).toContain(action)
    }
    const assertRightPanel = async (trigger: Locator, panel: Locator, name: string) => {
      await trigger.click()
      await panel.waitFor({ state: 'visible' })
      await expect.poll(async () => {
        const anchor = (await trigger.boundingBox())!, menu = (await panel.boundingBox())!
        const reader = (await page.locator('.dsh-pdf-reader').boundingBox())!
        return { right: menu.x >= anchor.x + anchor.width - 1, inReader: menu.x + menu.width <= reader.x + reader.width - 7
          && menu.y >= reader.y + 7 && menu.y + menu.height <= reader.y + reader.height - 7 }
      }, { message: name }).toEqual({ right: true, inReader: true })
      expect(await panel.evaluate(element => element.closest('.dsh-pdf-reader') !== null
        && element.closest('[data-pdf-tool-rail]') === null)).toBe(true)
    }
    for (const viewport of [{ width: 1180, height: 600 }, { width: 500, height: 450 }, { width: 500, height: 320 }, { width: 320, height: 320 }, { width: 240, height: 320 }]) {
      await page.setViewportSize(viewport)
      await setToolRail(page, { tasks: 'concurrent' })
      const file = rail.locator('.dsh-pdf-tools > summary'), fileMenu = page.locator('.dsh-pdf-tools-menu').filter({ has: page.getByRole('button', { name: 'Save as', exact: true }) })
      expect(await file.getAttribute('aria-label')).toBe('Document actions')
      await assertRightPanel(file, fileMenu, `file at ${viewport.width}×${viewport.height}`)
      expect((await fileMenu.getByRole('button').allTextContents()).sort()).toEqual([
        'Reload source', 'Save as', 'Discard all changes',
        ...(viewport.height <= 480 ? ['Undo PDF edit', 'Redo PDF edit'] : []),
      ].sort())
      if (viewport.height <= 480) for (const [name, action] of [['Undo PDF edit', 'undo'], ['Redo PDF edit', 'redo']] as const) {
        await fileMenu.getByRole('button', { name, exact: true }).click()
        expect(await toolRailCalls(page)).toContain(action)
      }
      expect(await fileMenu.getByRole('button', { name: 'Start explanation mode', exact: true }).count()).toBe(0)
      if (viewport.width === 240) await saveToolRailShot(page, 'file-menu-240x320')
      await page.keyboard.press('Escape')
      await expect.poll(() => file.getAttribute('aria-expanded')).toBe('false')
      expect(await file.evaluate(element => document.activeElement === element)).toBe(true)
      if (viewport.width === 1180) for (const [name, action] of [['Reload source', 'reload'],
        ['Save as', 'save-as'], ['Discard all changes', 'discard']] as const) {
        await file.click()
        await fileMenu.getByRole('button', { name, exact: true }).click()
        expect(await toolRailCalls(page)).toContain(action)
        await page.keyboard.press('Escape')
      }
      const zoom = rail.locator('.dsh-pdf-toolbar-zoom > summary')
      await assertRightPanel(zoom, page.locator('.dsh-pdf-zoom-menu'), `zoom at ${viewport.width}×${viewport.height}`)
      await page.locator('.dsh-pdf-zoom-menu').getByRole('button', { name: '100%', exact: true }).click()
      expect(await toolRailCalls(page)).toContain('zoom:1')
      const history = rail.locator('.dsh-pdf-toolbar-back-split .dsh-pdf-split-action-trigger')
      await assertRightPanel(history, page.locator('.dsh-pdf-history-menu'), `history at ${viewport.width}×${viewport.height}`)
      await page.locator('.dsh-pdf-history-item').nth(1).click()
      expect(await toolRailCalls(page)).toContain('back-to:1:7')
      const activity = rail.locator('.dsh-pdf-activity-trigger'), activityPanel = page.locator('.dsh-pdf-activity-popover')
      await assertRightPanel(activity, activityPanel, `tasks at ${viewport.width}×${viewport.height}`)
      expect(await activityPanel.locator('[data-status-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-status-id'))))
        .toEqual(['save', 'screenshot', 'ocr'])
      expect(await activityPanel.textContent()).toContain('Saved')
      expect(await activityPanel.textContent()).toContain('Creating screenshot…')
      expect(await activityPanel.textContent()).toContain('Recognizing text…')
      await saveToolRailShot(page, `concurrent-tasks-${viewport.width}x${viewport.height}`)
      await activityPanel.locator('[data-status-id="ocr"]').getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await toolRailCalls(page)).toContain('cancel-ocr')
      await activityPanel.locator('[data-status-id="screenshot"]').getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await toolRailCalls(page)).toContain('cancel-screenshot')
      await activity.click()
    }
    await setToolRail(page, { tasks: 'cancelling', state: { editable: false, canUndo: false, canRedo: false,
      dirty: false, ocrAvailability: { status: 'unavailable', reason: 'OCR engine unavailable' } } })
    await expect.poll(() => rail.locator('.dsh-pdf-tool-ocr').isDisabled()).toBe(true)
    for (const selector of ['.dsh-pdf-tool-note', '.dsh-pdf-toolbar-save', '.dsh-pdf-tool-history .dsh-pdf-toolbar-undo', '.dsh-pdf-tool-history .dsh-pdf-toolbar-redo'])
      expect(await rail.locator(selector).isDisabled()).toBe(true)
    expect(await rail.locator('.dsh-pdf-tool-ocr').getAttribute('title')).toBe('OCR engine unavailable')
    await rail.locator('.dsh-pdf-tools > summary').click()
    for (const name of ['Undo PDF edit', 'Redo PDF edit'])
      expect(await fileActions(page.locator('.dsh-pdf-reader')).getByRole('button', { name, exact: true }).isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    await rail.locator('.dsh-pdf-activity-trigger').click()
    const tasks = page.locator('.dsh-pdf-activity-popover')
    for (const id of ['ocr', 'screenshot']) expect(await tasks.locator(`[data-status-id="${id}"] button`).isDisabled()).toBe(true)
    expect(await tasks.textContent()).toContain('Stopping OCR…')
    expect(await tasks.textContent()).toContain('Stopping screenshot…')
    await saveToolRailShot(page, 'cancelling-tasks-240x320')
  } finally { await browser.close() }
}, 45_000)

it('lets the left tool rail coexist with selection actions, full annotation actions and a real comment editor near the top of the PDF page', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 600 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-left-tool-rail-context'))
    await mountReaderToolRail(page)
    const comment = page.getByRole('dialog', { name: 'Annotation comment', exact: true })
    for (const actualAnnotation of [false, true]) {
      await setToolRail(page, { context: true, actualAnnotation, tasks: 'concurrent' })
      const context = page.getByRole('toolbar', { name: actualAnnotation ? 'Selected annotation' : 'Selection actions', exact: true })
      const prefix = actualAnnotation ? 'annotation' : 'selection'
      for (const viewport of [{ width: 1180, height: 600 }, { width: 500, height: 600 }, { width: 320, height: 600 },
        { width: 240, height: 600 }, { width: 320, height: 320 }, { width: 240, height: 320 }]) {
        await page.setViewportSize(viewport)
        await saveToolRailShot(page, `${prefix}-comment-${viewport.width}x${viewport.height}`)
        await expect.poll(async () => ({ context: await context.getAttribute('data-visible'), comment: await comment.getAttribute('data-visible') }))
          .toEqual({ context: 'true', comment: 'true' })
        await expect.poll(async () => {
          const content = (await page.locator('.dsh-pdf-scroll').boundingBox())!, toolbar = (await context.boundingBox())!, card = (await comment.boundingBox())!
          const inContent = [toolbar, card].every(bounds => bounds.x >= content.x && bounds.x + bounds.width <= content.x + content.width
            && bounds.y >= content.y && bounds.y + bounds.height <= content.y + content.height)
          const overlap = Math.min(toolbar.x + toolbar.width, card.x + card.width) - Math.max(toolbar.x, card.x) > 1
            && Math.min(toolbar.y + toolbar.height, card.y + card.height) - Math.max(toolbar.y, card.y) > 1
          return { inContent, overlap, contextNearTop: toolbar.y < content.y + 120 }
        }, { message: `context at ${viewport.width}×${viewport.height}` }).toEqual({ inContent: true, overlap: false, contextNearTop: true })
        await expect.poll(() => comment.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          { message: `comment content fits ${viewport.width}×${viewport.height} without horizontal scrolling` }).toBe(true)
        if (actualAnnotation) {
          expect(await context.locator('.dsh-pdf-highlight-swatch').count()).toBe(5)
          expect(await context.getByLabel('Selected annotation color', { exact: true }).count()).toBe(1)
          for (const swatch of await context.locator('.dsh-pdf-highlight-swatch').all()) await swatch.click()
          await context.getByRole('button', { name: 'Comment', exact: true }).click()
          await context.getByRole('button', { name: 'Delete annotation', exact: true }).click()
          await context.getByRole('button', { name: 'Deselect', exact: true }).click()
        } else await context.getByRole('button', { name: 'Copy', exact: true }).click()
        await comment.getByRole('textbox', { name: 'Comment', exact: true }).fill('The rail leaves this comment usable')
        const saveComment = comment.getByRole('button', { name: 'Save comment', exact: true })
        await saveComment.scrollIntoViewIfNeeded()
        await expect.poll(() => saveComment.evaluate(async element => {
          // Internal scrolling must remain stable after the card's own positioning observer runs.
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          const bounds = element.getBoundingClientRect(), card = element.closest('.dsh-pdf-page-comment-card')!.getBoundingClientRect()
          const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
          return bounds.top >= card.top && bounds.bottom <= card.bottom && (hit === element || !!hit && element.contains(hit))
        }), { message: `Save comment stays reachable after scrolling at ${viewport.width}×${viewport.height}` }).toBe(true)
        await saveComment.click()
        if (viewport.width <= 320) await saveToolRailShot(page, `${prefix}-comment-actions-${viewport.width}x${viewport.height}`)
        if (actualAnnotation) {
          const swatch = context.locator('.dsh-pdf-highlight-swatch').first()
          await swatch.click({ button: 'right' })
          const palette = page.getByRole('dialog', { name: 'Quick color 1', exact: true })
          await palette.waitFor({ state: 'visible' })
          await saveToolRailShot(page, `annotation-color-menu-${viewport.width}x${viewport.height}`)
          expect(await palette.getByLabel('Edit quick color', { exact: true }).count()).toBe(1)
          expect(await palette.getByRole('button', { name: 'Remove quick color', exact: true }).count()).toBe(1)
          expect(await palette.evaluate(element => {
            const bounds = element.getBoundingClientRect(), reader = element.closest('.dsh-pdf-reader')!.getBoundingClientRect()
            return bounds.left >= reader.left + 8 && bounds.right <= reader.right - 8
              && bounds.top >= reader.top + 8 && bounds.bottom <= reader.bottom - 8
          })).toBe(true)
          await page.keyboard.press('Escape')
          await expect.poll(() => palette.count()).toBe(0)
          expect(await swatch.evaluate(element => document.activeElement === element)).toBe(true)
        }
      }
      // Narrowing both rails restores a useful 128px PDF column even at 240px.
      // Keep the same edit draft when returning to a wider host.
      const draft = await comment.getByRole('textbox', { name: 'Comment', exact: true }).inputValue()
      await page.setViewportSize({ width: 320, height: 320 })
      await expect.poll(() => comment.getAttribute('data-visible')).toBe('true')
      expect(await comment.getByRole('textbox', { name: 'Comment', exact: true }).inputValue()).toBe(draft)
      await comment.getByRole('button', { name: 'Save comment', exact: true }).click()
    }
    expect(await toolRailCalls(page)).toEqual(expect.arrayContaining(['copy', 'apply-comment']))
    expect(await toolRailCalls(page)).toEqual(expect.arrayContaining(['annotation-color:#ffff00', 'annotation-color:#d1a2ff',
      'open-comment', 'delete-annotation', 'clear-annotation']))
  } finally { await browser.close() }
}, 60_000)

it('keeps all six real sidebar panel headings above scrolling content at narrow widths and low heights (layout regression)', async () => {
  const bundle = await build({ entryPoints: [join(ROOT, 'tests', 'modules', 'viewer', 'sidebar-panel-layout.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser' })
  const css = await Promise.all(['reader.css', 'reading-sidebar.css'].map(file => readFile(join(ROOT, 'src/client', file), 'utf8')))
  const screenshots = join(ROOT, '.test-output', 'sidebar-panel-layout')
  await mkdir(screenshots, { recursive: true })
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 360 }, reducedMotion: 'reduce' })
    const browserErrors: string[] = []
    page.on('pageerror', error => browserErrors.push(error.message))
    // A trusted localhost origin exposes the real crypto/clipboard APIs used by
    // the feature actions, without a running DSH server or scaffold.
    await page.route('http://localhost/sidebar-panel-layout', route => route.fulfill({
      contentType: 'text/html', body: '<div id="sidebar-layout-root" style="height:100%"></div>',
    }))
    await page.goto('http://localhost/sidebar-panel-layout')
    await page.addStyleTag({ content: `:root { --dsw-alias-bg-base:#f5f5f5; --dsw-alias-bg-layer-1:#fff; --dsw-alias-bg-layer-2:#f6f6f6; --dsw-alias-label-primary:#222; --dsw-alias-label-secondary:#666; --dsw-alias-border-l2:#ddd; --dsw-alias-link:#4278ed; --dsw-alias-bg-document-preview:#edf0f3; } html,body { margin:0; height:100%; } ${css.join('\n')}` })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    await page.locator('[data-layout-panel="translation"] .dsh-pdf-translation-text').waitFor()
    const sections = ['pages', 'bookmarks', 'annotations', 'search', 'translation', 'ocr'] as const
    const actions = () => page.evaluate(() => (window as typeof window & {
      __pdfSidebarPanelLayoutFixture: { actions(): string[] }
    }).__pdfSidebarPanelLayoutFixture.actions())
    for (const size of [{ width: 260, height: 260 }, { width: 300, height: 320 }, { width: 360, height: 360 }]) {
      await page.setViewportSize(size)
      for (const section of sections) {
        await page.evaluate(next => (window as typeof window & {
          __pdfSidebarPanelLayoutFixture: { show(section: typeof next): void }
        }).__pdfSidebarPanelLayoutFixture.show(next), section)
        const wrapper = page.locator(`[data-layout-panel="${section}"]`)
        const panel = wrapper.locator('.dsh-pdf-panel')
        const heading = panel.locator(':scope > .dsh-pdf-panel-heading')
        const scroll = panel.locator(':scope > .dsh-pdf-panel-scroll')
        // A title inside the scrolling div (the old TranslationPanel layout)
        // fails this shared-sibling contract before any pixel assertions.
        expect(await heading.count(), section).toBe(1)
        expect(await scroll.count(), section).toBe(1)
        expect(await scroll.locator('.dsh-pdf-panel-heading').count(), section).toBe(0)
        if (section === 'translation') {
          await panel.locator('.dsh-pdf-translation-text').waitFor()
          expect(await panel.locator('.dsh-pdf-translation-source-text').evaluate(element => {
            const style = getComputedStyle(element)
            return style.overflowY === 'hidden' && style.webkitLineClamp === '4'
              && element.clientHeight <= 4 * Number.parseFloat(style.lineHeight) + 1
          }), 'long original is a four-line disclosure, without a nested scroll area').toBe(true)
        }
        await expect.poll(() => scroll.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight > 0),
          { message: `${section} has real scrollable content at ${size.width}×${size.height}` }).toBe(true)
        await expect.poll(() => panel.evaluate(element => {
          const viewport = element.querySelector<HTMLElement>(':scope > .dsh-pdf-panel-scroll')!
          const track = element.querySelector<HTMLElement>('.dsh-pdf-scrollbar.is-vertical:not([hidden])')
          const content = viewport.firstElementChild
          if (!track || !content) return false
          return content.getBoundingClientRect().left - track.getBoundingClientRect().right >= 8
            && viewport.scrollWidth <= viewport.clientWidth + 1
        }), { message: `${section} reserves a separate scrollbar gutter without horizontal overflow` }).toBe(true)
        if (section === 'pages') {
          // At 300px the viewport is wide enough for the old two-column
          // breakpoint, but its actual content is narrower after the gutter.
          await expect.poll(() => panel.locator('.dsh-pdf-thumbnail-grid-row').first().locator(':scope > button').count(),
            { message: 'thumbnail columns use content width after reserving the scrollbar gutter' })
            .toBe(size.width === 360 ? 2 : 1)
        }
        const fixedHeading = (await heading.boundingBox())!
        expect(fixedHeading.height, section).toBe(48)
        await scroll.evaluate(element => { element.scrollTop = 0 })
        await scroll.hover()
        await page.mouse.wheel(0, 80)
        await expect.poll(() => scroll.evaluate(element => element.scrollTop), { message: `${section} wheel scroll` }).toBeGreaterThan(0)
        for (const [name, fraction] of [['initial', 0], ['middle', .5], ['bottom', 1]] as const) {
          await scroll.evaluate((element, portion) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * portion }, fraction)
          await expect.poll(() => panel.evaluate((element, expected) => {
            const header = element.querySelector<HTMLElement>(':scope > .dsh-pdf-panel-heading')!
            const viewport = element.querySelector<HTMLElement>(':scope > .dsh-pdf-panel-scroll')!
            const headerBox = header.getBoundingClientRect(), scrollBox = viewport.getBoundingClientRect()
            const scrollbar = element.querySelector<HTMLElement>('.dsh-pdf-scrollbar.is-vertical:not([hidden])')
            const barBox = scrollbar?.getBoundingClientRect()
            return { headerFixed: Math.abs(headerBox.top - expected.y) < .5 && Math.abs(headerBox.height - expected.height) < .5,
              viewportBelowHeading: scrollBox.top >= headerBox.bottom - .5,
              scrollbarBelowHeading: !barBox || barBox.top >= headerBox.bottom - .5,
              viewportContained: scrollBox.bottom <= element.getBoundingClientRect().bottom + .5,
              noHorizontalOverflow: viewport.scrollWidth <= viewport.clientWidth + 1 }
          }, fixedHeading), { message: `${section} ${name} at ${size.width}×${size.height}` }).toEqual({
            headerFixed: true, viewportBelowHeading: true, scrollbarBelowHeading: true, viewportContained: true, noHorizontalOverflow: true,
          })
          if (section === 'translation') await page.screenshot({ path: join(screenshots, `translation-${size.width}x${size.height}-${name}.png`) })
        }
        if (section === 'pages') await panel.locator('.dsh-pdf-thumbnail-tile').last().click()
        else if (section === 'bookmarks') {
          await heading.locator('button').click()
          const editor = panel.locator('.dsh-pdf-outline-name-editor input')
          await editor.waitFor(); expect(await editor.evaluate(element => document.activeElement === element)).toBe(true)
          await editor.press('Escape')
          expect(await panel.locator('.dsh-pdf-outline-name-editor').count()).toBe(0)
        } else if (section === 'annotations') {
          await heading.locator('select').selectOption('Text')
          expect(await heading.locator('select').inputValue()).toBe('Text')
        } else if (section === 'search') await panel.locator('form button').click()
        else if (section === 'ocr') await panel.getByRole('button', { name: 'Copy transcript', exact: true }).click()
        else {
          await heading.locator('button').click()
          await expect.poll(() => panel.locator('.dsh-pdf-translation-source').count()).toBe(0)
          expect(await panel.locator(':scope > .dsh-pdf-panel-heading').count()).toBe(1)
        }
        if (section !== 'translation') await page.screenshot({ path: join(screenshots, `${section}-${size.width}x${size.height}.png`) })
      }
    }
    const recorded = await actions()
    for (const action of ['page', 'search', 'copy', 'close']) expect(recorded, action).toContain(action)
    expect(browserErrors).toEqual([])
  } finally { await browser.close() }
}, 45_000)

it('keeps all PDF sidebar sections aligned and usable at the minimum width', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-sidebar-style-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF sidebar style test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'pdf-sidebar-style-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF sidebar style test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const sidebarMaterial = await sidebar.evaluate(element => {
      const style = getComputedStyle(element.querySelector('.dsh-pdf-sidebar-shell')!)
      const position = getComputedStyle(element)
      const frame = getComputedStyle(element.querySelector('.dsh-pdf-sidebar-main')!)
      const heading = element.querySelector('.dsh-pdf-panel-heading')!
      return { backgroundImage: frame.backgroundImage, backgroundColor: frame.backgroundColor,
        backdropFilter: frame.backdropFilter, shellBackground: style.backgroundImage, shellBackdrop: style.backdropFilter,
        containerBackground: position.backgroundImage, containerBackdrop: position.backdropFilter, position: position.position,
        top: position.top, right: position.right, bottom: position.bottom,
        borderRadius: frame.borderRadius, shellBorder: style.borderTopWidth, shellShadow: style.boxShadow,
        frameBorder: frame.borderTopWidth, frameDivider: frame.borderLeftWidth, frameShadow: frame.boxShadow,
        heading: getComputedStyle(heading).backgroundColor }
    })
    expect(sidebarMaterial.backgroundImage).toContain('linear-gradient')
    expect(sidebarMaterial.backdropFilter).toContain('blur(24px)')
    expect(sidebarMaterial.shellBackground).toBe('none')
    expect(sidebarMaterial.shellBackdrop).toBe('none')
    expect(sidebarMaterial.containerBackground).toBe('none')
    expect(sidebarMaterial.containerBackdrop).toBe('none')
    expect(sidebarMaterial.position).toBe('absolute')
    expect(parseFloat(sidebarMaterial.top)).toBeGreaterThanOrEqual(0)
    expect(parseFloat(sidebarMaterial.right)).toBeGreaterThan(0)
    expect(parseFloat(sidebarMaterial.bottom)).toBeGreaterThan(0)
    expect(sidebarMaterial.borderRadius).toBe('18px')
    expect(sidebarMaterial.shellBorder).toBe('0px')
    expect(sidebarMaterial.shellShadow).toBe('none')
    expect(sidebarMaterial.frameBorder).toBe('1px')
    expect(sidebarMaterial.frameDivider).toBe('1px')
    expect(sidebarMaterial.frameShadow).not.toBe('none')
    expect(sidebarMaterial.frameShadow).toContain('inset')
    expect(sidebarMaterial.heading).toBe('rgba(0, 0, 0, 0)')
    const sampleMaterial = async (x: number, y: number): Promise<number[]> => {
      const png = await page.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } })
      return page.evaluate(async bytes => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(bitmap, 0, 0)
        const color = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
        bitmap.close()
        return color
      }, [...png])
    }
    const assertBackdropTint = async () => {
      const toolbar = (await reader.locator('[data-tool-group="navigation"]').boundingBox())!
      const sidebarBox = (await sidebar.locator('.dsh-pdf-sidebar-rail-shell').boundingBox())!
      const [toolbarTint, sidebarTint] = await Promise.all([
        sampleMaterial(toolbar.x + 5, toolbar.y + toolbar.height - 12),
        sampleMaterial(sidebarBox.x + 5, sidebarBox.y + sidebarBox.height - 12),
      ])
      // Chrome remains visibly the same family over the dark preview well and
      // white paper. Retain a little backdrop variation, not an exact pixel match.
      expect(Math.max(...toolbarTint.map((channel, index) => Math.abs(channel - sidebarTint[index]))),
        JSON.stringify({ toolbarTint, sidebarTint })).toBeLessThanOrEqual(18)
    }
    const assertSharedGlass = async (dark: boolean) => {
      // Compare the shared shell material independently of control feedback;
      // button hover is covered separately by interaction tests.
      await page.mouse.move(0, 0)
      const surfaces = await reader.evaluate(element => {
        const describe = (selector: string, pseudo: string) => {
          const surface = element.querySelector(selector)!
          const style = getComputedStyle(surface, pseudo)
          const variables = getComputedStyle(surface)
          return { background: style.backgroundImage, filter: style.backdropFilter,
            border: variables.borderColor, rim: variables.getPropertyValue('--pdf-glass-rim-shadow').trim(),
            tint: variables.getPropertyValue('--pdf-glass-shell-tint').trim(),
            top: variables.getPropertyValue('--pdf-glass-shell-top').trim(),
            fill: variables.getPropertyValue('--pdf-glass-shell-fill').trim() }
        }
        return { toolbar: describe('.dsh-pdf-tool-rail-shell', ''),
          sidebar: describe('.dsh-pdf-sidebar-rail-shell', ''), panel: describe('.dsh-pdf-sidebar-main', '') }
      })
      // Test the material, not identical pixels over different backdrops:
      // white paper under a sidebar can naturally differ from the preview well.
      expect(surfaces.sidebar).toEqual(surfaces.toolbar)
      expect(surfaces.panel).toEqual(surfaces.toolbar)
      expect(surfaces.sidebar.background).toContain(dark ? '22px' : '32px')
      expect(surfaces.sidebar.background).toContain('44px')
      expect(surfaces.sidebar.filter).toBe('blur(24px) saturate(1.8)')
    }
    await assertSharedGlass(false)
    await page.emulateMedia({ contrast: 'more' })
    const opaqueSurfaces = await reader.evaluate(element =>
      [['.dsh-pdf-tool-rail-shell', ''], ['.dsh-pdf-sidebar-rail-shell', '']].map(([selector, pseudo]) => {
        const surface = element.querySelector(selector)!
        const style = getComputedStyle(surface, pseudo)
        return { filter: style.backdropFilter, image: style.backgroundImage, color: style.backgroundColor,
          container: getComputedStyle(surface).backgroundColor }
      }))
    expect(opaqueSurfaces[0].filter).toBe(opaqueSurfaces[1].filter)
    expect(opaqueSurfaces[0].image).toBe(opaqueSurfaces[1].image)
    expect(opaqueSurfaces[0].color).toBe(opaqueSurfaces[1].color)
    expect(opaqueSurfaces[0].filter).toBe('none')
    expect(opaqueSurfaces[0].image).toBe('none')
    expect(opaqueSurfaces[0].color).not.toBe('rgba(0, 0, 0, 0)')
    expect(opaqueSurfaces[1].container).toBe(opaqueSurfaces[0].container)
    expect(await sidebar.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await page.emulateMedia({ contrast: 'no-preference' })
    const sections = ['Pages', 'Bookmarks', 'Annotations', 'Search', 'Translation', 'OCR'] as const
    let baseline: { top: number; left: number; height: number; fontSize: string; paginationTop: number } | undefined
    for (const name of sections) {
      await reader.getByRole('tab', { name, exact: true }).click()
      const panel = reader.locator('.dsh-pdf-sidebar-panel:not([hidden])')
      const heading = panel.locator('.dsh-pdf-panel-heading').first()
      await heading.waitFor({ state: 'visible' })
      await expect.poll(() => heading.evaluate(element =>
        Math.abs(new DOMMatrix(getComputedStyle(element).transform).m41))).toBeLessThan(0.1)
      const geometry = await heading.evaluate(element => {
        const panel = element.closest('.dsh-pdf-sidebar-panel')!.getBoundingClientRect()
        const title = element.querySelector('h3')!
        const header = element.getBoundingClientRect()
        return { top: header.top - panel.top, left: title.getBoundingClientRect().left - panel.left,
          height: header.height, fontSize: getComputedStyle(title).fontSize,
          paginationTop: element.closest('.dsh-pdf-sidebar')!.querySelector('.dsh-pdf-sidebar-compact-nav')!.getBoundingClientRect().top }
      })
      if (baseline) {
        expect(Math.abs(geometry.top - baseline.top), `${name} heading top`).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.left - baseline.left), `${name} heading inset`).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.height - baseline.height), `${name} heading height`).toBeLessThanOrEqual(1)
        expect(geometry.fontSize, `${name} heading font`).toBe(baseline.fontSize)
        expect(Math.abs(geometry.paginationTop - baseline.paginationTop), `${name} pagination position`).toBeLessThanOrEqual(1)
      } else baseline = geometry
      if (name === 'OCR') {
        const scroll = panel.locator('.dsh-pdf-ocr-scroll > .dsh-pdf-panel-scroll')
        const [headerBounds, scrollBounds] = await Promise.all([heading.boundingBox(), scroll.boundingBox()])
        const scrollTop = await scroll.evaluate(element => getComputedStyle(element).top)
        expect(scrollBounds!.y, `OCR scroll top: ${scrollTop}`).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height - 1)
        expect(await scroll.locator('.dsh-pdf-panel-heading').count()).toBe(0)
      }
      if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
        await sidebar.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, `${name.toLowerCase()}.png`) })
      }
    }

    await openSidebarSection(reader, 'Bookmarks')
    const heading = sidebar.locator('.dsh-pdf-bookmark-heading')
    expect(await sidebar.locator('.dsh-pdf-bookmark-panel h3, .dsh-pdf-bookmark-panel h4').count()).toBe(1)
    expect(await heading.locator('h3').textContent()).toBe('Bookmarks')
    for (const size of ['Home', 'End']) {
      await sidebar.locator('.dsh-pdf-sidebar-divider').press(size)
      await expect.poll(() => sidebar.evaluate(element => Math.abs(element.getBoundingClientRect().width
        - parseFloat((element as HTMLElement).style.getPropertyValue('--pdf-sidebar-width'))))).toBeLessThanOrEqual(1)
      await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
      const fit = await heading.evaluate(element => element.scrollWidth <= element.clientWidth)
      expect(fit).toBe(true)
    }
    if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
      await reader.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'reader-bookmarks.png') })
    }
    await assertSharedGlass(false)
    await assertBackdropTint()
    const originalTheme = await page.locator('body').getAttribute('data-ds-dark-theme')
    await page.locator('body').evaluate(element => element.setAttribute('data-ds-dark-theme', ''))
    await assertSharedGlass(true)
    await assertBackdropTint()
    if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
      await reader.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'reader-bookmarks-dark.png') })
    }
    await page.locator('body').evaluate((element, value) => {
      if (value === null) element.removeAttribute('data-ds-dark-theme'); else element.setAttribute('data-ds-dark-theme', value)
    }, originalTheme)
    expect(await reader.getByRole('button', { name: 'Add PDF bookmark' })
      .evaluate(element => getComputedStyle(element).borderRadius)).toBe('6px')
    await openSidebarSection(reader, 'Annotations')
    const filter = reader.getByRole('combobox', { name: 'Filter annotations' })
    expect(await filter.evaluate(element => getComputedStyle(element).borderRadius)).toBe('6px')
    // Resize through the real divider so the revealed panel shell and reserved
    // column use the same width; overriding the outer column alone clips it.
    await sidebar.locator('.dsh-pdf-sidebar-divider').press('Home')
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    const annotationBounds = await reader.locator('.dsh-pdf-annotations-heading').evaluate(element => {
      const title = element.querySelector('h3')!.getBoundingClientRect()
      const control = element.querySelector('select')!.getBoundingClientRect()
      const heading = element.getBoundingClientRect()
      return { titleRight: title.right, controlLeft: control.left, controlRight: control.right, headingRight: heading.right }
    })
    expect(annotationBounds.titleRight).toBeLessThanOrEqual(annotationBounds.controlLeft)
    expect(annotationBounds.controlRight).toBeLessThanOrEqual(annotationBounds.headingRight - 11)
    await sidebar.locator('.dsh-pdf-sidebar-divider').press('End')
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))

    await openSidebarSection(reader, 'Search')
    const searchPanel = reader.locator('.dsh-pdf-search-panel')
    expect(await searchPanel.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    const [searchPanelBox, searchInputBox, searchButtonBox] = await Promise.all([
      searchPanel.boundingBox(), searchPanel.locator('form input').boundingBox(), searchPanel.locator('form button').boundingBox(),
    ])
    expect(searchPanelBox).not.toBeNull()
    expect(searchInputBox).not.toBeNull()
    expect(searchButtonBox).not.toBeNull()
    expect(Math.abs(searchInputBox!.y + searchInputBox!.height / 2 - searchButtonBox!.y - searchButtonBox!.height / 2)).toBeLessThanOrEqual(1)
    expect(searchInputBox!.x + searchInputBox!.width).toBeLessThan(searchButtonBox!.x)
    expect(searchButtonBox!.x + searchButtonBox!.width).toBeLessThanOrEqual(searchPanelBox!.x + searchPanelBox!.width)
    expect(await searchPanel.locator('form input').evaluate(element => getComputedStyle(element).borderRadius)).toBe('6px')
    expect(await searchPanel.locator('form button').evaluate(element => getComputedStyle(element).borderRadius)).toBe('6px')

    // The heading belongs to the fixed panel shell, not the scrolling results.
    // A narrow, short viewport reproduces the overlap seen after scrolling hits.
    await sidebar.locator('.dsh-pdf-sidebar-divider').press('Home')
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    const searchScroll = searchPanel.locator(':scope > .dsh-pdf-panel-scroll')
    const searchHeading = searchPanel.locator(':scope > .dsh-pdf-panel-heading')
    await searchPanel.locator('form input').fill('Browser')
    await searchPanel.locator('form button').click()
    await expect.poll(() => searchPanel.locator('.dsh-pdf-search-hit').count()).toBe(2)
    // A second query on the same native PDF reuses the per-page text index.
    // A definite miss must not leave stale hits, and repeating the original
    // query must still return the correct positioned results.
    await searchPanel.locator('form input').fill('not-in-this-pdf')
    await searchPanel.locator('form button').click()
    await expect.poll(() => searchPanel.getByText('No matching text in the available text layers.', { exact: true }).count()).toBe(1)
    expect(await searchPanel.locator('.dsh-pdf-search-hit').count()).toBe(0)
    await searchPanel.locator('form input').fill('Browser')
    await searchPanel.locator('form button').click()
    await expect.poll(() => searchPanel.locator('.dsh-pdf-search-hit').count()).toBe(2)
    const headingBeforeScroll = await searchHeading.boundingBox()
    // Constrain the shared panel, whose flex scrollport otherwise consumes all
    // remaining height regardless of a height written on that flex child.
    await searchPanel.evaluate(element => { (element as HTMLElement).style.height = '218px' })
    await searchScroll.evaluate(element => {
      const scroll = element as HTMLElement
      scroll.scrollTop = scroll.scrollHeight
    })
    await expect.poll(() => searchScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    const [headingAfterScroll, scrollAfterScroll, lastHit] = await Promise.all([
      searchHeading.boundingBox(), searchScroll.boundingBox(), searchPanel.locator('.dsh-pdf-search-hit').last().boundingBox(),
    ])
    expect(headingBeforeScroll).not.toBeNull()
    expect(headingAfterScroll).not.toBeNull()
    expect(scrollAfterScroll).not.toBeNull()
    expect(lastHit).not.toBeNull()
    expect(Math.abs(headingAfterScroll!.y - headingBeforeScroll!.y)).toBeLessThanOrEqual(1)
    expect(scrollAfterScroll!.y).toBeGreaterThanOrEqual(headingAfterScroll!.y + headingAfterScroll!.height - 1)
    expect(lastHit!.y).toBeGreaterThanOrEqual(scrollAfterScroll!.y - 1)
    expect(lastHit!.x).toBeGreaterThanOrEqual(scrollAfterScroll!.x - 1)
    expect(lastHit!.x + lastHit!.width).toBeLessThanOrEqual(scrollAfterScroll!.x + scrollAfterScroll!.width + 1)
    expect(await searchScroll.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
      await sidebar.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'search-narrow-scrolled.png') })
    }
    await searchPanel.evaluate(element => { (element as HTMLElement).style.height = '' })
    await sidebar.locator('.dsh-pdf-sidebar-divider').press('End')
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))

    const toggle = sidebar.getByRole('tab', { selected: true })
    const main = sidebar.locator('.dsh-pdf-sidebar-main')
    const motion = await sidebar.evaluate(element => ({
      sidebar: getComputedStyle(element).transitionProperty,
      shell: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-shell')!).transitionProperty,
      content: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-main')!).transitionProperty,
      panels: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-panels')!).transitionProperty,
      pagination: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-compact-nav')!).transitionDuration,
    }))
    expect(motion.sidebar).toContain('width')
    expect(motion.shell).toContain('clip-path')
    expect(motion.content).toContain('opacity')
    expect(motion.panels).toContain('transform')
    expect(motion.pagination).toBe('0s')
    expect(await sidebar.locator('.dsh-pdf-sidebar-toggle').count()).toBe(0)
    await toggle.click()
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await main.getAttribute('aria-hidden')).toBe('true')
    expect(await main.evaluate(element => (element as HTMLElement).inert)).toBe(true)
    await expect.poll(() => sidebar.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(56)
    await expect.poll(() => sidebar.evaluate(element => {
      const clip = getComputedStyle(element.querySelector('.dsh-pdf-sidebar-shell')!).clipPath
      const shadowBleed = -parseFloat(clip.slice('inset('.length))
      const rail = element.querySelector('.dsh-pdf-sidebar-rail')!.getBoundingClientRect().width
      return shadowBleed > 0 && clip.includes(`calc(100% - ${rail + shadowBleed}px)`)
    }), { message: 'the collapsed clip retains the rail and its outer glass shadow' }).toBe(true)
    expect(await sidebar.locator('.dsh-pdf-sidebar-rail').evaluate(element => element.getBoundingClientRect().width)).toBe(56)
    await assertSharedGlass(false)
    const theme = await page.locator('body').getAttribute('data-ds-dark-theme')
    await page.locator('body').evaluate(element => element.setAttribute('data-ds-dark-theme', ''))
    await assertSharedGlass(true)
    if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
      await sidebar.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'sidebar-collapsed-dark.png') })
      await reader.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'reader-collapsed-dark.png') })
    }
    await page.locator('body').evaluate((element, value) => {
      if (value === null) element.removeAttribute('data-ds-dark-theme'); else element.setAttribute('data-ds-dark-theme', value)
    }, theme)
    if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
      await sidebar.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'sidebar-collapsed.png') })
    }
    const compact = sidebar.locator('.dsh-pdf-sidebar-compact-nav')
    expect(await compact.getAttribute('aria-hidden')).not.toBe('true')
    expect(await compact.evaluate(element => (element as HTMLElement).inert)).toBe(false)
    await toggle.click()
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await main.evaluate(element => (element as HTMLElement).inert)).toBe(false)
    expect(await compact.evaluate(element => (element as HTMLElement).inert)).toBe(false)
    await expect.poll(() => main.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await sidebar.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    expect(await sidebar.locator('.dsh-pdf-sidebar-shell').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    expect(await main.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    expect(await sidebar.locator('.dsh-pdf-sidebar-panels').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    const setReaderWidth = async (width: number) => {
      await reader.evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px` }, width)
      await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(width)
      await reader.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    }
    await setReaderWidth(960)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await setReaderWidth(700)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    const readingContent = reader.locator('.dsh-pdf-content')
    expect(await readingContent.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const toolbarResize = await reader.evaluate(async element => {
      const controls = element.querySelector<HTMLElement>('.dsh-pdf-scroll')!
      const toolbar = element.querySelector<HTMLElement>('.dsh-pdf-main-toolbar')!
      const toggle = element.querySelector<HTMLButtonElement>('.dsh-pdf-sidebar-tab[aria-selected="true"]')!
      const width = () => { const style = getComputedStyle(controls); return controls.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) }
      const before = width()
      const toolbarBefore = toolbar.getBoundingClientRect().width
      toggle.click()
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      await new Promise<void>(resolve => setTimeout(resolve, 90))
      const during = width()
      const toolbarDuring = toolbar.getBoundingClientRect().width
      const property = getComputedStyle(controls).transitionProperty
      await new Promise<void>(resolve => setTimeout(resolve, 260))
      return { before, during, after: width(), toolbarBefore, toolbarDuring,
        toolbarAfter: toolbar.getBoundingClientRect().width, property }
    })
    expect(toolbarResize.property).not.toContain('right')
    expect(toolbarResize.during, JSON.stringify(toolbarResize)).toBeLessThan(toolbarResize.before - 1)
    expect(toolbarResize.during, JSON.stringify(toolbarResize)).toBeGreaterThan(toolbarResize.after + 1)
    expect([toolbarResize.toolbarBefore, toolbarResize.toolbarDuring, toolbarResize.toolbarAfter]).toEqual([56, 56, 56])
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    const toolbarRestore = await reader.evaluate(async element => {
      const controls = element.querySelector<HTMLElement>('.dsh-pdf-scroll')!
      const toolbar = element.querySelector<HTMLElement>('.dsh-pdf-main-toolbar')!
      const toggle = element.querySelector<HTMLButtonElement>('.dsh-pdf-sidebar-tab[aria-selected="true"]')!
      const width = () => { const style = getComputedStyle(controls); return controls.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) }
      const before = width()
      const toolbarBefore = toolbar.getBoundingClientRect().width
      toggle.click()
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      await new Promise<void>(resolve => setTimeout(resolve, 90))
      const during = width()
      const toolbarDuring = toolbar.getBoundingClientRect().width
      await new Promise<void>(resolve => setTimeout(resolve, 260))
      return { before, during, after: width(), toolbarBefore, toolbarDuring, toolbarAfter: toolbar.getBoundingClientRect().width }
    })
    expect(toolbarRestore.during, JSON.stringify(toolbarRestore)).toBeGreaterThan(toolbarRestore.before + 1)
    expect(toolbarRestore.during, JSON.stringify(toolbarRestore)).toBeLessThan(toolbarRestore.after - 1)
    expect([toolbarRestore.toolbarBefore, toolbarRestore.toolbarDuring, toolbarRestore.toolbarAfter]).toEqual([56, 56, 56])
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await sidebar.locator('.dsh-pdf-sidebar-shell').evaluate(element =>
      Promise.all(element.getAnimations().map(animation => animation.finished)))
    const dividerBounds = await sidebar.locator('.dsh-pdf-sidebar-divider').boundingBox()
    expect(dividerBounds).not.toBeNull()
    const dividerPoint = { x: dividerBounds!.x + dividerBounds!.width - 0.5, y: dividerBounds!.y + dividerBounds!.height / 2 }
    expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.className, dividerPoint))
      .toContain('dsh-pdf-sidebar-divider')
    await page.mouse.move(dividerPoint.x, dividerPoint.y)
    await page.mouse.down()
    await expect.poll(() => sidebar.getAttribute('data-resizing')).toBe('')
    expect(await sidebar.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    expect(await readingContent.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    await page.mouse.up()
    await expect.poll(() => sidebar.getAttribute('data-resizing')).toBeNull()
    await setReaderWidth(960)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)

it('keeps page numbers in the sidebar and a 16px gap between PDF pages', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-page-spacing-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF page spacing test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('treeitem').filter({ hasText: 'PDF page spacing test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.locator('[data-pdf-page="2"]').waitFor({ state: 'attached', timeout: 20_000 })
    expect(await reader.locator('.dsh-pdf-page-label').count()).toBe(0)
    await expect.poll(() => reader.evaluate(element => {
      const first = element.querySelector<HTMLElement>('[data-pdf-page="1"]')?.getBoundingClientRect()
      const second = element.querySelector<HTMLElement>('[data-pdf-page="2"]')?.getBoundingClientRect()
      return first && second ? second.top - first.bottom : null
    })).toBeCloseTo(16, 1)
    await openSidebarSection(reader, 'Pages')
    await reader.getByRole('button', { name: 'Page 2 / 2' }).waitFor({ state: 'visible' })
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('auto-collapses the reading sidebar below 760px without reopening it when space returns', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-narrow-sidebar-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF narrow sidebar test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-narrow-sidebar-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF narrow sidebar test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 10_000 })
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const toggle = sidebar.getByRole('tab', { selected: true })
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const setReaderWidth = async (width: number) => {
      await reader.evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px` }, width)
      await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(width)
      await reader.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    }
    const assertToolbarBesideSidebar = async () => {
      await expectFloatingToolRails(reader)
      await expectIconOnlyMainToolbar(toolbar)
    }
    const assertFeedbackInsideReadingColumn = async () => {
      const feedback = reader.locator('.dsh-pdf-activity-trigger')
      if (await feedback.getAttribute('aria-expanded') === 'false') await feedback.click()
      const [bar, notice, readerBox, popover] = await Promise.all([
        toolbar.boundingBox(), feedback.boundingBox(), reader.boundingBox(),
        reader.locator('.dsh-pdf-activity-popover').boundingBox(),
      ])
      expect(bar).not.toBeNull(); expect(notice).not.toBeNull(); expect(readerBox).not.toBeNull(); expect(popover).not.toBeNull()
      expect(notice!.x).toBeGreaterThanOrEqual(bar!.x)
      expect(notice!.x + notice!.width).toBeLessThanOrEqual(bar!.x + bar!.width)
      expect(notice!.y).toBeGreaterThanOrEqual(bar!.y)
      expect(notice!.y + notice!.height).toBeLessThanOrEqual(bar!.y + bar!.height)
      expect(popover!.x).toBeGreaterThanOrEqual(bar!.x + bar!.width)
      expect(popover!.x + popover!.width).toBeLessThanOrEqual(readerBox!.x + readerBox!.width - 7)
      expect(popover!.y).toBeGreaterThanOrEqual(readerBox!.y + 7)
      expect(popover!.y + popover!.height).toBeLessThanOrEqual(readerBox!.y + readerBox!.height - 7)
      await feedback.click()
    }

    // The host may initially mount a narrower tab; explicitly start this
    // scenario in a wide, expanded reader before crossing the threshold.
    await setReaderWidth(960)
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await assertToolbarBesideSidebar()
    await assertFeedbackInsideReadingColumn()
    await expectIconOnlyMainToolbar(toolbar)
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-main-toolbar-wide.png') })
    }
    await compareOrRefreshGolden(
      join(EXPECTED, 'opened-toolbar.expected.md'),
      await captureToolbarEditsAria(page, scaffold.workspaceCwd),
      webSnapshotMode(),
    )
    // Stepping a page locks navigation for a few hundred milliseconds. The
    // zoom must keep its appearance across that lock; the arrows legitimately
    // change state when moving from the first to the last page.
    {
      await openSidebarSection(reader, 'Pages')
      const nextPage = reader.locator('.dsh-pdf-sidebar-compact-nav button[aria-label="Next page"]')
      await nextPage.waitFor({ state: 'visible' })
      const sampled = await page.evaluate(async () => {
        const read = () => ({
          zoom: getComputedStyle(document.querySelector('.dsh-pdf-toolbar-zoom > summary')!).opacity,
          zoomTrigger: getComputedStyle(document.querySelector('.dsh-pdf-toolbar-zoom')!).opacity,
          next: getComputedStyle(document.querySelector('.dsh-pdf-sidebar-compact-nav button[aria-label="Next page"]')!).opacity,
        })
        const seen: string[] = []
        const started = performance.now()
        return await new Promise<string[]>(resolve => {
          const tick = () => {
            const state = read()
            const text = `${state.zoom}|${state.zoomTrigger}|${state.next}`
            if (seen.at(-1) !== text) seen.push(text)
            if (performance.now() - started < 1600) requestAnimationFrame(tick)
            else resolve(seen)
          }
          document.querySelector<HTMLButtonElement>('.dsh-pdf-sidebar-compact-nav button[aria-label="Next page"]')!.click()
          requestAnimationFrame(tick)
        })
      })
      expect(sampled).toEqual(['1|1|1', '1|1|0.35'])
      await openSidebarSection(reader, 'Pages')
    }
    // Exercise the dropdown/tooltip presentation in a genuinely short viewport.
    await page.setViewportSize({ ...page.viewportSize()!, height: 600 })
    const toolsControl = toolbar.locator('.dsh-pdf-tools > summary')
    const tooltip = page.getByRole('tooltip')
    expect(await toolbar.locator('.dsh-pdf-toolbar-disclosure').count()).toBe(2)
    expect(await toolsControl.locator('.dsh-pdf-toolbar-chevron').count()).toBe(1)
    expect(await toolbar.locator('.dsh-pdf-toolbar-zoom > summary .dsh-pdf-toolbar-chevron').count()).toBe(1)
    await page.mouse.move(0, 0)
    await toolsControl.hover()
    await tooltip.waitFor({ state: 'visible' })
    expect(await tooltip.innerText()).toBe('Document actions')
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: 'hidden' })
    const zoomControl = toolbar.locator('.dsh-pdf-toolbar-zoom > summary')
    await zoomControl.hover()
    await tooltip.waitFor({ state: 'visible' })
    expect(await tooltip.innerText()).toBe('Zoom: Fit width')
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await page.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-main-toolbar-tooltip.png') })
    }
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: 'hidden' })
    // Move to this control with the keyboard, rather than programmatically
    // focusing it in pointer modality (which is not :focus-visible).
    await zoomControl.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect.poll(() => zoomControl.evaluate(element => document.activeElement === element)).toBe(true)
    await expect.poll(() => zoomControl.evaluate(element => element.matches(':focus-visible'))).toBe(true)
    await tooltip.waitFor({ state: 'visible' })
    expect(await tooltip.innerText()).toBe('Zoom: Fit width')
    await zoomControl.evaluate(element => (element as HTMLElement).blur())
    await tooltip.waitFor({ state: 'hidden' })
    const disabledSave = toolbar.getByRole('button', { name: 'Save', exact: true })
    expect(await disabledSave.isDisabled()).toBe(true)
    expect(await disabledSave.getAttribute('data-save-state')).toBe('saved')
    await disabledSave.hover()
    await tooltip.waitFor({ state: 'visible' })
    expect(await tooltip.innerText()).toBe('All changes saved')
    expect(await toolbar.locator('.dsh-pdf-save-control [role="status"]').textContent()).toBe('All changes saved')
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: 'hidden' })
    await toolsControl.locator('.dsh-pdf-toolbar-chevron').click()
    await fileActions(reader).first().waitFor({ state: 'visible' })
    await zoomControl.click()
    await fileActions(reader).waitFor({ state: 'hidden' })
    await reader.locator('.dsh-pdf-zoom-menu').waitFor({ state: 'visible' })
    await zoomControl.click()

    const pageField = sidebar.getByRole('textbox', { name: 'Page' })
    await pageField.focus()
    await setReaderWidth(700)
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    await pageField.evaluate(input => input.blur())
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await sidebar.getAttribute('class')).toContain('is-collapsed')
    await assertToolbarBesideSidebar()
    await expectIconOnlyMainToolbar(toolbar)
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-main-toolbar-narrow.png') })
    }
    await assertFeedbackInsideReadingColumn()

    // Growing the outer DSH pane must not turn a layout collapse into an
    // unsolicited sidebar opening, even when repeatedly crossing the threshold.
    for (const width of [960, 759, 760, 700, 960]) {
      await setReaderWidth(width)
      expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    }
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')

    await setReaderWidth(700)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await openSidebarSection(reader, 'Pages')
    await reader.getByRole('button', { name: 'Page 1 / 2' }).waitFor({ state: 'visible' })
    await assertToolbarBesideSidebar()

    // Even the narrowest reader keeps Save and the other primary actions in their own column.
    await setReaderWidth(280)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await assertToolbarBesideSidebar()
    await expectIconOnlyMainToolbar(toolbar)
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-main-toolbar-cramped.png') })
    }
    await assertFeedbackInsideReadingColumn()
    expect(await toolbar.locator('.dsh-pdf-toolbar-save').isVisible()).toBe(true)
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    expect(await fileActions(reader).getByRole('button', { name: 'Save', exact: true }).count()).toBe(0)
    await fileActions(reader).getByRole('button', { name: 'Save as', exact: true }).waitFor({ state: 'visible' })
    await toolbar.locator('.dsh-pdf-tools > summary').click()

    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    for (const width of [960, 700, 960]) {
      await setReaderWidth(width)
      expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    }
    await assertToolbarBesideSidebar()
    await assertFeedbackInsideReadingColumn()
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('keeps collapsed page navigation compact and supports direct page entry', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-compact-page-nav-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF compact page navigation test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-compact-page-nav-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF compact page navigation test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 10_000 })
    await reader.evaluate(element => { (element as HTMLElement).style.width = '700px' })
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const compactNav = sidebar.locator('.dsh-pdf-sidebar-page-nav.is-compact')
    await compactNav.waitFor({ state: 'visible' })
    const input = compactNav.getByRole('textbox', { name: 'Page' })
    const previous = compactNav.getByRole('button', { name: 'Previous page' })
    const next = compactNav.getByRole('button', { name: 'Next page' })
    expect(await input.inputValue()).toBe('1')
    expect((await compactNav.locator('.dsh-pdf-page-total').innerText()).trim()).toBe('2')
    expect(await previous.isDisabled()).toBe(true)
    expect(await next.isDisabled()).toBe(false)
    const tops = await compactNav.evaluate(element => {
      const top = (selector: string) => element.querySelector(selector)!.getBoundingClientRect().top
      return [top('button:first-child'), top('input'), top('.dsh-pdf-page-total'), top('button:last-child')]
    })
    expect(tops.every((top, index) => index === 0 || top > tops[index - 1])).toBe(true)
    await input.fill('2')
    await input.press('Enter')
    await expect.poll(() => input.inputValue()).toBe('2')
    await expect.poll(() => next.isDisabled()).toBe(true)
    await expect.poll(() => input.isEnabled()).toBe(true)
    await input.press('ArrowDown')
    await expect.poll(() => input.inputValue()).toBe('1')
    await expect.poll(() => input.isEnabled()).toBe(true)
    await input.fill('99')
    await input.blur()
    await expect.poll(() => input.inputValue()).toBe('2')
    await input.fill('1')
    await input.press('Enter')
    await expect.poll(() => input.inputValue()).toBe('1')
    await expect.poll(() => input.isEnabled()).toBe(true)
    await input.fill('3')
    await input.press('Enter')
    await expect.poll(() => input.inputValue()).toBe('1')
    expect(await input.getAttribute('aria-invalid')).toBeNull()
    await input.press('Escape')
    await expect.poll(() => input.inputValue()).toBe('1')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
