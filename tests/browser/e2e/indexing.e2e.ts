import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, newEnglishPage, openSettings, saveFailureShot, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { type EmbeddingRegistry } from '../../../src/embedding/index.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { plainPdf } from '../../fixtures/plain-pdf.ts'
import { join } from 'node:path'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { openSidebarSection } from '../support/toolbar.ts'
import { indexingFixture, mountIndexingControls, openIndexingTaskActions, openIndexingTasks, saveIndexingControlsShot } from '../support/indexing.ts'

it('shows per-PDF indexing progress and cancels and resumes through the shared task entry', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  let unregister: (() => void) | undefined
  const pending: Array<{ signal: AbortSignal; texts: string[]; complete(): void }> = []
  try {
    const embeddings = scaffold.ctx.get('pdfEmbedding') as EmbeddingRegistry
    unregister = embeddings.register({
      descriptor: { id: 'fixture.indexing', name: 'Fixture indexing', version: '1', execution: 'local' },
      describe: () => ({ engineId: 'fixture.indexing', engineVersion: '1', model: 'fixture', modelRevision: '1',
        dimensions: 2, maxBatchSize: 16, maxInputCharacters: 16000, encoding: 'fixture', fingerprint: 'fixture-indexing-v1' }),
      async embed(request) {
        return new Promise((resolve, reject) => {
          const abort = () => reject(request.signal.reason ?? new Error('cancelled'))
          const complete = () => { request.signal.removeEventListener('abort', abort); resolve(request.texts.map(() => [1, 0])) }
          pending.push({ signal: request.signal, texts: [...request.texts], complete })
          request.signal.addEventListener('abort', abort, { once: true })
          if (request.signal.aborted) abort()
        })
      },
    })
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-indexing-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF indexing test' })
    const name = 'reader-indexing-e2e.pdf'
    await writeFile(join(scaffold.workspaceCwd, name), plainPdf(Array.from({ length: 3 }, (_, index) => ({
      size: [300, 400], lines: [{ text: `Indexing page ${index + 1}`, x: 30, y: 300, size: 12 }],
    }))))

    browser = await launchBrowser()
    const page = await newEnglishPage(browser), tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-indexing-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached' })
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    await settings.getByRole('combobox', { name: 'Semantic search engine', exact: true }).selectOption('fixture.indexing')
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'pdf-reader')?.value).toMatchObject({ embeddingEngine: 'fixture.indexing' })
    await expect.poll(() => settings.locator('.dsh-pdf-settings-save-status').textContent()).toMatch(/^Settings are up to date/)
    await page.keyboard.press('Escape')
    await page.getByRole('treeitem').filter({ hasText: 'PDF indexing test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible' })
    await reader.locator('.dsh-pdf-activity-trigger').click()
    const tasks = reader.locator('.dsh-pdf-activity-popover')
    const progress = tasks.getByRole('progressbar', { name: `Read pages: ${name}`, exact: true })
    await progress.waitFor({ state: 'visible' })
    // The Reader shell mounts before opening and preparing its durable plan.
    // Wait for the actual embedding phase before inspecting the held request.
    await tasks.getByText('Computing embeddings…', { exact: true }).waitFor()
    await expect.poll(() => pending.length).toBe(1)
    expect(await progress.getAttribute('max')).toBe('3')
    expect(await tasks.getByRole('progressbar', { name: `Indexed passages: ${name}`, exact: true }).count()).toBe(1)
    await tasks.getByRole('button', { name: `Cancel indexing: ${name}`, exact: true }).click()
    await tasks.getByText('Indexing cancelled', { exact: true }).waitFor()
    await expect.poll(() => pending[0]!.signal.aborted).toBe(true)
    // Search owns manual preparation; task notifications own progress and cancellation.
    await openSidebarSection(reader, 'Search')
    const manual = reader.locator('.dsh-pdf-search-indexing').getByRole('button', { name: /^(Index PDF|Update index|Resume indexing)$/ })
    await expect.poll(() => manual.isEnabled()).toBe(true)
    await manual.click()
    await expect.poll(() => pending.length).toBe(2)
    if (!await tasks.isVisible()) await reader.locator('.dsh-pdf-activity-trigger').click()
    await progress.waitFor({ state: 'visible' })
    // The resumed request batches all three short pages. Cancelled inference
    // contributes no saved vectors; one real successful batch completes them.
    expect(pending[1]!.texts).toHaveLength(3)
    pending[1]!.complete()
    await tasks.getByText('Index ready', { exact: true }).waitFor()
    expect(pending).toHaveLength(2)
    await expect.poll(() => manual.textContent()).toBe('Update index')
    await expect.poll(() => manual.isEnabled()).toBe(true)
    // Another resource Session opens the same bytes with its own working-copy
    // identity. It must reuse the completed resident index, even without a new
    // embedding reply being made available by this fixture.
    const secondSession = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-indexing-reuse-web-e2e')
    await workspace.attachSession(secondSession)
    await scaffold.ctx.sessionController.rename({ sessionId: secondSession, title: 'PDF indexing reuse test' })
    await page.getByRole('treeitem').filter({ hasText: 'PDF indexing reuse test' }).click()
    if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
    await openSidebarSection(reader, 'Search')
    await expect.poll(() => manual.textContent()).toBe('Update index')
    if (!await tasks.isVisible()) await reader.locator('.dsh-pdf-activity-trigger').click()
    await tasks.getByText('Index ready', { exact: true }).waitFor()
    expect(pending).toHaveLength(2)
    await page.clock.install()
    await page.clock.fastForward(60_000)
    expect(await tasks.locator('.dsh-pdf-indexing-status[data-tone="success"]').count()).toBe(1)
    await reader.locator('.dsh-pdf-activity-trigger').click()
    await reader.locator('.dsh-pdf-activity-trigger').click()
    expect(await tasks.getByText('Index ready', { exact: true }).isVisible()).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  } finally { for (const task of pending) task.complete(); unregister?.(); await browser?.close(); await scaffold.close() }
})

