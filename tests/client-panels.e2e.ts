/** Real Web/Chromium panel interactions, collected from the built PDF Client. */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from '../../deepseek-harness/apps/web/tests/scaffold.ts'
import { newEnglishPage } from '../../deepseek-harness/apps/web/tests/support.ts'
import { attachPdfBrowserCoverage } from './browser-coverage.ts'
import type { DshTranslationLlm } from '../src/adapters/host/dsh/translation-model.ts'
import { loadPdfDocument } from '../src/adapters/host/pdf-lib/pdf-document.ts'
import { recoverableOutlineFixture } from './fixtures/recoverable-outline.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_ROOT = join(ROOT, '..', 'deepseek-harness')
const SESSION = join(DSH_ROOT, 'snapshots', 'web', 'seeded-history', 'session.v3.jsonl')
const MODEL_FIXTURE = join(DSH_ROOT, 'apps/web/tests/fixtures/deepseek-model-label-1017/session.v4.jsonl')
const FILE_NAME = 'panel-coverage.pdf'

async function browser(): Promise<Browser> {
  if (process.env.PDF_BENCH_CHROMIUM) return attachPdfBrowserCoverage(await chromium.launch({ executablePath: process.env.PDF_BENCH_CHROMIUM }))
  if (existsSync(chromium.executablePath())) return attachPdfBrowserCoverage(await chromium.launch())
  return attachPdfBrowserCoverage(await chromium.launch({ channel: 'chrome' }))
}

async function documentBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= 4; number++) {
    const page = document.addPage([1100, 700])
    page.drawText(`Coverage page ${number}`, { x: 50, y: 610, size: 20, font })
    if (number !== 1) continue
    const records = [
      { kind: 'Text', text: 'A plain note', rect: [50, 530, 75, 555] },
      { kind: 'Highlight', text: 'A highlighted line', rect: [48, 600, 290, 630] },
      { kind: 'Underline', text: 'An underlined line', rect: [48, 600, 290, 630] },
      { kind: 'StrikeOut', text: 'A struck line', rect: [48, 600, 290, 630] },
    ] as const
    const refs = records.map(({ kind, text, rect }) => document.context.register(document.context.obj({
      Type: 'Annot', Subtype: kind, P: page.ref, Rect: rect,
      Contents: PDFHexString.fromText(text), C: [1, 0.55, 0], F: 4,
      ...(kind === 'Text' ? {} : { QuadPoints: [48, 630, 290, 630, 48, 600, 290, 600] }),
    })))
    page.node.set(PDFName.of('Annots'), document.context.obj(refs))
  }
  return document.save({ useObjectStreams: false })
}

async function openReader(page: Page, url: string, title: string) {
  await page.goto(url, { waitUntil: 'load' })
  await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
  await page.getByRole('treeitem').filter({ hasText: title }).click()
  const restoredReader = page.locator('.dsh-pdf-reader')
  if (await restoredReader.isVisible()) {
    await restoredReader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    return restoredReader
  }
  const column = page.locator('[data-rightbar-col]')
  const expand = page.locator('[data-sidebar-right-expand]')
  if (await expand.isVisible()) await expand.click()
  await column.locator('[data-sidebar-right-guide-entry="files"]').click()
  await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
  await column.locator('[data-files-reload]').click()
  await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()
  const reader = page.locator('.dsh-pdf-reader')
  await reader.waitFor({ state: 'visible', timeout: 20_000 })
  await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
    .waitFor({ state: 'visible', timeout: 20_000 })
  return reader
}

