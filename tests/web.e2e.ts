/** Keyless browser proof through the shipped Web profile, Loader and PDF workspace file. */
import { existsSync, realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode,
} from '../../deepseek-harness/apps/web/tests/scaffold.ts'
import { newEnglishPage, saveFailureShot } from '../../deepseek-harness/apps/web/tests/support.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_ROOT = join(ROOT, '..', 'deepseek-harness')
const SESSION = join(DSH_ROOT, 'snapshots', 'web', 'seeded-history', 'session.v3.jsonl')
const EXPECTED = join(ROOT, 'tests', 'expected', 'web-pdf')
const FILE_NAME = 'reader-e2e.pdf'
const LARGE_FILE_NAME = 'reader-many-pages-e2e.pdf'
const LARGE_PAGE_COUNT = 128
const NOTE = 'Saved through the PDF reader browser UI'

async function launchBrowser(): Promise<Browser> {
  if (process.env.PDF_BENCH_CHROMIUM) return chromium.launch({ executablePath: process.env.PDF_BENCH_CHROMIUM })
  if (process.platform !== 'win32' || existsSync(chromium.executablePath())) return chromium.launch()
  try { return await chromium.launch({ channel: 'chrome' }) }
  catch (error) {
    if (!/executable doesn't exist|distribution 'chrome' is not found/i.test(String(error))) throw error
    return chromium.launch({ channel: 'msedge' })
  }
}

/** A stable, editable two-page file that is independent of the plugin's PDF writer. */
async function sourcePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (const label of ['Browser PDF page one', 'Browser PDF page two']) {
    const page = document.addPage([400, 560])
    page.drawText(label, { x: 50, y: 490, size: 18, font })
  }
  return document.save({ useObjectStreams: false })
}

/** Keep the large fixture small on disk while exercising a distant page. */
async function manyPageSourcePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= LARGE_PAGE_COUNT; number++) {
    const page = document.addPage([400, 560])
    if (number === 1 || number === 2 || number === LARGE_PAGE_COUNT) {
      page.drawText(`Browser PDF page ${number}`, { x: 50, y: 490, size: 18, font })
    }
  }
  return document.save({ useObjectStreams: false })
}

/** Read the saved file with pdf-lib, separately from the Host's edit result. */
async function savedNoteContents(path: string): Promise<string[]> {
  const document = await PDFDocument.load(await readFile(path))
  const array = document.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  if (!array) return []
  const contents: string[] = []
  for (let index = 0; index < array.size(); index++) {
    const annotation = document.context.lookup(array.get(index), PDFDict)
    if (annotation.lookup(PDFName.of('Subtype'), PDFName).asString() !== '/Text') continue
    contents.push(annotation.lookup(PDFName.of('Contents'), PDFHexString).decodeText())
  }
  return contents
}

