import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, newEnglishPage, saveFailureShot, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser, type Locator } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'

it('opens a password-protected PDF through the Reader tab and renders it read-only', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-password-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'Protected PDF test' })
    const name = 'protected-e2e.pdf'
    const bytes = await readFile(new URL('../../fixtures/password-object-stream.pdf', import.meta.url))
    await writeFile(join(scaffold.workspaceCwd, name), bytes)

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-password-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'Protected PDF test' }).click()
    const expand = page.locator('[data-sidebar-right-expand]')
    if (await expand.isVisible()) await expand.click()
    const column = page.locator('[data-rightbar-col]')
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    const prompt = reader.getByRole('form', { name: 'Unlock PDF' })
    const password = prompt.getByLabel('Password')
    const unlock = prompt.getByRole('button', { name: 'Unlock', exact: true })
    await password.fill('incorrect-fixture-password')
    await unlock.click()
    await prompt.getByRole('alert').filter({ hasText: 'Incorrect password' }).waitFor({ state: 'visible' })
    expect(await password.inputValue()).toBe('')
    expect(await reader.locator('[data-pdf-page] canvas').count()).toBe(0)

    await password.fill('fixture-password')
    await unlock.click()
    await reader.locator('[data-pdf-page] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
    await prompt.waitFor({ state: 'detached' })
    await reader.getByText('This PDF is encrypted and opens for reading only.', { exact: false }).waitFor({ state: 'visible' })
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('resumes the remembered reading position on a fresh client and skips it after an external change', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  let releaseInitialLookup: (() => void) | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-resume-position-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF resume position test' })
    const name = 'reader-resume-position-e2e.pdf'
    const path = join(scaffold.workspaceCwd, name)
    const document = await PDFDocument.create()
    const font = await document.embedFont(StandardFonts.Helvetica)
    for (const label of ['Probe page one', 'Probe page two', 'Probe page three', 'Probe page four']) {
      document.addPage([400, 560]).drawText(label, { x: 50, y: 490, size: 18, font })
    }
    await writeFile(path, await document.save({ useObjectStreams: false }))

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    // Hold the first Host lookup until the user has navigated. A late resume
    // decision must not interrupt that newer, explicit navigation.
    let lookupStarted = false
    const initialLookup = new Promise<void>(resolve => { releaseInitialLookup = resolve })
    await page.route('**/api/pdf.position', async route => {
      if (!lookupStarted && route.request().postDataJSON()?.payload?.action === 'get') {
        lookupStarted = true
        await initialLookup
      }
      await route.continue()
    })
    onTestFailed(() => saveFailureShot(page, 'pdf-resume-position-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF resume position test' }).click()

    const pageField = (reader: Locator) => reader.locator('.dsh-pdf-sidebar-compact-nav .dsh-pdf-page-input')
    const openReader = async () => {
      const reader = page.locator('.dsh-pdf-reader')
      // A reload restores the open document itself; only the first open walks
      // the right-bar file tree.
      if (!await reader.isVisible()) {
        const expand = page.locator('[data-sidebar-right-expand]')
        if (await expand.isVisible()) await expand.click()
        const column = page.locator('[data-rightbar-col]')
        await column.locator('[data-sidebar-right-guide-entry="files"]').click()
        await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
        await column.locator('[data-files-reload]').click()
        await column.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
      }
      await reader.waitFor({ state: 'visible', timeout: 20_000 })
      // Not page one specifically: a resumed reader opens elsewhere.
      await reader.locator('[data-pdf-page] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
      // The narrow reader auto-collapses its sidebar; use the control for the
      // current layout instead of expanding it only to race the auto-collapse.
      await pageField(reader).waitFor({ state: 'visible', timeout: 10_000 })
      return reader
    }
    /** The page the reader reports through its own navigation field. */
    const reportedPage = async (reader: Locator) => await pageField(reader).inputValue()

    await page.waitForTimeout(500)
    let reader = await openReader()
    await expect.poll(() => lookupStarted).toBe(true)
    await expect.poll(() => reportedPage(reader), { timeout: 20_000 }).toBe('1')

    const field = pageField(reader)
    // Observe the write before Enter, but consume a timeout even if an earlier
    // assertion fails so it cannot escape as an unhandled rejection.
    const positionStored = page.waitForResponse(async response => {
      if (!response.url().endsWith('/api/pdf.position')) return false
      const payload = response.request().postDataJSON()?.payload
      if (payload?.action !== 'set' || payload.position?.page !== 3) return false
      return (await response.json()).result?.ok === true
    }, { timeout: 60_000 }).catch(() => null)
    await field.click()
    await expect.poll(() => field.evaluate(input => input === document.activeElement)).toBe(true)
    await field.fill('3')
    await expect.poll(() => field.inputValue()).toBe('3')
    // A passive scroll can update the observed current page while the user is
    // editing the destination. It must not replace the unfinished page number.
    await reader.locator('.dsh-pdf-scroll').evaluate(scroll => {
      const secondPage = scroll.querySelector<HTMLElement>('[data-page-number="2"]')
      if (!secondPage) throw new Error('The second PDF page has not mounted')
      scroll.scrollTop = secondPage.offsetTop
      scroll.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => field.getAttribute('title')).toBe('2 / 4')
    expect(await field.inputValue()).toBe('3')
    await field.press('Enter')
    const resumeState = async () => ({
      page: await reportedPage(reader),
      activeText: (await reader.locator('[data-pdf-text="active"]').allTextContents()).join(' '),
    })
    await expect.poll(resumeState, { timeout: 60_000 }).toMatchObject({ page: '3', activeText: expect.stringContaining('Probe page three') })
    releaseInitialLookup()
    releaseInitialLookup = undefined
    // Wait for the Host to acknowledge the throttled durable write. A visible
    // page number alone can still be an unsaved input draft.
    expect(await positionStored).not.toBeNull()

    // A full client reload discards the in-memory tab position, so only the
    // position remembered by the Host can bring this reader back to page three.
    await page.reload({ waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF resume position test' }).click()
    reader = await openReader()
    await expect.poll(() => reportedPage(reader), { timeout: 20_000 }).toBe('3')
    expect((await reader.locator('[data-pdf-text="active"]').allTextContents()).join(' ')).toContain('Probe page three')

    // An external rewrite keeps page three but changes the bytes, so the
    // remembered position must be reported rather than replayed.
    const rewritten = await PDFDocument.create()
    const otherFont = await rewritten.embedFont(StandardFonts.Helvetica)
    for (const label of ['Rewritten one', 'Rewritten two', 'Rewritten three', 'Rewritten four']) {
      rewritten.addPage([420, 580]).drawText(label, { x: 50, y: 500, size: 18, font: otherFont })
    }
    await writeFile(path, await rewritten.save({ useObjectStreams: false }))

    await page.reload({ waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF resume position test' }).click()
    reader = await openReader()
    await expect.poll(() => reportedPage(reader), { timeout: 20_000 }).toBe('1')
    await expect.poll(async () => (await reader.locator('.dsh-pdf-notice[role="status"]').allTextContents()).join(' '))
      .toContain('changed on disk')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    releaseInitialLookup?.()
    await browser?.close()
    await scaffold.close()
  }
}, 240_000)