it('edits embedded bookmark titles, targets and hierarchy through save and reopen', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let opened: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-outline-edit-e2e')
    await workspace.attachSession(sessionId)
    const title = 'PDF outline edit test'
    await scaffold.ctx.sessionController.rename({ sessionId, title })
    const path = join(scaffold.workspaceCwd, FILE_NAME)
    await writeFile(path, await documentBytes())
    opened = await browser()
    const page = await newEnglishPage(opened)
    const tripwire = watchConsole(page)
    let reader = await openReader(page, scaffold.authenticatedUrl, title)
    await reader.getByRole('tab', { name: 'Bookmarks', exact: true }).click()

    const add = async (name: string, target: number) => {
      await reader.getByRole('button', { name: 'Add PDF bookmark', exact: true }).click()
      const form = reader.getByRole('form', { name: 'Add PDF bookmark', exact: true })
      await expect.poll(() => form.getByRole('textbox').evaluate(element => element === document.activeElement)).toBe(true)
      await form.getByRole('textbox', { name: 'Bookmark name', exact: true }).fill(name)
      await form.getByRole('textbox').press('Enter')
      await reader.locator('.dsh-pdf-bookmark-link').filter({ hasText: name }).waitFor()
      await reader.getByRole('button', { name: `More bookmark actions: ${name}`, exact: true }).click()
      await reader.getByRole('menuitem', { name: 'Change destination…', exact: true }).click()
      const destination = reader.getByRole('dialog', { name: 'Target page', exact: true })
      await destination.getByRole('spinbutton', { name: 'Target page', exact: true }).fill(String(target))
      await destination.getByRole('button', { name: 'Set destination', exact: true }).click()
      await destination.waitFor({ state: 'detached' })
    }
    await add('Chapter A', 2)
    await add('Chapter B', 3)
    // The drop target's middle nests; no property form or separate edit mode.
    await reader.getByRole('button', { name: 'Reorder bookmark: Chapter B', exact: true }).dragTo(
      reader.locator('.dsh-pdf-bookmark-row').filter({ hasText: 'Chapter A' }), { targetPosition: { x: 90, y: 18 } })
    await expect.poll(() => reader.locator('.dsh-pdf-bookmark-row').filter({ hasText: 'Chapter B' }).getAttribute('aria-level')).toBe('2')
    await reader.getByRole('button', { name: 'More bookmark actions: Chapter B', exact: true }).click()
    await reader.getByRole('menuitem', { name: 'Rename bookmark', exact: false }).click()
    let form = reader.getByRole('form', { name: 'Rename bookmark', exact: true })
    await form.getByRole('textbox', { name: 'Bookmark name', exact: true }).fill('Nested section')
    await form.getByRole('textbox').press('Enter')
    await reader.getByRole('button', { name: 'More bookmark actions: Nested section', exact: true }).waitFor()
    await reader.getByRole('button', { name: 'More bookmark actions: Chapter A', exact: true }).click()
    await reader.getByRole('menuitem', { name: 'Rename bookmark', exact: false }).click()
    form = reader.getByRole('form', { name: 'Rename bookmark', exact: true })
    await form.getByRole('textbox', { name: 'Bookmark name', exact: true }).fill('Opening chapter')
    await form.getByRole('textbox').press('Enter')
    await expect.poll(() => reader.locator('.dsh-pdf-bookmark-row').filter({ hasText: 'Opening chapter' })
      .evaluate(element => element === document.activeElement)).toBe(true)
    const parentRow = reader.locator('.dsh-pdf-bookmark-row').filter({ hasText: 'Opening chapter' })
    const parentTitle = parentRow.locator('.dsh-pdf-bookmark-title')
    const childTitle = reader.locator('.dsh-pdf-bookmark-title').filter({ hasText: 'Nested section' })
    const inset = await parentTitle.evaluate(element => element.getBoundingClientRect().left
      - element.closest('.dsh-pdf-bookmark-panel')!.getBoundingClientRect().left)
    expect(inset).toBeGreaterThanOrEqual(30)
    expect(inset).toBeLessThanOrEqual(34)
    const parentBox = (await parentTitle.boundingBox())!, childBox = (await childTitle.boundingBox())!
    expect(childBox.x - parentBox.x).toBe(14)
    await reader.getByRole('tab', { name: 'Bookmarks', exact: true }).focus()
    await page.mouse.move(0, 0)
    const idleX = (await parentTitle.boundingBox())!.x
    await parentRow.hover()
    expect((await parentTitle.boundingBox())!.x).toBe(idleX)
    const grip = parentRow.locator('.dsh-pdf-outline-grip')
    expect((await grip.boundingBox())!.x).toBeGreaterThan((await parentTitle.boundingBox())!.x + (await parentTitle.boundingBox())!.width)
    expect(await grip.locator('svg').evaluate(element => ({ width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height, display: getComputedStyle(element).display })))
      .toEqual({ width: 14, height: 14, display: 'block' })
    if (process.env.PDF_BOOKMARK_ALIGNMENT_SCREENSHOT) {
      const panel = reader.locator('.dsh-pdf-bookmark-panel')
      const bounds = (await panel.boundingBox())!, last = (await reader.locator('.dsh-pdf-bookmark-row').last().boundingBox())!
      await page.screenshot({ path: process.env.PDF_BOOKMARK_ALIGNMENT_SCREENSHOT,
        clip: { ...bounds, height: Math.min(bounds.height, last.y + last.height - bounds.y + 12) } })
    }
    // A portaled menu remains inside the reader even when its sidebar is narrow.
    await reader.getByRole('button', { name: 'More bookmark actions: Opening chapter', exact: true }).click()
    const menu = reader.getByRole('menu', { name: 'More bookmark actions', exact: true })
    const menuBox = await menu.boundingBox(), readerBox = await reader.boundingBox()
    expect(menuBox && readerBox && menuBox.x >= readerBox.x && menuBox.y >= readerBox.y
      && menuBox.x + menuBox.width <= readerBox.x + readerBox.width
      && menuBox.y + menuBox.height <= readerBox.y + readerBox.height).toBe(true)
    await menu.press('Escape')
    const save = reader.locator('.dsh-pdf-toolbar-save')
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(async () => (await loadPdfDocument(await readFile(path))).outline?.[0]?.title).toBe('Opening chapter')
    const saved = await loadPdfDocument(await readFile(path))
    expect(saved.outline?.[0]?.page).toBe(2)
    expect(saved.outline?.[0]?.children[0]?.title).toBe('Nested section')
    expect(saved.outline?.[0]?.children[0]?.page).toBe(3)
    await expect.poll(() => save.isDisabled()).toBe(true)

    reader = await openReader(page, scaffold.authenticatedUrl, title)
    await reader.getByRole('tab', { name: 'Bookmarks', exact: true }).click()
    await reader.getByRole('button', { name: 'More bookmark actions: Opening chapter', exact: true }).click()
    await reader.getByRole('menuitem', { name: 'Delete bookmark', exact: true }).click()
    await reader.getByRole('dialog', { name: 'Delete PDF bookmark', exact: true }).getByRole('button', { name: 'Delete?', exact: true }).click()
    await expect.poll(() => reader.locator('.dsh-pdf-bookmark-row').count()).toBe(0)
    await reader.locator('.dsh-pdf-toolbar-undo').click()
    await reader.locator('.dsh-pdf-bookmark-link').filter({ hasText: 'Opening chapter' }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
  } finally { await opened?.close(); await scaffold.close() }
}, 90_000)