it('keeps indexing controls in search and shares dismissible task notifications across Readers through the real Client API', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-indexing-controls'))
    const tripwire = watchConsole(page)
    await page.route('http://localhost/pdf-indexing-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }))
    await page.goto('http://localhost/pdf-indexing-fixture')
    await mountIndexingControls(page)
    expect(await page.evaluate(() => typeof ClipboardItem)).toBe('function')
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { async write(items: ClipboardItem[]) {
        const value = await (await items[0]!.getType('text/plain')).text()
        Object.assign(window, { __copiedIndexingReport: value })
      } } }))
    const fixture = indexingFixture(page)
    const first = page.locator('[data-reader-view="first"]')
    const search = first.locator('.dsh-pdf-search-indexing')
    expect(await first.locator('.dsh-pdf-toolbar-index').count()).toBe(0)
    await search.getByRole('button', { name: 'Index PDF', exact: true }).click()
    await expect.poll(fixture.calls).toEqual([{ action: 'start', sessionId: 'session-a', documentId: 'alpha' }])
    await first.locator('.dsh-pdf-activity-trigger').click()
    const task = first.locator('[data-status-id="indexing:alpha"]')
    await task.getByRole('progressbar', { name: 'Read pages: alpha.pdf', exact: true }).waitFor()
    expect(await task.getAttribute('data-tone')).toBe('progress')
    await saveIndexingControlsShot(page, 'indexing-running')
    await task.getByRole('button', { name: 'Cancel indexing: alpha.pdf', exact: true }).click()
    await task.getByText('Indexing cancelled', { exact: true }).waitFor()
    await search.getByRole('button', { name: 'Resume indexing', exact: true }).click()
    await expect.poll(async () => (await fixture.calls()).map(call => call.action)).toEqual(['start', 'cancel', 'resume'])
    await openIndexingTasks(first)
    await fixture.publish('ready')
    await task.getByRole('button', { name: 'Close notification: alpha.pdf', exact: true }).waitFor()
    await saveIndexingControlsShot(page, 'indexing-ready')
    await task.getByRole('button', { name: 'Close notification: alpha.pdf', exact: true }).click()
    expect(await first.locator('[data-status-id="indexing:alpha"]').count()).toBe(0)
    await expect.poll(() => search.getByRole('button', { name: 'Update index', exact: true }).textContent()).toBe('Update index')
    const beforeRepublish = await fixture.revision()
    await fixture.republish()
    await expect.poll(fixture.revision).not.toBe(beforeRepublish)
    expect(await first.locator('[data-status-id="indexing:alpha"]').count()).toBe(0)

    // A second mounted view of the same resource Session shares the acknowledgement.
    await fixture.show('mirror')
    const mirror = page.locator('[data-reader-view="mirror"]')
    await openIndexingTasks(mirror)
    expect(await mirror.locator('[data-status-id="indexing:alpha"]').count()).toBe(0)
    await mirror.locator('.dsh-pdf-search-indexing').getByRole('button', { name: 'Update index', exact: true }).click()
    await expect.poll(async () => (await fixture.calls()).at(-1)).toEqual({ action: 'start', sessionId: 'session-a', documentId: 'alpha' })
    await openIndexingTasks(mirror)
    const mirrorTask = mirror.locator('[data-status-id="indexing:alpha"]')
    await mirrorTask.getByRole('progressbar', { name: 'Read pages: alpha.pdf', exact: true }).waitFor()
    await fixture.publish('failed')
    await expect.poll(() => mirrorTask.getAttribute('data-tone')).toBe('error')
    await mirrorTask.getByText('fixture/unavailable', { exact: true }).waitFor()
    expect(await mirrorTask.getByRole('progressbar', { name: 'Read pages: alpha.pdf', exact: true }).getAttribute('value')).toBe('1')
    expect(await mirrorTask.getByRole('progressbar', { name: 'Indexed passages: alpha.pdf', exact: true }).getAttribute('value')).toBe('0')
    const diagnostics = await openIndexingTaskActions(mirror, 'alpha.pdf')
    await diagnostics.getByRole('button', { name: 'Copy diagnostics: alpha.pdf', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __copiedIndexingReport?: string }).__copiedIndexingReport))
      .toBe(JSON.stringify({ diagnosticId: 'fixture-index-3', sessionId: 'session-a', documentId: 'alpha', occurrence: 3 }))
    await openIndexingTaskActions(mirror, 'alpha.pdf')
    expect(await diagnostics.getByRole('button', { name: 'Copy diagnostics: alpha.pdf', exact: true }).textContent()).toBe('Copied')
    await diagnostics.getByRole('button', { name: 'Open log folder: alpha.pdf', exact: true }).click()
    await expect.poll(fixture.diagnosticCalls).toEqual([
      { action: 'report', sessionId: 'session-a', documentId: 'alpha', occurrence: 3 },
      { action: 'open', sessionId: 'session-a', documentId: 'alpha', occurrence: 3 },
    ])
    // The same shared task card must retain readable actions when the viewport
    // is narrow; diagnostics cannot become a new source of horizontal overflow.
    await page.setViewportSize({ width: 640, height: 480 })
    await openIndexingTasks(mirror)
    const narrowMenu = await openIndexingTaskActions(mirror, 'alpha.pdf')
    const diagnosticBounds = await narrowMenu.getByRole('button').evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect(), menu = button.closest('[data-pdf-popover-id]')!.getBoundingClientRect()
      const reader = button.closest('.dsh-pdf-reader')!.getBoundingClientRect()
      return { inside: box.left >= menu.left - 1 && box.right <= menu.right + 1 && box.top >= menu.top - 1 && box.bottom <= menu.bottom + 1
          && menu.left >= reader.left - 1 && menu.right <= reader.right + 1,
        readable: box.width >= 28 && button.scrollWidth <= button.clientWidth + 1 }
    }))
    await saveIndexingControlsShot(page, 'indexing-failed')
    expect(diagnosticBounds.every(button => button.inside && button.readable), JSON.stringify(diagnosticBounds)).toBe(true)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1180, height: 800 })
    await mirrorTask.getByRole('button', { name: 'Retry indexing: alpha.pdf', exact: true }).click()
    await expect.poll(async () => (await fixture.calls()).map(call => call.action)).toEqual(['start', 'cancel', 'resume', 'start', 'resume'])
    await fixture.publish('ready')
    await mirrorTask.getByRole('button', { name: 'Close notification: alpha.pdf', exact: true }).click()
    await fixture.show('first')
    expect(await first.locator('[data-status-id="indexing:alpha"]').count()).toBe(0)

    // Another Session has its own notifications, even when its view was hidden.
    await fixture.publish('ready', 'session-b', 'beta')
    await fixture.show('other-session')
    const other = page.locator('[data-reader-view="other-session"]')
    await openIndexingTasks(other)
    await other.getByRole('button', { name: 'Close notification: beta.pdf', exact: true }).waitFor()
    expect(await fixture.errors()).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  } finally { await browser.close() }
})

