import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, newEnglishPage, openSettings, saveFailureShot, MODEL_FIXTURE, MODEL_FIXTURE_AVAILABLE, ROOT, SESSION } from '../support/scaffold.ts'
import { join } from 'node:path'
import { type Browser } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { type SessionOcrLlm } from '../../../src/adapters/host/dsh/ocr-session-llm.ts'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { FILE_NAME, sourcePdf } from '../support/documents.ts'
import { openSidebarSection } from '../support/toolbar.ts'

it.skipIf(!MODEL_FIXTURE_AVAILABLE)('recognizes the current PDF page through Host OCR and searches its page-level transcript', async () => {
  const recognizedText = ['Quartz OCR proof on page one.', ...Array(80).fill('Additional recognized line.')].join('\n')
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: ROOT, enabled: true }] },
    replayFixture: MODEL_FIXTURE,
    replayProvidersOnly: true,
  })
  let browser: Browser | undefined
  const modelCalls: { provider: string; model: string; sessionId: string; mediaType?: string }[] = []
  let holdNextOcr = false
  let failNextOcr = false
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-ocr-transcript-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF OCR transcript test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())
    const selection = await scaffold.ctx.sessionController.selectModel({ sessionId,
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    expect(selection).toMatchObject({ selected: { model: 'deepseek-v4-flash-vision-exp' } })

    // Keep the actual browser, PDF RPC, native page render, OCR transport,
    // model-capability decision, and attachment store. Only the external model
    // stream is deterministic; no credential or recorded call is needed.
    const llm = scaffold.ctx.get('llm') as SessionOcrLlm | undefined
    if (!llm) throw new Error('The Web profile did not provide an LLM service')
    llm.stream = async function* (options) {
      const image = options.messages[0]?.content.find(part => part.type === 'image')
      modelCalls.push({ provider: options.provider, model: options.model,
        sessionId: options.sessionId, mediaType: image?.type === 'image' ? image.attachment.mediaType : undefined })
      if (holdNextOcr) {
        // Keep the real OCR RPC in flight until the reader's Cancel action
        // propagates its abort signal to the model boundary.
        await new Promise<void>(resolve => {
          if (options.signal.aborted) resolve()
          else options.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return
      }
      if (failNextOcr) {
        failNextOcr = false
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'fixture rate limit' } } }
        return
      }
      yield { type: 'text-delta', index: 0, text: recognizedText }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-ocr-transcript-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    // This scenario exercises the model backend, rather than the bundled local default.
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    await settings.getByRole('combobox', { name: 'OCR engine', exact: true }).selectOption('session-llm')
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'pdf-reader')?.value)
      .toMatchObject({ ocrEngine: 'session-llm' })
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    await page.getByRole('treeitem').filter({ hasText: 'PDF OCR transcript test' }).click()
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
    const recognizePage = toolbar.getByRole('button', { name: 'OCR page' })
    await expect.poll(() => recognizePage.isEnabled(), { timeout: 10_000 }).toBe(true)
    await recognizePage.click()
    await expect.poll(() => reader.locator('.dsh-pdf-ocr-transcript').textContent(), { timeout: 20_000 })
      .toBe(recognizedText)
    if (process.env.PDF_OCR_SCREENSHOT_PATH) {
      await reader.locator('.dsh-pdf-ocr-scroll > .dsh-pdf-panel-heading').waitFor({ state: 'visible' })
      await page.waitForTimeout(450)
      await reader.locator('.dsh-pdf-sidebar').screenshot({ path: process.env.PDF_OCR_SCREENSHOT_PATH })
    }
    const ocrScroll = reader.locator('.dsh-pdf-ocr-scroll > .dsh-pdf-panel-scroll')
    const ocrHeading = reader.locator('.dsh-pdf-ocr-scroll > .dsh-pdf-panel-heading')
    await ocrScroll.evaluate(element => { element.scrollTop = element.scrollHeight })
    expect(await ocrScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    const [headingBox, scrollBox] = await Promise.all([ocrHeading.boundingBox(), ocrScroll.boundingBox()])
    expect(scrollBox!.y).toBeGreaterThanOrEqual(headingBox!.y + headingBox!.height - 1)
    expect(modelCalls).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp',
      sessionId, mediaType: 'image/png' }])
    expect(await reader.locator('.dsh-pdf-ocr-meta').innerText()).toContain('Page 1')

    await openSidebarSection(reader, 'Search')
    const search = reader.locator('.dsh-pdf-search-panel')
    await search.getByRole('textbox', { name: 'Search' }).fill('Quartz OCR proof')
    await search.getByRole('button', { name: 'Search', exact: true }).click()
    const hit = search.locator('.dsh-pdf-search-hit')
    await expect.poll(() => hit.count(), { timeout: 10_000 }).toBe(1)
    expect(await hit.innerText()).toContain('OCR transcript · page-level match')
    expect(await hit.innerText()).toContain('Quartz OCR proof')
    await hit.click()
    holdNextOcr = true
    await recognizePage.click()
    await expect.poll(() => modelCalls.length).toBe(2)
    const ocrStatus = reader.locator('[data-status-id="ocr"]')
    await reader.locator('.dsh-pdf-activity-trigger').click()
    await ocrStatus.waitFor({ state: 'visible' })
    await ocrStatus.getByRole('button', { name: 'Cancel' }).click()
    await ocrStatus.waitFor({ state: 'hidden', timeout: 10_000 })
    expect(await reader.locator('.dsh-pdf-ocr-transcript').textContent()).toBe(recognizedText)
    holdNextOcr = false
    failNextOcr = true
    await recognizePage.click()
    const ocrError = reader.locator('.dsh-pdf-error[role="alert"]')
    await expect.poll(() => ocrError.textContent()).toContain('request or usage limit')
    expect(await reader.locator('.dsh-pdf-ocr-transcript').textContent()).toBe(recognizedText)
    await ocrError.getByRole('button', { name: 'Dismiss' }).click()
    await ocrError.waitFor({ state: 'hidden' })
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)