it('edits recoverable imported bookmarks and creates children without a read-only fallback', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let opened: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-outline-recovery-e2e')
    await workspace.attachSession(sessionId)
    const title = 'PDF imported outline recovery test'
    await scaffold.ctx.sessionController.rename({ sessionId, title })
    const path = join(scaffold.workspaceCwd, FILE_NAME)
    const source = await recoverableOutlineFixture()
    await writeFile(path, source)
    opened = await browser()
    const page = await newEnglishPage(opened)
    const tripwire = watchConsole(page)
    let reader = await openReader(page, scaffold.authenticatedUrl, title)
    await reader.getByRole('tab', { name: 'Bookmarks', exact: true }).click()
    const more = (name: string) => reader.getByRole('button', { name: `More bookmark actions: ${name}`, exact: true })
    await more('Imported chapter').waitFor()
    expect(await reader.getByRole('button', { name: 'Add PDF bookmark', exact: true }).isEnabled()).toBe(true)
    expect(await reader.locator('.dsh-pdf-bookmark-panel').textContent()).not.toMatch(/inconsistent|missing.*forward tree/)
    expect(new Uint8Array(await readFile(path))).toEqual(source)
    await more('Imported chapter').click()
    await reader.getByRole('menuitem', { name: 'Rename bookmark', exact: false }).click()
    let form = reader.getByRole('form', { name: 'Rename bookmark', exact: true })
    await form.getByRole('textbox').fill('Recovered chapter')
    await form.getByRole('textbox').press('Enter')
    await more('Recovered chapter').waitFor()
    const save = reader.locator('.dsh-pdf-toolbar-save')
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(async () => (await loadPdfDocument(await readFile(path))).outline?.[0]?.title).toBe('Recovered chapter')
    await expect.poll(() => save.isDisabled()).toBe(true)

    await more('Recovered chapter').click()
    await reader.getByRole('menuitem', { name: 'Add child bookmark', exact: true }).click()
    form = reader.getByRole('form', { name: 'Add PDF bookmark', exact: true })
    await expect.poll(() => form.getByRole('textbox').evaluate(element => element === document.activeElement)).toBe(true)
    await form.getByRole('textbox').fill('New nested bookmark')
    await form.getByRole('textbox').press('Enter')
    await more('New nested bookmark').waitFor()
    expect(await reader.locator('.dsh-pdf-bookmark-row').filter({ hasText: 'New nested bookmark' }).getAttribute('aria-level')).toBe('2')
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(async () => (await loadPdfDocument(await readFile(path))).outline?.[0]?.children.map(item => item.title))
      .toEqual(['Imported section', 'New nested bookmark'])
    await expect.poll(() => save.isDisabled()).toBe(true)
    const saved = await loadPdfDocument(await readFile(path))
    expect(saved.outlineReadOnlyReason).toBeUndefined()
    expect(saved.outline![0].children.map(item => item.title)).toEqual(['Imported section', 'New nested bookmark'])
    reader = await openReader(page, scaffold.authenticatedUrl, title)
    await reader.getByRole('tab', { name: 'Bookmarks', exact: true }).click()
    await more('Recovered chapter').waitFor()
    if (!await more('New nested bookmark').isVisible()) await reader.getByRole('button', { name: 'Expand bookmark section', exact: true }).click()
    await more('New nested bookmark').waitFor()
    if (process.env.PDF_OUTLINE_RECOVERY_SCREENSHOT) await page.screenshot({ path: process.env.PDF_OUTLINE_RECOVERY_SCREENSHOT })
    expect(tripwire.pageErrors).toEqual([])
  } finally { await opened?.close(); await scaffold.close() }
}, 90_000)

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

    await reader.getByRole('tab', { name: 'Annotations', exact: true }).click()
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
    const zoom = reader.locator('.dsh-pdf-toolbar-zoom')
    await zoom.locator('summary').click()
    await zoom.locator('.dsh-pdf-zoom-menu').getByRole('button', { name: '100%' }).click()
    const scroller = reader.locator('.dsh-pdf-scroll')
    await expect.poll(() => scroller.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(200)
    await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200)
    const vertical = reader.locator('.dsh-pdf-content').getByRole('scrollbar', { name: 'Vertical scrollbar' })
    const horizontal = reader.locator('.dsh-pdf-content').getByRole('scrollbar', { name: 'Horizontal scrollbar' })
    const [bodyBounds, contentBounds, sidebarBounds, scrollBounds, verticalBounds] = await Promise.all([
      reader.locator('.dsh-pdf-body').boundingBox(), reader.locator('.dsh-pdf-content').boundingBox(),
      sidebar.boundingBox(), scroller.boundingBox(), vertical.boundingBox(),
    ])
    expect(bodyBounds).not.toBeNull()
    expect(contentBounds).not.toBeNull()
    expect(sidebarBounds).not.toBeNull()
    expect(scrollBounds).not.toBeNull()
    expect(verticalBounds).not.toBeNull()
    expect(await sidebar.evaluate(element => getComputedStyle(element).position)).toBe('absolute')
    expect(Math.abs(contentBounds!.width - bodyBounds!.width)).toBeLessThanOrEqual(1)
    expect(sidebarBounds!.x).toBeGreaterThan(contentBounds!.x)
    expect(sidebarBounds!.x + sidebarBounds!.width).toBeLessThan(contentBounds!.x + contentBounds!.width)
    expect(Math.abs(verticalBounds!.x - scrollBounds!.x - 2)).toBeLessThanOrEqual(1)
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