it('keeps task cards compact with nested diagnostic actions, keyboard dismissal and contextual primary controls', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-task-actions'))
    const tripwire = watchConsole(page)
    await mountIndexingControls(page)
    const fixture = indexingFixture(page)
    const reader = page.locator('[data-reader-view="first"]')
    const activity = reader.locator('.dsh-pdf-activity-trigger')
    const card = reader.locator('[data-status-id="indexing:alpha"]')
    const more = reader.getByRole('button', { name: 'More task actions: alpha.pdf', exact: true })
    const close = reader.getByRole('button', { name: 'Close notification: alpha.pdf', exact: true })
    const saveCard = async (name: string) => {
      const directory = process.env.DSH_PDF_STATUS_ACTIONS_PREVIEW_DIR
      if (!directory) return
      await mkdir(directory, { recursive: true })
      await card.evaluate(element => {
        const focused = element.ownerDocument.activeElement
        if (focused instanceof HTMLElement && element.contains(focused)) focused.blur()
      })
      await page.mouse.move(0, page.viewportSize()!.height - 1)
      await card.screenshot({ path: join(directory, `${name}.png`) })
    }
    await reader.locator('.dsh-pdf-search-indexing').getByRole('button', { name: 'Index PDF', exact: true }).click()
    await openIndexingTasks(reader)
    await card.getByRole('button', { name: 'Cancel indexing: alpha.pdf', exact: true }).waitFor()
    expect(await close.count()).toBe(0)
    expect(await card.getByRole('button').count(), 'only Cancel and More are visible on a running task').toBe(2)
    expect(await reader.getByRole('button', { name: 'Copy diagnostics: alpha.pdf', exact: true }).isVisible()).toBe(false)
    await saveCard('running')

    await more.focus()
    await more.press('Enter')
    const menu = reader.getByRole('group', { name: 'More task actions: alpha.pdf', exact: true })
    await menu.waitFor({ state: 'visible' })
    await expect.poll(() => menu.getByRole('button', { name: 'Copy diagnostics: alpha.pdf', exact: true })
      .evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    await page.keyboard.press('Tab')
    expect(await menu.getByRole('button', { name: 'Open log folder: alpha.pdf', exact: true })
      .evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    expect(await activity.getAttribute('aria-expanded')).toBe('true')
    expect(await more.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    expect(await activity.getAttribute('aria-expanded')).toBe('false')
    expect(await activity.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)

    await fixture.publish('ready')
    await openIndexingTasks(reader)
    await close.waitFor({ state: 'visible' })
    expect(await card.getByRole('button', { name: /Cancel indexing|Resume indexing|Done/ }).count()).toBe(0)
    expect(await close.locator('svg[data-icon="close"]').count()).toBe(1)
    expect(await card.getByRole('button').count(), 'only More and Close remain on a completed task').toBe(2)
    expect(await card.locator('.dsh-pdf-indexing-task-title').textContent()).toBe('alpha.pdf')
    expect(await card.getByText('Index ready', { exact: true }).isVisible()).toBe(true)
    await saveCard('ready')

    await page.setViewportSize({ width: 320, height: 400 })
    const narrowMenu = await openIndexingTaskActions(reader, 'alpha.pdf')
    const bounds = await narrowMenu.evaluate(element => {
      const menu = element.getBoundingClientRect(), reader = element.closest('.dsh-pdf-reader')!.getBoundingClientRect()
      return { inside: menu.left >= reader.left - 1 && menu.right <= reader.right + 1 && menu.top >= reader.top - 1 && menu.bottom <= reader.bottom + 1,
        readable: [...element.querySelectorAll('button')].every(button => button.scrollWidth <= button.clientWidth + 1),
        menu: { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom },
        reader: { left: reader.left, right: reader.right, top: reader.top, bottom: reader.bottom },
        scroll: (() => { const rect = element.closest('.dsh-pdf-reader')!.querySelector('.dsh-pdf-scroll')!.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } })(),
        style: element.getAttribute('style'), parent: (element as HTMLElement).dataset.pdfPopoverParent }
    })
    const directory = process.env.DSH_PDF_STATUS_ACTIONS_PREVIEW_DIR
    if (directory) await narrowMenu.screenshot({ path: join(directory, 'more-menu-narrow.png') })
    expect(bounds.inside, JSON.stringify(bounds)).toBe(true)
    expect(bounds.readable, JSON.stringify(bounds)).toBe(true)
    await page.keyboard.press('Escape')
    expect(await activity.getAttribute('aria-expanded')).toBe('true')
    await close.click()
    await card.waitFor({ state: 'detached' })
    expect(await activity.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    expect(await reader.locator('.dsh-pdf-search-indexing').getByRole('button', { name: 'Update index', exact: true }).isEnabled()).toBe(true)

    await page.setViewportSize({ width: 1180, height: 800 })
    await reader.locator('.dsh-pdf-search-indexing').getByRole('button', { name: 'Update index', exact: true }).click()
    await fixture.publish('failed')
    await openIndexingTasks(reader)
    await card.getByRole('button', { name: 'Retry indexing: alpha.pdf', exact: true }).waitFor()
    expect(await close.count()).toBe(0)
    expect(await more.isVisible()).toBe(true)
    expect(await card.getByRole('button').count(), 'only Resume and More are visible after failure').toBe(2)
    await saveCard('failed')
    expect(await fixture.errors()).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  } finally { await browser.close() }
})

it('keeps indexing actions reachable in the short search panel and hides manual commands when semantic indexing is disabled', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 320 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-indexing-controls-short'))
    await mountIndexingControls(page)
    const fixture = indexingFixture(page)
    const reader = page.locator('[data-reader-view="first"]')
    const search = reader.locator('.dsh-pdf-search-indexing')
    const start = search.getByRole('button', { name: 'Index PDF', exact: true })
    await start.click()
    const bounds = await start.evaluate(element => {
      const button = element.getBoundingClientRect(), panel = element.closest('.dsh-pdf-search-panel')!.getBoundingClientRect()
      return { inside: button.left >= panel.left && button.right <= panel.right && button.top >= panel.top && button.bottom <= panel.bottom }
    })
    expect(bounds.inside).toBe(true)
    // Settings actions must also fit the true minimum drawer width. Their
    // complete labels can wrap instead of widening the shared scrollport.
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    await sidebar.locator('.dsh-pdf-sidebar-divider').press('Home')
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    const scroll = reader.locator('.dsh-pdf-search-panel > .dsh-pdf-panel-scroll')
    expect(await scroll.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const settingsActions = search.locator('.dsh-pdf-index-secondary-actions button')
    expect(await settingsActions.count()).toBe(2)
    const settingsBounds = await settingsActions.evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect(), viewport = button.closest('.dsh-pdf-panel-scroll')!.getBoundingClientRect()
      return { fits: box.left >= viewport.left - 1 && box.right <= viewport.right + 1,
        textFits: button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1 }
    }))
    expect(settingsBounds.every(button => button.fits && button.textFits)).toBe(true)
    await saveIndexingControlsShot(page, 'indexing-search-short')
    expect(await reader.locator('[data-pdf-tool-rail] [data-document-command="index"]').count()).toBe(0)
    await reader.locator('.dsh-pdf-document-menu > summary').click()
    expect(await reader.locator('.dsh-pdf-tools-menu').getByRole('button', { name: /Index PDF|Update index|Rebuild index/ }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await reader.locator('.dsh-pdf-activity-trigger').click()
    await reader.getByRole('button', { name: 'Cancel indexing: alpha.pdf', exact: true }).click()
    await fixture.disable()
    await expect.poll(() => search.getByRole('button', { name: /^(Index PDF|Update index|Rebuild index)$/ }).count()).toBe(0)
    expect(await search.getByRole('combobox').count()).toBe(0)
    expect(await search.getByRole('checkbox').count()).toBe(2)
    expect(await search.getByRole('checkbox', { name: 'Text recognition (OCR)', exact: true }).isEnabled()).toBe(true)
    expect(await search.getByRole('button', { name: 'Use current defaults', exact: true }).isEnabled()).toBe(true)
    expect(await fixture.errors()).toEqual([])
  } finally { await browser.close() }
})