it('loads the installed PDF plugin and saves a browser-created note into the real PDF file', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.name === '@local/dsh-pdf')
    expect(entry?.fiber?.state).toBe(2)
    const profileRequire = createRequire(join(scaffold.harnessHome, 'profiles', 'scaffold', 'package.json'))
    expect(realpathSync(profileRequire.resolve('@local/dsh-pdf'))).toBe(realpathSync(join(ROOT, 'dist', 'index.js')))

    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-reader-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF browser test' })
    const path = join(scaffold.workspaceCwd, FILE_NAME)
    const original = await sourcePdf()
    await writeFile(path, original)

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF browser test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(async failure => {
      throw new Error(`${String(failure)}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page one')
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const save = toolbar.getByRole('button', { name: 'Save', exact: true })
    expect(await save.isDisabled()).toBe(true)
    await compareOrRefreshGolden(
      join(EXPECTED, 'opened-toolbar.expected.md'),
      await captureStableAria(page, '.dsh-pdf-toolbar-controls', scaffold.workspaceCwd),
      webSnapshotMode(),
    )

    // The desktop Mac shell uses this platform CSS and Electron app regions.
    // Chromium here verifies the selectable text layer and deferred selection
    // capture through the installed plugin; native macOS remains a separate check.
    await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin' })
    const textSpan = reader.locator('.dsh-pdf-text-layer span').filter({ hasText: 'Browser PDF page one' }).first()
    await textSpan.waitFor({ state: 'visible' })
    expect(await textSpan.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-user-select'))).toBe('text')
    expect(await reader.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
    const textBox = await textSpan.boundingBox()
    expect(textBox).not.toBeNull()
    await page.mouse.move(textBox!.x + 8, textBox!.y + textBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(textBox!.x + textBox!.width * 0.75, textBox!.y + textBox!.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toMatch(/rowser PDF pag/)
    const selectionToolbar = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await selectionToolbar.waitFor({ state: 'visible' })
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 8, y: 8 } })
    await selectionToolbar.waitFor({ state: 'hidden' })

    await toolbar.locator('summary').click()
    await toolbar.getByRole('button', { name: 'Note', exact: true }).click()
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 120, y: 140 } })
    const notePanel = reader.locator('.dsh-pdf-notes')
    await notePanel.getByRole('textbox', { name: 'Comment' }).fill(NOTE)
    await notePanel.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(() => save.isEnabled()).toBe(true).catch(async failure => {
      throw new Error(`${String(failure)}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
    await expect.poll(() => notePanel.locator('.dsh-pdf-comment-item').getByText(NOTE, { exact: true }).count()).toBe(1)
    await compareOrRefreshGolden(
      join(EXPECTED, 'dirty-toolbar.expected.md'),
      await captureStableAria(page, '.dsh-pdf-toolbar-controls', scaffold.workspaceCwd),
      webSnapshotMode(),
    )

    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(() => savedNoteContents(path)).toEqual([NOTE])
    expect(Buffer.from(await readFile(path)).equals(Buffer.from(original))).toBe(false)
    const savedNoteAria = await captureStableAria(page, '.dsh-pdf-notes', scaffold.workspaceCwd)
    expect(savedNoteAria).toMatch(/Created: \d{1,2}\/\d{1,2}\/\d{4}, \{\{clock\}\}/)
    await compareOrRefreshGolden(
      join(EXPECTED, 'saved-note.expected.md'),
      savedNoteAria.replace(/\d{1,2}\/\d{1,2}\/\d{4}(?=, \{\{clock\}\})/g, '{{date}}'),
      webSnapshotMode(),
    )

    // Exercise the same cropped native render path used to prepare OCR images.
    const cropRequests: unknown[] = []
    page.on('request', request => {
      if (!request.url().endsWith('/api/pdf.native') || request.method() !== 'POST') return
      const body = request.postDataJSON()
      if (body.payload?.action === 'tile') cropRequests.push(body.payload.tile)
    })
    await toolbar.locator('summary').click()
    await toolbar.getByRole('button', { name: 'Region screenshot', exact: true }).click()
    await reader.locator('.dsh-pdf-mode-region').first().waitFor({ state: 'visible' })
    // The region hint changes toolbar height; use the new page position.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const shotText = await textSpan.boundingBox()
    expect(shotText).not.toBeNull()
    await page.mouse.move(shotText!.x - 3, shotText!.y - 3)
    await page.mouse.down()
    await page.mouse.move(shotText!.x + shotText!.width + 3, shotText!.y + shotText!.height + 3, { steps: 8 })
    await page.mouse.up()
    const preview = reader.getByRole('dialog', { name: 'Screenshot preview' })
    await preview.waitFor({ state: 'visible' })
    const screenshotInk = await preview.getByRole('img').evaluate(async element => {
      const image = element as HTMLImageElement
      await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      canvas.getContext('2d')!.drawImage(image, 0, 0)
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let ink = 0
      for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 120 && pixels[index + 1] < 120 && pixels[index + 2] < 120) ink++
      canvas.width = 0; canvas.height = 0; return ink
    })
    expect(screenshotInk, JSON.stringify({ shotText, cropRequests, page: await reader.locator('[data-pdf-page="1"]').boundingBox() })).toBeGreaterThan(100)
    await preview.getByRole('button', { name: 'Close', exact: true }).click()

    const firstPage = reader.locator('[data-pdf-page="1"]')
    const widthBeforePinch = await firstPage.evaluate(element => element.offsetWidth)
    await firstPage.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      for (let index = 0; index < 24; index++) element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -7,
        clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
      }))
    })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    expect(await firstPage.evaluate(element => (element as HTMLElement).style.transform)).toMatch(/^scale\(/)
    await expect.poll(() => firstPage.evaluate(element => element.offsetWidth)).toBeGreaterThan(widthBeforePinch)
    await expect.poll(() => firstPage.evaluate(element => (element as HTMLElement).style.transform)).toBe('')
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(EXPECTED, [
      'opened-toolbar.expected.md', 'dirty-toolbar.expected.md', 'saved-note.expected.md',
    ])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('keeps active pages bounded while navigating to a distant page through the installed Web plugin', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.name === '@local/dsh-pdf')
    expect(entry?.fiber?.state).toBe(2)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-many-pages-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF many pages test' })
    await writeFile(join(scaffold.workspaceCwd, LARGE_FILE_NAME), await manyPageSourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-many-pages-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF many pages test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: LARGE_FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 }).catch(async failure => {
      throw new Error(`${String(failure)}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 1')
    expect(await reader.locator('.dsh-pdf-page').count()).toBeLessThan(20)

    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const pageInput = toolbar.getByRole('textbox', { name: 'Page' })
    await pageInput.fill(String(LARGE_PAGE_COUNT))
    await pageInput.press('Enter')
    await reader.locator(`[data-pdf-page="${LARGE_PAGE_COUNT}"] canvas`).first().waitFor({ state: 'visible', timeout: 20_000 })
    if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1') {
      expect(await reader.locator('.dsh-pdf-tile-surface').count()).toBeGreaterThan(0)
      expect(await reader.locator('[data-page-number]').count()).toBeLessThan(20)
    }
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain(`Browser PDF page ${LARGE_PAGE_COUNT}`)
    expect(await reader.locator('.dsh-pdf-page').count()).toBeLessThan(20)
    expect(await reader.locator('[data-pdf-page="1"]').count()).toBe(0)
    await toolbar.getByRole('button', { name: '← Back', exact: true }).click()
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 1')
    expect(await reader.locator('.dsh-pdf-page').count()).toBeLessThan(20)

    // Select across two real PDF.js text layers. A DOM Range avoids relying on
    // platform-specific drag speed while exercising Reader's keyup capture path.
    await expect.poll(() => reader.locator('[data-pdf-page="2"] [data-pdf-text="active"]').textContent())
      .toContain('Browser PDF page 2')
    const selectedText = await reader.evaluate(element => {
      const first = element.querySelector('[data-pdf-page="1"] .dsh-pdf-text-layer span')?.firstChild
      const second = element.querySelector('[data-pdf-page="2"] .dsh-pdf-text-layer span')?.firstChild
      const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
      if (!first || !second || !scroll) throw new Error('Both PDF text layers must be mounted')
      const range = document.createRange()
      range.setStart(first, 0)
      range.setEnd(second, second.textContent?.length ?? 0)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
      return selection?.toString() ?? ''
    })
    expect(selectedText).toContain('Browser PDF page 1')
    expect(selectedText).toContain('Browser PDF page 2')
    const selectionToolbar = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await selectionToolbar.waitFor({ state: 'visible' })

    // The selected pages leave the viewport but keep their live text nodes and
    // native range; otherwise a cross-page selection is lost on virtualization.
    await reader.locator('.dsh-pdf-scroll').evaluate((scroll, count) => {
      const windowed = scroll.querySelector<HTMLElement>('.dsh-pdf-windowed-pages')
      if (windowed) { scroll.scrollTop = windowed.offsetHeight / count * 5; return }
      const destination = scroll.querySelector<HTMLElement>(':scope > [data-page-number="6"]')
      if (!destination) throw new Error('Missing page-six scroll slot')
      scroll.scrollTop = destination.offsetTop
    }, LARGE_PAGE_COUNT)
    await reader.locator('[data-pdf-page="6"]').waitFor({ state: 'attached' })
    await expect.poll(() => reader.locator('[data-pdf-page="1"]').evaluate(element => {
      const viewport = element.closest('.dsh-pdf-scroll')!.getBoundingClientRect()
      return element.getBoundingClientRect().bottom < viewport.top
    })).toBe(true)
    expect(await reader.locator('[data-pdf-page="1"] [data-pdf-text="active"]').textContent())
      .toContain('Browser PDF page 1')
    expect(await reader.locator('[data-pdf-page="2"] [data-pdf-text="active"]').textContent())
      .toContain('Browser PDF page 2')
    const preservedText = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(preservedText).toContain('Browser PDF page 1')
    expect(preservedText).toContain('Browser PDF page 2')
    expect(await reader.locator('.dsh-pdf-page').count()).toBeLessThan(20)

    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)