it('shows a real selected-word translation and handles screenshot preview copy and cancellation', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] },
    replayFixture: MODEL_FIXTURE, replayProvidersOnly: true })
  let opened: Browser | undefined
  let response: string = JSON.stringify({ recognized: true, pronunciation: '/ˈkʌvərɪdʒ/', meanings: [
    { partOfSpeech: 'noun', meaning: 'scope', example: 'Coverage is broad.', exampleTranslation: '覆盖范围很广。' },
  ] })
  let responseGate: Promise<void> | undefined
  let releaseResponse = () => {}
  let pendingResponseSignal: AbortSignal | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-panel-translation-e2e')
    await workspace.attachSession(sessionId)
    const title = 'PDF panel translation test'
    await scaffold.ctx.sessionController.rename({ sessionId, title })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await documentBytes())
    await scaffold.ctx.sessionController.selectModel({ sessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    const llm = scaffold.ctx.get('llm') as DshTranslationLlm | undefined
    if (!llm) throw new Error('The Web profile has no model runtime')
    llm.stream = async function* (options) {
      if (responseGate) {
        pendingResponseSignal = options.signal
        await responseGate
        options.signal.throwIfAborted()
      }
      yield { type: 'text-delta', index: 0, text: response }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    opened = await browser()
    const page = await newEnglishPage(opened)
    const tripwire = watchConsole(page)
    const reader = await openReader(page, scaffold.authenticatedUrl, title)
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents()).toContain('Coverage page 1')
    await reader.evaluate(element => {
      const glyphs = [...element.querySelectorAll<HTMLElement>('[data-pdf-page="1"] span[data-pdf-run]')]
      const word = glyphs.slice(0, 8)
      if (word.map(item => item.textContent).join('') !== 'Coverage') throw new Error('Unexpected PDF text layer')
      const range = document.createRange()
      range.setStart(word[0]!.firstChild!, 0)
      range.setEnd(word.at(-1)!.firstChild!, 1)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      element.querySelector<HTMLElement>('.dsh-pdf-scroll')!.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
    })
    const selected = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await selected.waitFor({ state: 'visible' })
    await selected.getByRole('button', { name: 'Translate', exact: true }).click()
    const panel = reader.locator('.dsh-pdf-translation-panel')
    await panel.waitFor({ state: 'visible' })
    await expect.poll(() => panel.locator('.dsh-pdf-translation-details').count()).toBe(1)
    expect(await panel.innerText()).toContain('Coverage is broad.')
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => { (window as typeof window & { __copiedTranslation?: string }).__copiedTranslation = text },
      } })
    })
    await panel.locator('.dsh-pdf-translation-result-header > button').first().click()
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __copiedTranslation?: string }).__copiedTranslation))
      .toContain('Coverage is broad.')
    await expect.poll(() => panel.locator('.dsh-pdf-translation-status').innerText()).toContain('copied')
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('clipboard denied') } },
    }))
    await expect.poll(() => panel.locator('.dsh-pdf-translation-result-header').evaluate(root => {
      const language = root.querySelector<HTMLElement>('.dsh-pdf-translation-language-trigger')!
      const button = root.querySelector<HTMLElement>(':scope > button')!
      return language.getBoundingClientRect().right <= button.getBoundingClientRect().left
        || language.getBoundingClientRect().bottom <= button.getBoundingClientRect().top
    })).toBe(true)
    await panel.locator('.dsh-pdf-translation-result-header > button').first().click()
    await panel.locator('.dsh-pdf-translation-copy-error').waitFor({ state: 'visible' })
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} }))
    await panel.locator('.dsh-pdf-translation-result-header > button').first().click()
    await expect.poll(() => panel.locator('.dsh-pdf-translation-copy-error').innerText()).toContain('unavailable')
    response = JSON.stringify({ recognized: false })
    // Keep the request pending until Cancel is clicked, including under V8
    // coverage where browser actionability checks can exceed a short timer.
    responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    const language = panel.locator('.dsh-pdf-translation-language-trigger')
    await language.click()
    await panel.locator('.dsh-pdf-translation-language-menu').getByRole('button', { name: 'French' }).click()
    await expect.poll(() => pendingResponseSignal !== undefined).toBe(true)
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => panel.locator('.dsh-pdf-translation-status').innerText()).toContain('cancelled')
    await expect.poll(() => pendingResponseSignal?.aborted).toBe(true)
    releaseResponse()
    responseGate = undefined
    await panel.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => panel.getByRole('alert').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('clearer')]))
    await panel.locator('.dsh-pdf-translation-language-trigger').focus()
    await page.keyboard.press('Escape')
    await panel.locator('.dsh-pdf-translation-content').waitFor({ state: 'detached' })

    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Region screenshot', exact: true }).click()
    await reader.locator('.dsh-pdf-mode-region').first().waitFor({ state: 'visible' })
    const box = (await reader.locator('[data-pdf-page="1"]').boundingBox())!
    await page.mouse.move(box.x + 120, box.y + 120)
    await page.mouse.down()
    await page.mouse.move(box.x + 320, box.y + 250, { steps: 8 })
    await page.mouse.up()
    const dialog = reader.getByRole('dialog', { name: 'Screenshot preview' })
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })
    await dialog.getByRole('img').waitFor({ state: 'visible' })
    const close = dialog.getByRole('button', { name: 'Close', exact: true })
    await close.focus()
    await close.press('Shift+Tab')
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement)
      && document.activeElement !== element.querySelector('button'))).toBe(true)
    await page.keyboard.press('Tab')
    await expect.poll(() => close.evaluate(element => element === document.activeElement)).toBe(true)
    const copy = dialog.locator('.dsh-pdf-screenshot-actions button').first()
    await copy.click()
    await expect.poll(async () => (await dialog.getByRole('alert').count())
      + (await dialog.locator('.dsh-pdf-screenshot-status').allTextContents()).filter(text => text.trim()).length)
      .toBeGreaterThan(0)
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async (_items: ClipboardItem[]) => { (window as typeof window & { __copiedImage?: boolean }).__copiedImage = true },
    } }))
    await copy.click()
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __copiedImage?: boolean }).__copiedImage)).toBe(true)
    await expect.poll(() => dialog.locator('.dsh-pdf-screenshot-status').innerText()).toContain('Image copied')
    const recognize = dialog.getByRole('button', { name: 'Recognize region' })
    await recognize.waitFor({ state: 'visible' })
    response = 'Panel OCR completed.'
    await recognize.click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => reader.locator('.dsh-pdf-ocr-transcript').textContent()).toContain('Panel OCR completed.')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    releaseResponse()
    await opened?.close()
    await scaffold.close()
  }
}, 90_000)