it('keeps document index settings readable, aligned and keyboard usable in light and dark narrow sidebars', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-index-settings-layout'))
    const tripwire = watchConsole(page)
    await mountIndexingControls(page)
    // The isolated fixture loads the real Reader chrome, but has no DSH app
    // shell to provide dark tokens. Supply the equivalent host theme values.
    await page.addStyleTag({ content: `body[data-ds-dark-theme] {
      --dsw-alias-bg-base:#202124; --dsw-alias-bg-layer-1:#2b2d30;
      --dsw-alias-label-primary:#f2f3f4; --dsw-alias-label-secondary:#aeb1b8;
      --dsw-alias-border-l2:#484b50; --dsw-alias-link:#83adff;
      --dsw-alias-button-primary-fill:#e9eaec; --dsw-alias-label-primary-foreground:#202124;
      --dsw-alias-bg-document-preview:#202124; --dsw-alias-interactive-bg-hover:#3d4045;
    }` })
    const fixture = indexingFixture(page)
    const reader = page.locator('[data-reader-view="first"]')
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const settings = reader.locator('.dsh-pdf-search-indexing')
    const separator = sidebar.getByRole('separator')
    const help = settings.locator('.dsh-pdf-index-help')
    const helpSummary = help.getByText('Indexing details', { exact: true })
    const previewDirectory = process.env.DSH_PDF_INDEXING_PREVIEW_DIR
    if (previewDirectory) await mkdir(previewDirectory, { recursive: true })

    for (const dark of [false, true]) {
      await page.locator('body').evaluate((body, dark) => {
        if (dark) body.setAttribute('data-ds-dark-theme', '')
        else body.removeAttribute('data-ds-dark-theme')
      }, dark)
      for (const width of [220, 300]) {
        await separator.scrollIntoViewIfNeeded()
        const handle = await separator.boundingBox(), current = await sidebar.boundingBox()
        expect(handle).not.toBeNull(); expect(current).not.toBeNull()
        const x = handle!.x + handle!.width / 2, y = handle!.y + 36
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + current!.width - width, y, { steps: 4 })
        await page.mouse.up()
        await expect.poll(() => sidebar.getAttribute('style')).toContain(`--pdf-sidebar-width: ${width}px`)
        await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))

        const primary = settings.locator('.dsh-pdf-index-primary-action')
        await primary.scrollIntoViewIfNeeded()
        const layout = await settings.evaluate(element => {
          const options = element.querySelector<HTMLElement>('.dsh-pdf-index-options')!
          const primary = element.querySelector<HTMLElement>('.dsh-pdf-index-primary-action')!
          const optionBox = options.getBoundingClientRect(), buttonBox = primary.getBoundingClientRect()
          const scroll = element.closest<HTMLElement>('.dsh-pdf-panel-scroll')!
          const viewport = scroll.getBoundingClientRect()
          const controls = [...element.querySelectorAll<HTMLElement>('button,label,summary')]
            .filter(control => !!control.getClientRects().length)
          const splitWords: string[] = []
          for (const title of element.querySelectorAll<HTMLElement>('.dsh-pdf-index-option-title > span,.dsh-pdf-index-secondary-actions button')) {
            const style = getComputedStyle(title), box = title.getBoundingClientRect()
            if (style.display === 'none' || style.position === 'absolute' && box.width <= 1) continue
            const text = title.firstChild
            if (!text || text.nodeType !== Node.TEXT_NODE) continue
            for (const match of (text.textContent ?? '').matchAll(/\S+/g)) {
              const range = document.createRange()
              range.setStart(text, match.index!); range.setEnd(text, match.index! + match[0].length)
              if ([...range.getClientRects()].filter(rect => rect.width > 0.5).length > 1) splitWords.push(match[0])
            }
          }
          return {
            overflow: scroll.scrollWidth - scroll.clientWidth,
            aligned: Math.abs(optionBox.left - buttonBox.left) <= 1 && Math.abs(optionBox.right - buttonBox.right) <= 1,
            splitWords,
            controlsFit: controls.every(control => {
              const box = control.getBoundingClientRect()
              return box.left >= viewport.left - 1 && box.right <= viewport.right + 1 && control.scrollWidth <= control.clientWidth + 1
            }),
          }
        })
        expect(layout.overflow, JSON.stringify({ dark, width, layout })).toBeLessThanOrEqual(1)
        expect(layout.aligned, JSON.stringify({ dark, width, layout })).toBe(true)
        expect(layout.controlsFit, JSON.stringify({ dark, width, layout })).toBe(true)
        expect(layout.splitWords, JSON.stringify({ dark, width, layout })).toEqual([])

        const descriptions = settings.getByRole('checkbox', { name: 'Image descriptions', exact: true })
        const selected = await descriptions.isChecked(), before = (await fixture.calls()).length
        await descriptions.setChecked(!selected)
        await expect.poll(async () => (await fixture.calls()).length).toBe(before + 1)
        await expect.poll(() => descriptions.isEnabled()).toBe(true)
        expect((await fixture.calls()).at(-1)).toEqual({ action: 'configure', sessionId: 'session-a', documentId: 'alpha' })
        expect((await fixture.calls()).slice(before).some(call => call.action !== 'configure')).toBe(false)

        await helpSummary.focus()
        const wasOpen = await help.evaluate(element => (element as HTMLDetailsElement).open)
        await page.keyboard.press('Enter')
        await expect.poll(() => help.evaluate(element => (element as HTMLDetailsElement).open)).toBe(!wasOpen)
        await page.keyboard.press('Space')
        await expect.poll(() => help.evaluate(element => (element as HTMLDetailsElement).open)).toBe(wasOpen)
        if (wasOpen) await helpSummary.press('Enter')
        await helpSummary.evaluate(element => (element as HTMLElement).blur())
        await reader.locator('.dsh-pdf-search-panel > .dsh-pdf-panel-scroll').evaluate(element => { element.scrollTop = 0 })
        await page.mouse.move(0, 0)
        if (previewDirectory) await sidebar.screenshot({ path: join(previewDirectory,
          `index-settings-${dark ? 'dark' : 'light'}-${width}.png`) })
      }
    }
    expect(await fixture.errors()).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  } finally { await browser.close() }
})

