import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, newEnglishPage, saveFailureShot, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { inspectFixturePdf } from '../../fixtures/native-document.ts'
import { externalThreadPdf, uncommentedHighlightPdf } from '../support/documents.ts'
import { chooseZoom } from '../support/toolbar.ts'

it('edits a highlight comment on the PDF page and reopens it from its saved marker', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-page-comment-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF page comment test' })
    const filename = 'reader-page-comment-e2e.pdf'
    const path = join(scaffold.workspaceCwd, filename)
    await writeFile(path, await uncommentedHighlightPdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-page-comment-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF page comment test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: filename, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    const pdfPage = reader.locator('[data-pdf-page="1"]')
    await pdfPage.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await chooseZoom(reader, '100%')
    const marker = pdfPage.locator('.dsh-pdf-comment-marker')
    expect(await marker.count()).toBe(0)

    // The source highlight spans PDF y=485..510 on a 560-point page.
    await pdfPage.click({ position: { x: 100, y: 62 } })
    const card = reader.locator('.dsh-pdf-page-comment-card')
    const selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await selectedToolbar.waitFor({ state: 'visible' })
    expect(await card.isVisible()).toBe(false)
    await selectedToolbar.getByRole('button', { name: 'Comment' }).click()
    await card.waitFor({ state: 'visible' })
    await reader.locator('.dsh-pdf-comment-connector').waitFor({ state: 'visible' })
    expect(await reader.locator('.dsh-pdf-comments').getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    await expect.poll(() => selectedToolbar.getByRole('button', { name: 'Delete annotation' }).isVisible()).toBe(true)
    await card.getByRole('textbox', { name: 'Comment' }).fill('Explain this marked passage')
    await card.getByRole('button', { name: 'Save comment', exact: true }).click()
    await marker.first().waitFor({ state: 'visible' })
    await marker.first().locator('svg[data-icon=\"commentedMark\"]').waitFor({ state: 'visible' })
    const save = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
      .getByRole('button', { name: 'Save', exact: true })
    await expect.poll(() => save.isEnabled()).toBe(true)
    const unsavedCommentFrame = await pdfPage.locator('canvas[data-pdf-raster-ready="true"]').first().elementHandle()
    expect(unsavedCommentFrame).not.toBeNull()
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    // Disabled also means saving. Wait for the accepted revision and the
    // replacement native frame before reopening its rematerialized comment.
    await expect.poll(() => save.getAttribute('data-save-state')).toMatch(/^saved(?:-success)?$/)
    await expect.poll(() => unsavedCommentFrame!.evaluate(canvas => canvas.isConnected)).toBe(false)
    await pdfPage.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible' })
    await marker.first().waitFor({ state: 'visible' })

    await pdfPage.click({ position: { x: 340, y: 300 } })
    await card.waitFor({ state: 'hidden' })
    await marker.first().click()
    await card.waitFor({ state: 'visible' })
    expect(await selectedToolbar.isVisible()).toBe(true)
    const connector = reader.locator('.dsh-pdf-comment-connector')
    await connector.waitFor({ state: 'visible' })
    await expect.poll(() => card.getByText('Explain this marked passage', { exact: true }).count()).toBe(1)
    await expect.poll(() => card.getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    await card.getByRole('button', { name: 'Add comment' }).click()
    await card.getByRole('textbox', { name: 'Comment' }).fill('A second interpretation')
    await card.getByRole('button', { name: 'Save comment', exact: true }).click()
    await expect.poll(() => card.locator('.dsh-pdf-comment-message').count()).toBe(2)
    const second = card.locator('.dsh-pdf-comment-message').nth(1)
    expect(await second.getByText('A second interpretation', { exact: true }).count()).toBe(1)
    await second.getByRole('button', { name: /^Edit comment:/ }).click()
    await second.getByRole('textbox', { name: 'Comment' }).fill('A revised interpretation')
    await card.getByRole('button', { name: 'Save comment', exact: true }).click()
    await expect.poll(() => card.getByText('A revised interpretation', { exact: true }).count()).toBe(1)
    expect(await card.getByText('Explain this marked passage', { exact: true }).count()).toBe(1)
    await expect.poll(() => card.getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    const oldPath = await connector.locator(':scope > path').getAttribute('d')
    await chooseZoom(reader, '125%')
    await card.waitFor({ state: 'visible' })
    await expect.poll(() => connector.locator(':scope > path').getAttribute('d')).not.toBe(oldPath)
    await card.getByRole('button', { name: 'Close annotations' }).click()
    await card.waitFor({ state: 'hidden' })
    expect(await selectedToolbar.isVisible()).toBe(false)
    expect(await reader.locator('.dsh-pdf-annotation-outline').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('reads, edits, saves and reopens an external PDF /IRT comment thread', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-external-thread-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF external thread test' })
    const filename = 'reader-external-thread-e2e.pdf'
    await writeFile(join(scaffold.workspaceCwd, filename), await externalThreadPdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-external-thread-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF external thread test' }).click()
    const column = page.locator('[data-rightbar-col]')
    const openFile = async () => {
      const expand = page.locator('[data-sidebar-right-expand]')
      if (await expand.isVisible()) await expand.click()
      await column.locator('[data-sidebar-right-guide-entry="files"]').click()
      await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
      await column.locator('[data-files-reload]').click()
      await column.locator('[data-files-entry="file"]').getByRole('button', { name: filename, exact: true }).click()
    }
    await openFile()
    const reader = page.locator('.dsh-pdf-reader')
    const pdfPage = reader.locator('[data-pdf-page="1"]')
    await pdfPage.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await chooseZoom(reader, '100%')
    const card = reader.locator('.dsh-pdf-page-comment-card')
    const openThread = async () => {
      const marker = reader.locator('.dsh-pdf-comment-marker').first()
      if (await marker.count()) await marker.click()
      else await pdfPage.click({ position: { x: 100, y: 62 } })
      await card.waitFor({ state: 'visible' })
      await expect.poll(() => card.locator('.dsh-pdf-comment-message').count()).toBe(2)
    }
    await openThread()
    expect(await card.getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    expect(await card.locator('.dsh-pdf-comment-message').nth(0).innerText()).toContain('Alice')
    expect(await card.locator('.dsh-pdf-comment-message').nth(1).innerText()).toContain('Bob')
    expect(await card.locator('.dsh-pdf-comment-message time').count()).toBe(2)
    expect(await card.getByText('Alice asks about the method', { exact: true }).count()).toBe(1)
    expect(await card.getByText('Bob follows up', { exact: true }).count()).toBe(1)

    // Add one independent reply through the PDF /IRT writer.
    await card.getByRole('button', { name: 'Add comment' }).click()
    await card.getByRole('textbox', { name: 'Comment' }).fill('Local follow-up')
    await card.getByRole('button', { name: 'Save comment', exact: true }).click()
    await expect.poll(() => card.locator('.dsh-pdf-comment-message').count()).toBe(3)

    // Editing and deleting one message must not disturb its siblings.
    const nested = card.locator('.dsh-pdf-comment-message').nth(1)
    await nested.getByRole('button', { name: /^Edit comment:/ }).click()
    await nested.getByRole('textbox', { name: 'Comment' }).fill('Bob revised')
    await card.getByRole('button', { name: 'Save comment', exact: true }).click()
    await expect.poll(() => card.getByText('Bob revised', { exact: true }).count()).toBe(1)
    const added = card.locator('.dsh-pdf-comment-message').nth(2)
    await added.getByRole('button', { name: /^Delete comment:/ }).click()
    await expect.poll(() => card.locator('.dsh-pdf-comment-message').count()).toBe(2)

    const cardBeforeMove = await card.boundingBox()
    expect(cardBeforeMove).not.toBeNull()
    const moveHandle = card.getByRole('button', { name: /^Move comment card/ })
    const moveHandleBounds = await moveHandle.boundingBox()
    expect(moveHandleBounds).not.toBeNull()
    await page.mouse.move(moveHandleBounds!.x + moveHandleBounds!.width / 2, moveHandleBounds!.y + moveHandleBounds!.height / 2)
    await page.mouse.down()
    await page.mouse.move(moveHandleBounds!.x + moveHandleBounds!.width / 2 - 28,
      moveHandleBounds!.y + moveHandleBounds!.height / 2 + 18, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => card.getAttribute('data-moving')).toBe(null)
    const cardAfterMove = await card.boundingBox()
    expect(cardAfterMove).not.toBeNull()
    expect(cardAfterMove!.x).toBeLessThan(cardBeforeMove!.x - 15)
    expect(cardAfterMove!.y).toBeGreaterThan(cardBeforeMove!.y + 10)

    const save = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
      .getByRole('button', { name: 'Save', exact: true })
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    // Disabled also means "saving". Wait for the completed transaction before
    // reading the on-disk PDF or reloading the browser.
    await reader.locator('.dsh-pdf-activity-trigger.dsh-pdf-save-feedback[data-kind="saved"]')
      .waitFor({ state: 'visible' })
    await expect.poll(() => save.isDisabled()).toBe(true)

    const savedDocument = await inspectFixturePdf(await readFile(join(scaffold.workspaceCwd, filename)))
    const savedPosition = savedDocument.annotations.find(annotation => annotation.subtype === 'Highlight')?.commentPosition
    expect(savedPosition?.length).toBe(2)
    expect(savedPosition?.every(Number.isFinite)).toBe(true)

    // Reopen from disk: the external root, nested reply relation, edit and
    // deletion all survive a real saved-file round trip. A full client reload
    // discards every Client-side annotation draft; only the saved PDF remains.
    await page.reload({ waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF external thread test' }).click()
    if (!await reader.isVisible()) await openFile()
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await chooseZoom(reader, '100%')
    await openThread()
    // The native writer may clamp a card moved partly outside the page; the
    // saved position exists and the reopened thread must still be addressable.
    await card.waitFor({ state: 'visible' })
    await expect.poll(() => card.locator('.dsh-pdf-comment-message').count()).toBe(2)
    expect(await card.locator('.dsh-pdf-comment-message').count()).toBe(2)
    expect(await card.getByText('Alice asks about the method', { exact: true }).count()).toBe(1)
    expect(await card.getByText('Bob revised', { exact: true }).count()).toBe(1)
    expect(await card.getByText('Local follow-up', { exact: true }).count()).toBe(0)
    expect(await card.getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)
