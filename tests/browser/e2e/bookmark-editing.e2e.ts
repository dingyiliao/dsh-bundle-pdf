import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, newEnglishPage, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchPdfBrowser as browser } from '../launch.ts'
import { loadPdfDocument } from '../../../src/adapters/host/pdf-lib/pdf-document.ts'
import { recoverableOutlineFixture } from '../../fixtures/recoverable-outline.ts'
import { FILE_NAME, documentBytes, openReader } from '../support/panels.ts'
import { openSidebarSection } from '../support/toolbar.ts'

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
    await openSidebarSection(reader, 'Bookmarks')

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
    await openSidebarSection(reader, 'Bookmarks')
    await reader.getByRole('button', { name: 'More bookmark actions: Opening chapter', exact: true }).click()
    await reader.getByRole('menuitem', { name: 'Delete bookmark', exact: true }).click()
    await reader.getByRole('dialog', { name: 'Delete PDF bookmark', exact: true }).getByRole('button', { name: 'Delete?', exact: true }).click()
    await expect.poll(() => reader.locator('.dsh-pdf-bookmark-row').count()).toBe(0)
    await reader.locator('.dsh-pdf-tool-history .dsh-pdf-toolbar-undo').click()
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
    await openSidebarSection(reader, 'Bookmarks')
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
    await openSidebarSection(reader, 'Bookmarks')
    await more('Recovered chapter').waitFor()
    if (!await more('New nested bookmark').isVisible()) await reader.getByRole('button', { name: 'Expand bookmark section', exact: true }).click()
    await more('New nested bookmark').waitFor()
    if (process.env.PDF_OUTLINE_RECOVERY_SCREENSHOT) await page.screenshot({ path: process.env.PDF_OUTLINE_RECOVERY_SCREENSHOT })
    expect(tripwire.pageErrors).toEqual([])
  } finally { await opened?.close(); await scaffold.close() }
}, 90_000)