it('saves only document content switches across mirror views without starting work or changing another PDF', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 620 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-document-index-settings'))
    const tripwire = watchConsole(page)
    await mountIndexingControls(page)
    const fixture = indexingFixture(page)
    const first = page.locator('[data-reader-view="first"]')
    const settings = first.locator('.dsh-pdf-search-indexing')
    await fixture.publish('ready')
    await expect.poll(() => settings.getByRole('button', { name: 'Update index', exact: true }).isEnabled()).toBe(true)
    expect(await settings.getByRole('combobox').count()).toBe(0)
    expect(await settings.getByRole('checkbox').count()).toBe(2)
    await settings.getByRole('checkbox', { name: 'Image descriptions', exact: true }).check()
    await expect.poll(fixture.calls).toEqual([{ action: 'configure', sessionId: 'session-a', documentId: 'alpha' }])
    const pendingSettings = 'Settings saved. Continuing uses the original plan; update the index to apply new settings.'
    await settings.getByText(pendingSettings, { exact: true }).waitFor()
    expect(await first.locator('[data-status-id="indexing:alpha"][data-tone="success"]').count()).toBe(1)
    await fixture.publish('cancelled')

    await fixture.show('other-document')
    const another = page.locator('[data-reader-view="other-document"] .dsh-pdf-search-indexing')
    expect(await another.getByRole('checkbox', { name: 'Image descriptions', exact: true }).isChecked()).toBe(false)
    expect(await another.getByRole('combobox').count()).toBe(0)
    await fixture.show('mirror')
    const mirror = page.locator('[data-reader-view="mirror"]')
    const mirrorSettings = mirror.locator('.dsh-pdf-search-indexing')
    expect(await mirrorSettings.getByRole('checkbox', { name: 'Image descriptions', exact: true }).isChecked()).toBe(true)
    expect(await mirrorSettings.getByRole('combobox').count()).toBe(0)
    await mirrorSettings.getByRole('button', { name: 'Resume indexing', exact: true }).click()
    await expect.poll(async () => (await fixture.calls()).map(call => call.action)).toEqual(['configure', 'resume'])
    await mirrorSettings.getByText(pendingSettings, { exact: true }).waitFor()
    await fixture.publish('cancelled')
    const details = mirrorSettings.locator('.dsh-pdf-index-help')
    await details.locator('summary').click()
    await details.getByRole('button', { name: 'Apply new settings and update index', exact: true }).click()
    await expect.poll(async () => (await fixture.calls()).map(call => call.action)).toEqual(['configure', 'resume', 'start'])
    await fixture.publish('ready')
    await mirrorSettings.getByText('Settings saved for this PDF.', { exact: true }).waitFor()
    await mirrorSettings.getByRole('checkbox', { name: 'Text recognition (OCR)', exact: true }).uncheck()
    await expect.poll(async () => (await fixture.calls()).map(call => call.action)).toEqual(['configure', 'resume', 'start', 'configure'])
    expect(await mirrorSettings.getByRole('checkbox', { name: 'Image descriptions', exact: true }).isChecked()).toBe(true)
    await mirrorSettings.getByRole('button', { name: 'Use current defaults', exact: true }).click()
    await expect.poll(async () => (await fixture.calls()).map(call => call.action)).toEqual(['configure', 'resume', 'start', 'configure', 'defaults'])
    expect(await mirrorSettings.getByRole('checkbox', { name: 'Text recognition (OCR)', exact: true }).isChecked()).toBe(true)
    expect(await mirrorSettings.getByRole('checkbox', { name: 'Image descriptions', exact: true }).isChecked()).toBe(false)

    await fixture.show('other-session')
    const other = page.locator('[data-reader-view="other-session"] .dsh-pdf-search-indexing')
    expect(await other.getByRole('checkbox', { name: 'Image descriptions', exact: true }).isChecked()).toBe(false)
    expect(await other.getByRole('combobox').count()).toBe(0)
    expect(await fixture.errors()).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  } finally { await browser.close() }
})
