import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, newEnglishPage, openSettings, saveFailureShot, ROOT } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { type Context } from '@deepseek-ai/cordis'

it('persists a valid setting when Escape closes the editor before its typing debounce', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    browser = await launchBrowser()
    const page = await newEnglishPage(browser), tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-settings-close-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached' })
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    await settings.getByRole('spinbutton', { name: 'Navigation history capacity' }).fill('77')
    // No blur, submit, or debounce wait: leaving the view must flush its intent.
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'pdf-reader')?.value)
      .toMatchObject({ historyCapacity: 77 })
    await openSettings(page, 'en')
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    await expect.poll(() => settings.getByRole('spinbutton', { name: 'Navigation history capacity' }).inputValue()).toBe('77')
    expect(tripwire.pageErrors).toEqual([])
  } finally { await browser?.close(); await scaffold.close() }
})

it('updates engine settings live when a contributor plugin loads and unloads, retaining missing selections', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  let contributor: { dispose(): unknown } | undefined
  try {
    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-engine-directory-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached' })
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    const pdfSettings = settings.locator('.dsh-pdf-settings')
    expect(await pdfSettings.getByRole('heading', { level: 3 }).allTextContents())
      .toEqual(['Reading and navigation', 'Explanation prompts'])
    expect(await pdfSettings.getByText('Engines run on demand.', { exact: false }).count()).toBe(1)
    expect(await pdfSettings.locator('textarea').count()).toBe(3)
    const rebuildIndex = settings.getByRole('button', { name: 'Clear all index caches', exact: true })
    await rebuildIndex.click()
    await settings.getByText('Index cache cleared. Indexes rebuild in the background or when searched.', { exact: true }).waitFor()
    const embedding = settings.getByRole('combobox', { name: 'Semantic search engine', exact: true })
    await embedding.selectOption('local-qwen3-embedding')
    expect(await settings.getByRole('textbox', { name: 'Model revision', exact: true }).count()).toBe(0)
    expect(await embedding.locator('..').locator('.dsh-pdf-settings-engine-kind').textContent()).toBe('Service')
    await expect.poll(() => settings.locator('.dsh-pdf-settings-save-status').textContent()).toMatch(/^Settings are up to date/)
    await embedding.selectOption('none')
    if (process.env.PDF_SETTINGS_SCREENSHOT) await settings.screenshot({ path: process.env.PDF_SETTINGS_SCREENSHOT })
    const ocr = settings.getByRole('combobox', { name: 'OCR engine', exact: true })
    const image = settings.getByRole('combobox', { name: 'Image understanding engine', exact: true })
    const translation = settings.getByRole('combobox', { name: 'Translation engine', exact: true })
    await expect.poll(() => ocr.inputValue()).toBe('local-tesseract')
    await expect.poll(() => image.inputValue()).toBe('dsh-vision')
    contributor = scaffold.ctx.plugin({ inject: ['ocr', 'imageUnderstanding', 'pdfTranslation'], apply(ctx: Context) {
      ctx.effect(() => ctx.ocr.register({ descriptor: { id: 'fixture.ocr', name: 'Fixture local OCR', version: '1',
        execution: 'local', geometry: [], confidence: false,
        configurationFields: [{ key: 'language', label: 'Fixture language', type: 'string', required: true },
          { key: 'accuracy', label: 'Fixture accuracy', type: 'number' },
          { key: 'enabled', label: 'Fixture enabled', type: 'boolean' },
          { key: 'credential', label: 'Fixture credential reference', type: 'secret-reference' }] },
        async availability() { return { status: 'available' } },
        async recognize() { return { text: 'Fixture', blocks: [], lines: [], words: [], confidence: null,
          status: 'complete', coverage: [], warnings: [] } } }))
      ctx.effect(() => ctx.imageUnderstanding.register({
        descriptor: { id: 'fixture.image', name: 'Fixture image engine', version: '1', execution: 'local' },
        async availability() { return { available: true } },
        async understand() { return { text: 'Fixture image' } } }))
      ctx.effect(() => ctx.pdfTranslation.register({ descriptor: { id: 'fixture.translation', name: 'Fixture translator',
        version: '1', execution: 'local' }, async translate() { return { text: 'Fixture translation', status: 'complete', warnings: [] } } }))
    } })
    await expect.poll(() => ocr.locator('option[value="fixture.ocr"]').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => image.locator('option[value="fixture.image"]').count()).toBe(1)
    await expect.poll(() => translation.locator('option[value="fixture.translation"]').count()).toBe(1)
    await ocr.selectOption('fixture.ocr')
    expect(await ocr.locator('..').locator('.dsh-pdf-settings-engine-kind').textContent()).toBe('Local')
    await settings.getByRole('textbox', { name: 'Fixture language' }).fill('eng')
    await settings.getByRole('spinbutton', { name: 'Fixture accuracy' }).fill('2')
    await settings.getByRole('spinbutton', { name: 'Fixture accuracy' }).fill('')
    await settings.getByRole('spinbutton', { name: 'Fixture accuracy' }).fill('3')
    await settings.getByRole('checkbox', { name: 'Fixture enabled' }).check()
    await settings.getByRole('textbox', { name: 'Fixture credential reference' }).fill('fixture.credential')
    await image.selectOption('fixture.image')
    await translation.selectOption('fixture.translation')
    await settings.getByRole('textbox', { name: 'Fixture credential reference' }).blur()
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'pdf-reader')?.value).toMatchObject({
      ocrEngine: 'fixture.ocr', imageEngine: 'fixture.image', translationEngine: 'fixture.translation',
      engineConfigurations: { ocr: { 'fixture.ocr': { language: 'eng', accuracy: 3, enabled: true, credential: 'fixture.credential' } } },
    })
    await expect.poll(() => settings.locator('.dsh-pdf-settings-save-status').textContent()).toMatch(/^Settings are up to date/)
    await contributor.dispose()
    contributor = undefined
    await expect.poll(() => ocr.locator('option[value="fixture.ocr"]').isDisabled(), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => image.locator('option[value="fixture.image"]').isDisabled()).toBe(true)
    await expect.poll(() => translation.locator('option[value="fixture.translation"]').isDisabled()).toBe(true)
    expect(await ocr.inputValue()).toBe('fixture.ocr')
    expect(await image.inputValue()).toBe('fixture.image')
    expect(await translation.inputValue()).toBe('fixture.translation')
    expect(await settings.getByRole('textbox', { name: 'Fixture language' }).count()).toBe(0)
    // Missing providers must not block unrelated settings edits or force fallback.
    await settings.getByRole('spinbutton', { name: 'Navigation history capacity' }).fill('91')
    await settings.getByRole('spinbutton', { name: 'Navigation history capacity' }).blur()
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'pdf-reader')?.value).toMatchObject({ historyCapacity: 91 })
    await expect.poll(() => settings.locator('.dsh-pdf-settings-save-status').textContent()).toMatch(/^Settings are up to date/)
    expect(await ocr.inputValue()).toBe('fixture.ocr')
    expect(tripwire.pageErrors).toEqual([])
    await page.setViewportSize({ width: 640, height: 900 })
    const overflows = await pdfSettings.evaluate(element => [...element.querySelectorAll('select, input, textarea')]
      .some(control => control.getBoundingClientRect().right > element.getBoundingClientRect().right + 1))
    expect(overflows).toBe(false)
    if (process.env.PDF_SETTINGS_SCREENSHOT) {
      await pdfSettings.getByRole('heading', { name: 'PDF', exact: true }).scrollIntoViewIfNeeded()
      await settings.screenshot({ path: process.env.PDF_SETTINGS_SCREENSHOT.replace(/\.png$/, '-narrow.png') })
      await pdfSettings.getByRole('textbox', { name: 'Image regions', exact: true }).scrollIntoViewIfNeeded()
      await settings.screenshot({ path: process.env.PDF_SETTINGS_SCREENSHOT.replace(/\.png$/, '-prompts.png') })
    }
  } finally { await contributor?.dispose(); await browser?.close(); await scaffold.close() }
})
