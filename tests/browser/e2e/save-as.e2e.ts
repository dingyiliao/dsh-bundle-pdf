import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, newEnglishPage, saveFailureShot, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { FILE_NAME, NOTE, outlinedSourcePdf, savedNoteContents, sourcePdf } from '../support/documents.ts'
import { documentAction } from '../support/toolbar.ts'

it('uses the official desktop directory picker in the Save As sheet and clears a single stale-save conflict after discard', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-save-as-conflict-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF Save As test' })
    const sourcePath = join(scaffold.workspaceCwd, FILE_NAME)
    const copyPath = join(scaffold.workspaceCwd, 'reader-save-as-e2e.pdf')
    const original = await sourcePdf()
    await writeFile(sourcePath, original)

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-save-as-conflict-browser'))
    await page.addInitScript(() => {
      const owner = window as typeof window & { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> };
        __pdfPickerNextDirectory?: string | null; __pdfPickerCalls?: number }
      owner.__pdfPickerCalls = 0
      owner.__pdfPickerNextDirectory = null
      owner.__DSH_DIRECTORY_PICKER__ = {
        async pick() {
          owner.__pdfPickerCalls!++
          return owner.__pdfPickerNextDirectory ?? null
        },
      }
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF Save As test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 10_000 })
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const save = toolbar.getByRole('button', { name: 'Save', exact: true })
    const note = toolbar.getByRole('button', { name: 'Note', exact: true })
    await note.click()
    await expect.poll(() => note.getAttribute('aria-pressed')).toBe('true')
    await reader.locator('[data-pdf-page="1"].dsh-pdf-mode-note').click({ position: { x: 120, y: 140 } })
    const commentCard = reader.locator('.dsh-pdf-page-comment-card')
    await commentCard.getByRole('textbox', { name: 'Note' }).fill(NOTE)
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => save.isEnabled()).toBe(true)

    const clickToolbarAction = async (name: string) => {
      await (await documentAction(reader, name)).click()
    }
    await clickToolbarAction('Save as')
    const saveSheet = reader.getByRole('dialog', { name: 'Save a PDF copy', exact: true })
    const copyName = saveSheet.getByRole('textbox', { name: 'File name', exact: true })
    expect(await copyName.inputValue()).toBe(FILE_NAME.replace(/\.pdf$/i, '-annotated.pdf'))
    expect(await copyName.evaluate(input => ({ focused: document.activeElement === input,
      start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd })))
      .toEqual({ focused: true, start: 0, end: FILE_NAME.replace(/\.pdf$/i, '-annotated').length })
    // Exercise keyboard isolation through the shipped Client, not just the
    // standalone layout fixture. Cancelling must leave the shared draft dirty.
    const saveCopy = saveSheet.getByRole('button', { name: 'Save copy', exact: true })
    await expect.poll(() => saveCopy.isEnabled()).toBe(true)
    await saveCopy.focus(); await saveCopy.press('Tab')
    expect(await copyName.evaluate(element => element === document.activeElement)).toBe(true)
    await copyName.press('Shift+Tab')
    expect(await saveCopy.evaluate(element => element === document.activeElement)).toBe(true)
    await saveCopy.press('Escape')
    await saveSheet.waitFor({ state: 'detached' })
    expect(await save.isEnabled()).toBe(true)
    expect(await savedNoteContents(sourcePath)).toEqual([])
    await clickToolbarAction('Save as')
    await saveSheet.waitFor({ state: 'visible' })
    // Cancelling the native directory chooser keeps the user's sheet and draft.
    await saveSheet.getByRole('button', { name: 'Change location…', exact: true }).click()
    await expect.poll(() => saveSheet.getByRole('button', { name: 'Change location…', exact: true }).isEnabled()).toBe(true)
    expect(await copyName.inputValue()).toBe(FILE_NAME.replace(/\.pdf$/i, '-annotated.pdf'))
    await page.evaluate(path => {
      (window as typeof window & { __pdfPickerNextDirectory?: string | null }).__pdfPickerNextDirectory = path
    }, dirname(copyPath))
    await saveSheet.getByRole('button', { name: 'Change location…', exact: true }).click()
    await expect.poll(() => copyName.isEnabled()).toBe(true)
    await copyName.fill('reader-save-as-e2e.pdf')
    await saveSheet.getByText('A new PDF file will be created.', { exact: true }).waitFor()
    const sourceFrame = await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().elementHandle()
    expect(sourceFrame).not.toBeNull()
    await saveSheet.getByRole('button', { name: 'Save copy', exact: true }).click()
    // Save As replaces the reader tab, so a transient status from the old
    // reader is not a stable way to identify the new resource.
    await expect.poll(() => savedNoteContents(copyPath)).toEqual([NOTE])
    await column.getByRole('tab', { selected: true }).filter({ hasText: 'reader-save-as-e2e.pdf' }).waitFor({ state: 'visible' })
    await expect.poll(() => column.locator('[data-textpreview-path]:visible').getAttribute('title')).toBe(copyPath)
    // The path changes before the replacement Reader opens its native content.
    // Its first complete frame retires the old resource's retained canvas.
    await expect.poll(() => sourceFrame!.evaluate(canvas => canvas.isConnected)).toBe(false)
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible' })
    await expect.poll(() => save.getAttribute('data-save-state')).toMatch(/^saved(?:-success)?$/)
    expect(await page.evaluate(() => (window as typeof window & { __pdfPickerCalls?: number }).__pdfPickerCalls)).toBe(2)

    await note.click()
    await expect.poll(() => note.getAttribute('aria-pressed')).toBe('true')
    await reader.locator('[data-pdf-page="1"].dsh-pdf-mode-note').click({ position: { x: 180, y: 210 } })
    await commentCard.getByRole('textbox', { name: 'Note' }).fill('Unsaved after Save As')
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => save.isEnabled()).toBe(true)
    await writeFile(copyPath, original)
    await save.click()
    const conflict = reader.locator('.dsh-pdf-notice').filter({ hasText: 'The source file changed outside this reader.' })
    await conflict.waitFor({ state: 'visible' })
    expect(await conflict.count()).toBe(1)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    const discard = await documentAction(reader, 'Discard all changes')
    await expect.poll(() => discard.isEnabled()).toBe(true)
    await discard.click()
    await conflict.waitFor({ state: 'hidden' })
    await expect.poll(() => reader.locator('.dsh-pdf-error').allTextContents()).toEqual([])
    await expect.poll(() => save.isDisabled()).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('checks a Web Save As target before overwrite and rejects a changed target version', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-web-save-as-target-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF Web Save As target test' })
    const sourcePath = join(scaffold.workspaceCwd, FILE_NAME)
    const targetPath = join(scaffold.workspaceCwd, 'reader-existing-target-e2e.pdf')
    await writeFile(sourcePath, await sourcePdf())
    await writeFile(targetPath, await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-web-save-as-target-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF Web Save As target test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const note = toolbar.getByRole('button', { name: 'Note', exact: true })
    await note.click()
    await expect.poll(() => note.getAttribute('aria-pressed')).toBe('true')
    await reader.locator('[data-pdf-page="1"].dsh-pdf-mode-note').click({ position: { x: 120, y: 140 } })
    const commentCard = reader.locator('.dsh-pdf-page-comment-card')
    await commentCard.getByRole('textbox', { name: 'Note' }).fill(NOTE)
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => toolbar.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(true)

    await (await documentAction(reader, 'Save as')).click()
    const dialog = reader.locator('.dsh-pdf-save-as')
    await dialog.waitFor({ state: 'visible' })
    const name = dialog.getByRole('textbox', { name: 'File name', exact: true })
    const save = dialog.getByRole('button', { name: 'Save copy', exact: true })
    expect(await name.inputValue()).toBe(FILE_NAME.replace(/\.pdf$/i, '-annotated.pdf'))
    await dialog.getByText('A new PDF file will be created.').waitFor({ state: 'visible' })
    await expect.poll(() => save.isEnabled()).toBe(true)
    // Browser fallback keeps the directory separate from the filename.
    await dialog.getByRole('button', { name: 'Change location…', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Save location', exact: true }).fill(dirname(targetPath))
    await name.fill('reader-existing-target-e2e.pdf')
    await dialog.getByText('This name is already in use. Saving will ask you to confirm replacement.')
      .waitFor({ state: 'visible' })
    await save.click()
    await dialog.getByRole('heading', { name: 'Replace existing PDF?' }).waitFor()
    // This write happens after inspectTarget and before Save, so the Host must
    // reject the stale observed version instead of overwriting another writer.
    const externallyUpdated = await outlinedSourcePdf()
    await writeFile(targetPath, externallyUpdated)
    await dialog.getByRole('button', { name: 'Replace and save', exact: true }).click()
    await reader.getByRole('alert').waitFor({ state: 'visible' })
    expect(await readFile(targetPath)).toEqual(Buffer.from(externallyUpdated))
    expect(await dialog.isVisible()).toBe(true)

    // A refused stale write re-inspects automatically without losing input.
    // The new target version still needs a new explicit replacement decision.
    await name.waitFor({ state: 'visible' })
    expect(await name.inputValue()).toBe('reader-existing-target-e2e.pdf')
    await dialog.getByText('This name is already in use. Saving will ask you to confirm replacement.')
      .waitFor({ state: 'visible' })
    await save.click()
    await dialog.getByRole('button', { name: 'Replace and save', exact: true }).click()
    await expect.poll(() => savedNoteContents(targetPath)).toEqual([NOTE])
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
