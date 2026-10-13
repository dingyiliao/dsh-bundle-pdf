/** Keyless browser proof through the shipped Web profile, Loader and PDF workspace file. */
import { existsSync, realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, StandardFonts, rgb } from 'pdf-lib'
import { chromium, type Browser, type Page as BrowserPage } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode,
} from '../../deepseek-harness/apps/web/tests/scaffold.ts'
import { newEnglishPage, openSettings, saveFailureShot } from '../../deepseek-harness/apps/web/tests/support.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_ROOT = join(ROOT, '..', 'deepseek-harness')
const SESSION = join(DSH_ROOT, 'snapshots', 'web', 'seeded-history', 'session.v3.jsonl')
const EXPECTED = join(ROOT, 'tests', 'expected', 'web-pdf')
const FILE_NAME = 'reader-e2e.pdf'
const WIDE_NOTE_FILE_NAME = 'reader-wide-note-e2e.pdf'
const ANNOTATION_FILE_NAME = 'reader-annotation-e2e.pdf'
const LONG_ANNOTATION_FILE_NAME = 'reader-long-annotation-e2e.pdf'
const LARGE_FILE_NAME = 'reader-many-pages-e2e.pdf'
const WIDE_NOTE_PAGE = 25
const LONG_ANNOTATION_TARGET = 123
const LONG_ANNOTATION_SOURCE = 752
const LONG_ANNOTATION_PAGE_COUNT = 1151
const LARGE_PAGE_COUNT = 128
const NOTE = 'Saved through the PDF reader browser UI'

/** Sample the composited browser image, not just the SVG's declared fill. */
async function highlightPixels(page: BrowserPage) {
  const png = await page.locator('.dsh-pdf-reader [data-pdf-page="1"]').screenshot()
  return page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(bitmap, 0, 0)
    const pixel = (x: number, y: number) => {
      const data = context.getImageData(Math.floor(x * bitmap.width / 240), Math.floor((160 - y) * bitmap.height / 160), 1, 1).data
      return [data[0], data[1], data[2]]
    }
    const rows = [60, 100].map(y => ({ paper: pixel(190, y), left: pixel(45, y), overlap: pixel(85, y), right: pixel(125, y) }))
    bitmap.close(); canvas.width = 0; canvas.height = 0
    return rows
  }, [...png])
}

/** The screenshot action uses the separate Canvas annotation painter. */
async function screenshotHighlightPixels(page: BrowserPage) {
  return page.getByRole('dialog', { name: 'Screenshot preview' }).getByRole('img').evaluate(async element => {
    const image = element as HTMLImageElement
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(image, 0, 0)
    // The drag selected PDF rect [10, 30, 170, 130].
    const pixel = (x: number, y: number) => {
      const data = context.getImageData(Math.floor((x - 10) * canvas.width / 160), Math.floor((130 - y) * canvas.height / 100), 1, 1).data
      return [data[0], data[1], data[2]]
    }
    const rows = [60, 100].map(y => ({ paper: pixel(160, y), left: pixel(45, y), overlap: pixel(85, y), right: pixel(125, y) }))
    canvas.width = 0; canvas.height = 0
    return rows
  })
}

function expectUniformHighlight(rows: Awaited<ReturnType<typeof highlightPixels>>) {
  for (const row of rows) {
    expect(row.left[1], JSON.stringify(row)).toBeLessThan(row.paper[1] - 20)
    for (const other of [row.overlap, row.right]) {
      expect(Math.max(...row.left.map((channel, index) => Math.abs(channel - other[index]))), JSON.stringify(row))
        .toBeLessThanOrEqual(4)
    }
  }
}

async function launchBrowser(): Promise<Browser> {
  if (process.env.PDF_BENCH_CHROMIUM) return chromium.launch({ executablePath: process.env.PDF_BENCH_CHROMIUM })
  if (existsSync(chromium.executablePath())) return chromium.launch()
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

async function outlinedSourcePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.load(await sourcePdf())
  const outlines = document.context.obj({ Type: 'Outlines', Count: 2 })
  const outlinesRef = document.context.register(outlines)
  const chapter = document.context.obj({ Title: PDFHexString.fromText('Chapter 1'), Parent: outlinesRef, Count: 1,
    Dest: [document.getPage(1).ref, PDFName.of('XYZ'), 50, 490, null] })
  const chapterRef = document.context.register(chapter)
  const section = document.context.obj({ Title: PDFHexString.fromText('Section 1'), Parent: chapterRef,
    Dest: [document.getPage(1).ref, PDFName.of('XYZ'), 50, 490, null] })
  const sectionRef = document.context.register(section)
  chapter.set(PDFName.of('First'), sectionRef); chapter.set(PDFName.of('Last'), sectionRef)
  outlines.set(PDFName.of('First'), chapterRef); outlines.set(PDFName.of('Last'), chapterRef)
  document.catalog.set(PDFName.of('Outlines'), outlinesRef)
  return document.save({ useObjectStreams: false })
}

/** A distant narrow note page centered beyond the horizontal viewport at 100% zoom. */
async function widePageWithNotePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index < WIDE_NOTE_PAGE; index++) {
    const page = document.addPage([4000, 560])
    if (index === 1) page.drawText('Wide first page', { x: 50, y: 490, size: 18, font })
  }
  const target = document.addPage([300, 560])
  target.drawText('Narrow note page', { x: 50, y: 490, size: 18, font })
  const annotation = document.context.obj({
    Type: 'Annot', Subtype: 'Text', P: target.ref, Rect: [50, 440, 70, 460],
    Contents: PDFHexString.fromText('Narrow-page note'), Name: PDFName.of('Comment'),
  })
  target.node.set(PDFName.of('Annots'), document.context.obj([document.context.register(annotation)]))
  return document.save({ useObjectStreams: false })
}

async function distantHighlightPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index < WIDE_NOTE_PAGE; index++) document.addPage([4000, 560])
  const target = document.addPage([300, 560])
  target.drawText('Highlighted target page', { x: 50, y: 490, size: 18, font })
  const annotation = document.context.obj({
    Type: 'Annot', Subtype: 'Highlight', P: target.ref, Rect: [48, 485, 270, 510],
    QuadPoints: [48, 510, 270, 510, 48, 485, 270, 485],
    Contents: PDFHexString.fromText('Distant highlight'), C: [1, 1, 0], F: 4,
  })
  target.node.set(PDFName.of('Annots'), document.context.obj([document.context.register(annotation)]))
  return document.save({ useObjectStreams: false })
}

/** Same-size pages reproduce a distant highlight jump in a book-length PDF. */
async function longHighlightPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= LONG_ANNOTATION_PAGE_COUNT; number++) {
    const page = document.addPage([595.28, 841.89])
    if (number === LONG_ANNOTATION_TARGET) {
      page.drawText('Highlighted destination', { x: 50, y: 760, size: 18, font })
      const annotation = document.context.obj({
        Type: 'Annot', Subtype: 'Highlight', P: page.ref, Rect: [48, 755, 295, 780],
        QuadPoints: [48, 780, 295, 780, 48, 755, 295, 755],
        Contents: PDFHexString.fromText('Distant book highlight'), C: [1, 0.5, 0], F: 4,
      })
      page.node.set(PDFName.of('Annots'), document.context.obj([document.context.register(annotation)]))
    } else if (number === LONG_ANNOTATION_SOURCE) {
      page.drawText('Starting page', { x: 50, y: 760, size: 18, font })
    }
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

async function savedNoteColor(path: string): Promise<number[] | undefined> {
  const document = await PDFDocument.load(await readFile(path))
  const annotations = document.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  if (!annotations) return undefined
  for (let index = 0; index < annotations.size(); index++) {
    const annotation = document.context.lookup(annotations.get(index), PDFDict)
    if (annotation.lookup(PDFName.of('Subtype'), PDFName).asString() !== '/Text') continue
    const color = annotation.lookup(PDFName.of('C'), PDFArray)
    return color && [0, 1, 2].map((channel) => color.lookup(channel, PDFNumber).asNumber())
  }
  return undefined
}

async function savedHighlightColors(path: string): Promise<number[][]> {
  const document = await PDFDocument.load(await readFile(path))
  const annotations = document.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  if (!annotations) return []
  const colors: number[][] = []
  for (let index = 0; index < annotations.size(); index++) {
    const annotation = document.context.lookup(annotations.get(index), PDFDict)
    if (annotation.lookup(PDFName.of('Subtype'), PDFName).asString() !== '/Highlight') continue
    const color = annotation.lookup(PDFName.of('C'), PDFArray)
    if (color) colors.push([0, 1, 2].map(channel => color.lookup(channel, PDFNumber).asNumber()))
  }
  return colors
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
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    const ocrSwitch = settings.getByRole('switch', { name: 'OCR' })
    expect(await ocrSwitch.isDisabled()).toBe(true)
    expect(await ocrSwitch.getAttribute('aria-checked')).toBe('false')
    expect(await settings.getByRole('combobox', { name: 'OCR engine' }).count()).toBe(0)
    expect(await settings.getByRole('textbox', { name: 'Recognition languages' }).count()).toBe(0)
    expect(await settings.getByRole('spinbutton', { name: 'Recognition timeout (milliseconds)' }).count()).toBe(0)
    expect(await settings.getByLabel('Source language').count()).toBe(0)
    expect(await settings.getByLabel('Default annotation color').count()).toBe(0)
    const translationEngine = settings.getByRole('combobox', { name: 'Translation engine' })
    await translationEngine.waitFor({ state: 'visible' })
    await expect.poll(() => translationEngine.inputValue()).toBe('dsh-model')
    const translationOptions = await translationEngine.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))
    expect(translationOptions).toContain('dsh-model')
    expect(translationOptions).not.toContain('none')
    expect(await settings.getByRole('combobox', { name: 'Target language' }).count()).toBe(0)
    expect(await settings.getByRole('spinbutton', { name: 'PDF size limit (bytes)' }).count()).toBe(0)
    const historyCapacity = settings.getByRole('spinbutton', { name: 'Navigation history capacity' })
    await expect.poll(() => historyCapacity.isEnabled()).toBe(true)
    await historyCapacity.fill('101')
    await settings.getByRole('button', { name: 'Save settings' }).click()
    await settings.getByText('Settings saved', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await openSettings(page, 'en')
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    await expect.poll(() => historyCapacity.inputValue()).toBe('101')
    await settings.getByRole('button', { name: 'Restore defaults' }).click()
    await expect.poll(() => historyCapacity.inputValue()).toBe('100')
    await settings.getByRole('button', { name: 'Discard changes' }).click()
    await expect.poll(() => historyCapacity.inputValue()).toBe('101')
    await page.keyboard.press('Escape')
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
    await reader.getByRole('tab', { name: 'Pages' }).click()
    const pagesHeading = reader.locator('.dsh-pdf-thumbnail-panel > .dsh-pdf-panel-heading h3')
    await pagesHeading.waitFor({ state: 'visible' })
    const pagesInset = await pagesHeading.evaluate(element => element.getBoundingClientRect().left
      - element.closest('.dsh-pdf-thumbnail-panel')!.getBoundingClientRect().left)
    await reader.getByRole('button', { name: 'Page 1 / 2' }).waitFor({ state: 'visible' })
    await reader.getByRole('button', { name: 'Page 2 / 2' }).waitFor({ state: 'visible' })
    await reader.getByRole('tab', { name: 'Bookmarks' }).click()
    const bookmarksHeading = reader.locator('.dsh-pdf-bookmark-panel > .dsh-pdf-panel-heading h3')
    await bookmarksHeading.waitFor({ state: 'visible' })
    const bookmarksInset = await bookmarksHeading.evaluate(element => element.getBoundingClientRect().left
      - element.closest('.dsh-pdf-bookmark-panel')!.getBoundingClientRect().left)
    expect(pagesInset).toBeGreaterThanOrEqual(9)
    expect(bookmarksInset).toBeGreaterThanOrEqual(9)
    expect(Math.abs(pagesInset - bookmarksInset)).toBeLessThanOrEqual(1)
    await reader.getByRole('button', { name: 'Bookmark current location' }).click()
    await reader.getByRole('textbox', { name: 'Bookmark name' }).fill('Browser test bookmark')
    await reader.getByRole('button', { name: 'Add', exact: true }).click()
    await reader.getByRole('button', { name: 'Browser test bookmark', exact: true }).waitFor({ state: 'visible' })
    await reader.getByRole('button', { name: 'Delete bookmark: Browser test bookmark' }).click()
    await reader.getByRole('button', { name: 'Delete?', exact: true }).click()
    await reader.getByText('No personal bookmarks yet.', { exact: true }).waitFor({ state: 'visible' })
    await reader.getByRole('tab', { name: 'Annotations' }).click()
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
    await selectionToolbar.getByRole('button', { name: 'Translate', exact: true }).click()
    const translationPanel = reader.locator('.dsh-pdf-translation-panel')
    const panelTargetLanguage = translationPanel.getByRole('combobox', { name: 'Target language' })
    await panelTargetLanguage.waitFor({ state: 'visible' })
    expect(await panelTargetLanguage.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
      .toEqual(['zh', 'en', 'ja', 'ko', 'fr', 'de'])
    await translationPanel.getByRole('button', { name: 'Close translation' }).click()
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

    await expect.poll(() => reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').count()).toBeGreaterThan(0)
    await reader.evaluate(element => {
      const owner = window as typeof window & { __pdfPaintWatch?: { blanks: number; frame: number; active: boolean } }
      const watch = { blanks: 0, frame: 0, active: true }
      owner.__pdfPaintWatch = watch
      const sample = () => {
        if (!watch.active) return
        if (!element.querySelector('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]')) watch.blanks++
        watch.frame = requestAnimationFrame(sample)
      }
      sample()
    })
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(() => savedNoteContents(path)).toEqual([NOTE])
    await expect.poll(() => reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').count()).toBeGreaterThan(0)
    const blankFrames = await page.evaluate(() => {
      const owner = window as typeof window & { __pdfPaintWatch?: { blanks: number; frame: number; active: boolean } }
      const watch = owner.__pdfPaintWatch
      if (!watch) throw new Error('PDF paint watch was not installed')
      watch.active = false
      cancelAnimationFrame(watch.frame)
      delete owner.__pdfPaintWatch
      return watch.blanks
    })
    expect(blankFrames).toBe(0)
    expect(Buffer.from(await readFile(path)).equals(Buffer.from(original))).toBe(false)
    const savedNoteAria = await captureStableAria(page, '.dsh-pdf-notes', scaffold.workspaceCwd)
    expect(savedNoteAria).toMatch(/Created: \d{1,2}\/\d{1,2}\/\d{4}, \{\{clock\}\}/)
    await compareOrRefreshGolden(
      join(EXPECTED, 'saved-note.expected.md'),
      savedNoteAria.replace(/\d{1,2}\/\d{1,2}\/\d{4}(?=, \{\{clock\}\})/g, '{{date}}'),
      webSnapshotMode(),
    )

    // Saving rematerializes the PDF and can assign a new annotation identity.
    // Select the saved row rather than relying on the pre-save selection.
    await notePanel.locator('.dsh-pdf-comment-item').filter({ hasText: NOTE }).click()
    const selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await selectedToolbar.waitFor({ state: 'visible' })
    expect(await selectedToolbar.getByRole('button', { name: 'Apply color' }).count()).toBe(0)
    const commentDraft = notePanel.getByRole('textbox', { name: 'Comment' })
    await commentDraft.fill('Unapplied comment draft')
    const selectedColor = selectedToolbar.getByLabel('Selected annotation color')
    await selectedColor.fill('#ff0000')
    await selectedColor.fill('#00ff00')
    await expect.poll(() => selectedColor.inputValue()).toBe('#00ff00')
    await expect.poll(() => save.isEnabled()).toBe(true)
    expect(await commentDraft.inputValue()).toBe('Unapplied comment draft')
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(() => savedNoteColor(path)).toEqual([0, 1, 0])
    await expect.poll(() => savedNoteContents(path)).toEqual([NOTE])

    // Exercise the same cropped native render path used to prepare OCR images.
    const cropRequests: unknown[] = []
    page.on('request', request => {
      if (!request.url().endsWith('/api/pdf.native') || request.method() !== 'POST') return
      const body = request.postDataJSON()
      if (body.payload?.action === 'tile') cropRequests.push(body.payload.tile)
    })
    await toolbar.locator('summary').click()
    expect(await toolbar.getByRole('button', { name: 'OCR page' }).count()).toBe(0)
    await toolbar.getByRole('button', { name: 'Region screenshot', exact: true }).click()
    await reader.locator('.dsh-pdf-mode-region').first().waitFor({ state: 'visible' })
    // The region hint changes toolbar height; use the new page position.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await textSpan.scrollIntoViewIfNeeded()
    const shotText = await textSpan.boundingBox()
    expect(shotText).not.toBeNull()
    await page.mouse.move(shotText!.x - 3, shotText!.y - 3)
    await page.mouse.down()
    await page.mouse.move(shotText!.x + shotText!.width + 3, shotText!.y + shotText!.height + 3, { steps: 8 })
    await page.mouse.up()
    const preview = reader.getByRole('dialog', { name: 'Screenshot preview' })
    await preview.waitFor({ state: 'visible' })
    expect(await preview.getByRole('button', { name: 'Recognize region' }).count()).toBe(0)
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
    const secondPage = reader.locator('[data-pdf-page="2"]')
    const windowedPages = reader.locator('.dsh-pdf-windowed-pages')
    const widthBeforePinch = await firstPage.evaluate(element => element.offsetWidth)
    await firstPage.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      for (let index = 0; index < 24; index++) element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -7,
        clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
      }))
    })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    expect(await windowedPages.evaluate(element => (element as HTMLElement).style.transform)).toMatch(/^scale\(/)
    const firstPreview = await firstPage.boundingBox(), secondPreview = await secondPage.boundingBox()
    expect(firstPreview && secondPreview && secondPreview.y - firstPreview.y - firstPreview.height).toBeGreaterThanOrEqual(0)
    await expect.poll(() => firstPage.evaluate(element => element.offsetWidth)).toBeGreaterThan(widthBeforePinch)
    await expect.poll(() => windowedPages.evaluate(element => (element as HTMLElement).style.transform)).toBe('')
    const firstCommitted = await firstPage.boundingBox(), secondCommitted = await secondPage.boundingBox()
    expect(firstCommitted && secondCommitted && secondCommitted.y - firstCommitted.y - firstCommitted.height).toBeGreaterThanOrEqual(0)

    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(EXPECTED, [
      'opened-toolbar.expected.md', 'dirty-toolbar.expected.md', 'saved-note.expected.md',
    ])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('uses the desktop Save As picker and clears a single stale-save conflict after discard', async () => {
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
      const owner = window as typeof window & { __DSH_SAVE_FILE_PICKER__?: { pick(path: string): Promise<string | null> };
        __pdfPickerNextPath?: string | null; __pdfPickerDefaults?: string[] }
      owner.__pdfPickerDefaults = []
      owner.__pdfPickerNextPath = null
      owner.__DSH_SAVE_FILE_PICKER__ = {
        async pick(defaultPath) {
          owner.__pdfPickerDefaults!.push(defaultPath)
          return owner.__pdfPickerNextPath ?? null
        },
      }
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await toolbar.locator('summary').click()
    await toolbar.getByRole('button', { name: 'Note', exact: true }).click()
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 120, y: 140 } })
    const notePanel = reader.locator('.dsh-pdf-notes')
    await notePanel.getByRole('textbox', { name: 'Comment' }).fill(NOTE)
    await notePanel.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(() => save.isEnabled()).toBe(true)

    const saveAs = toolbar.getByRole('button', { name: 'Save as', exact: true })
    await saveAs.click()
    expect(await reader.locator('.dsh-pdf-dialog').count()).toBe(0)
    expect(await save.isEnabled()).toBe(true)
    await page.evaluate(path => {
      (window as typeof window & { __pdfPickerNextPath?: string | null }).__pdfPickerNextPath = path
    }, copyPath)
    await saveAs.click()
    await expect.poll(() => savedNoteContents(copyPath)).toEqual([NOTE])
    await expect.poll(() => reader.locator('.dsh-pdf-status').getAttribute('title')).toBe(copyPath)
    const pickerDefaults = await page.evaluate(() =>
      (window as typeof window & { __pdfPickerDefaults?: string[] }).__pdfPickerDefaults)
    expect(pickerDefaults).toEqual([sourcePath.replace(/\.pdf$/i, '-annotated.pdf'), sourcePath.replace(/\.pdf$/i, '-annotated.pdf')])

    await toolbar.locator('summary').click()
    await toolbar.getByRole('button', { name: 'Note', exact: true }).click()
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 180, y: 210 } })
    await notePanel.getByRole('textbox', { name: 'Comment' }).fill('Unsaved after Save As')
    await notePanel.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(() => save.isEnabled()).toBe(true)
    await writeFile(copyPath, original)
    await save.click()
    const conflict = reader.locator('.dsh-pdf-notice').filter({ hasText: 'The source file changed outside this reader.' })
    await conflict.waitFor({ state: 'visible' })
    expect(await conflict.count()).toBe(1)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    const discard = toolbar.getByRole('button', { name: 'Discard all changes' })
    await expect.poll(() => discard.isEnabled()).toBe(true)
    await discard.click()
    await conflict.waitFor({ state: 'hidden' })
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    await expect.poll(() => save.isDisabled()).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('navigates from the whole built-in and personal bookmark item without hijacking item actions', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-bookmark-rows-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF bookmark rows test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await outlinedSourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-bookmark-rows-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF bookmark rows test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
    await reader.getByRole('tab', { name: 'Bookmarks' }).click()
    const sidebarPage = reader.locator('.dsh-pdf-sidebar').getByRole('textbox', { name: 'Page' })
    const scroll = reader.locator('.dsh-pdf-scroll')
    const scrollTop = () => scroll.evaluate(root => root.scrollTop)

    const chapter = reader.locator('.dsh-pdf-bookmark-row').filter({ hasText: 'Chapter 1' }).first()
    await expect.poll(() => chapter.getByRole('button', { name: 'Chapter 1' }).isEnabled()).toBe(true)
    const chapterBox = await chapter.boundingBox()
    expect(chapterBox).not.toBeNull()
    await page.mouse.click(chapterBox!.x + 8, chapterBox!.y + chapterBox!.height / 2)
    // The final page cannot always align to the viewport top because scrolling
    // clamps at the document end, so current-page tracking can remain on page 1.
    // Scroll position directly proves that the bookmark navigated to page 2.
    await expect.poll(scrollTop, { timeout: 20_000 }).toBeGreaterThan(200)
    await reader.getByRole('button', { name: '← Back' }).click()
    await expect.poll(scrollTop).toBeLessThan(20)
    await chapter.getByRole('button', { name: 'Expand bookmark section' }).click()
    await reader.getByRole('treeitem', { name: 'Section 1' }).waitFor({ state: 'visible' })
    expect(await scrollTop()).toBeLessThan(20)

    await reader.getByRole('button', { name: 'Bookmark current location' }).click()
    await reader.getByRole('textbox', { name: 'Bookmark name' }).fill('Whole-row bookmark')
    await reader.getByRole('button', { name: 'Add', exact: true }).click()
    const personal = reader.locator('.dsh-pdf-personal-bookmark-row').first()
    await personal.getByRole('button', { name: 'Whole-row bookmark', exact: true }).waitFor({ state: 'visible' })
    await sidebarPage.fill('2'); await sidebarPage.press('Enter')
    await expect.poll(scrollTop).toBeGreaterThan(200)
    const bookmarkPageBox = await personal.getByText('Page 1', { exact: true }).boundingBox()
    expect(bookmarkPageBox).not.toBeNull()
    await page.mouse.click(bookmarkPageBox!.x + bookmarkPageBox!.width / 2, bookmarkPageBox!.y + bookmarkPageBox!.height / 2)
    await expect.poll(scrollTop).toBeLessThan(20)
    await sidebarPage.fill('2'); await sidebarPage.press('Enter')
    await expect.poll(scrollTop).toBeGreaterThan(200)
    await personal.getByRole('button', { name: 'Rename bookmark: Whole-row bookmark' }).click()
    expect(await scrollTop()).toBeGreaterThan(200)
    await personal.getByRole('button', { name: 'Cancel' }).click()
    await personal.getByRole('button', { name: 'Delete bookmark: Whole-row bookmark' }).click()
    expect(await scrollTop()).toBeGreaterThan(200)
    await personal.getByRole('button', { name: 'Cancel' }).click()
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('renders a distant note page when a wide PDF leaves it outside the horizontal viewport', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-wide-note-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF wide note test' })
    await writeFile(join(scaffold.workspaceCwd, WIDE_NOTE_FILE_NAME), await widePageWithNotePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-wide-note-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF wide note test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: WIDE_NOTE_FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await reader.getByRole('combobox', { name: 'Zoom' }).selectOption('1')
    const scroll = reader.locator('.dsh-pdf-scroll')
    await expect.poll(() => scroll.evaluate(root => root.scrollWidth)).toBeGreaterThan(3000)
    await scroll.evaluate(root => { root.scrollTop = 0; root.scrollLeft = 0 })
    await reader.locator('[data-pdf-page="1"]').waitFor({ state: 'attached' })
    await reader.getByRole('tab', { name: 'Notes' }).click()
    const note = reader.locator('.dsh-pdf-notes .dsh-pdf-comment-item').filter({ hasText: 'Narrow-page note' })
    await note.waitFor({ state: 'visible' })
    await note.click()

    const target = reader.locator(`[data-pdf-page="${WIDE_NOTE_PAGE}"]`)
    await target.waitFor({ state: 'attached', timeout: 10_000 })
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    await expect.poll(() => reader.getByRole('combobox', { name: 'Zoom' }).isEnabled()).toBe(true)
    await expect.poll(() => scroll.evaluate(root => root.scrollLeft)).toBeGreaterThan(1000)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('renders a distant highlight after navigating from the Annotations sidebar', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-annotation-jump-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF annotation jump test' })
    await writeFile(join(scaffold.workspaceCwd, ANNOTATION_FILE_NAME), await distantHighlightPdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-annotation-jump-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF annotation jump test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: ANNOTATION_FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await reader.getByRole('combobox', { name: 'Zoom' }).selectOption('1')
    const scroll = reader.locator('.dsh-pdf-scroll')
    await expect.poll(() => scroll.evaluate(root => root.scrollWidth)).toBeGreaterThan(3000)
    await scroll.evaluate(root => { root.scrollTop = 0; root.scrollLeft = 0 })
    await reader.getByRole('tab', { name: 'Annotations' }).click()
    const annotation = reader.locator('.dsh-pdf-comments .dsh-pdf-comment-item').filter({ hasText: 'Distant highlight' })
    await annotation.waitFor({ state: 'visible' })
    await annotation.click()

    const target = reader.locator(`[data-pdf-page="${WIDE_NOTE_PAGE}"]`)
    await target.waitFor({ state: 'attached', timeout: 10_000 })
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    await expect.poll(() => reader.getByRole('combobox', { name: 'Zoom' }).isEnabled()).toBe(true)
    const selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await selectedToolbar.waitFor({ state: 'visible' })
    await selectedToolbar.getByLabel('Selected annotation color').fill('#ff0000')
    await expect.poll(() => reader.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(true)
    await selectedToolbar.getByRole('button', { name: 'Deselect' }).click()
    await reader.getByRole('button', { name: '← Back' }).click()
    await expect.poll(() => scroll.evaluate(root => root.scrollTop)).toBeLessThan(20)
    await target.waitFor({ state: 'detached' })
    await annotation.click()
    await target.waitFor({ state: 'attached', timeout: 10_000 })
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    await expect.poll(() => reader.getByRole('combobox', { name: 'Zoom' }).isEnabled()).toBe(true)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('jumps from a distant page to a highlight in a book-length PDF', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-long-annotation-jump-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF long annotation jump test' })
    await writeFile(join(scaffold.workspaceCwd, LONG_ANNOTATION_FILE_NAME), await longHighlightPdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-long-annotation-jump-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF long annotation jump test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: LONG_ANNOTATION_FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    const input = reader.locator('.dsh-pdf-sidebar').getByRole('textbox', { name: 'Page' })
    await input.fill(String(LONG_ANNOTATION_SOURCE))
    await input.press('Enter')
    await reader.locator(`[data-pdf-page="${LONG_ANNOTATION_SOURCE}"] canvas[data-pdf-raster-ready="true"]`).first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    // Keep zoom=1 while fit width computes a different effective scale. A
    // previous jump used to rebuild the 1151-page layout and restore its old anchor.
    const zoom = reader.getByRole('combobox', { name: 'Zoom' })
    await zoom.selectOption('1')
    await zoom.selectOption('width')
    await reader.getByRole('tab', { name: 'Annotations' }).click()
    await reader.locator('.dsh-pdf-comments .dsh-pdf-comment-item').filter({ hasText: 'Distant book highlight' }).click()

    const target = reader.locator(`[data-pdf-page="${LONG_ANNOTATION_TARGET}"]`)
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => input.inputValue()).toBe(String(LONG_ANNOTATION_TARGET))
    await expect.poll(() => target.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const root = element.closest('.dsh-pdf-scroll')?.getBoundingClientRect()
      return !!root && box.bottom > root.top && box.top < root.bottom && box.right > root.left && box.left < root.right
    })).toBe(true)
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 150_000)

it('renders an annotation destination after scrolling deep into a book-length PDF', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-scrolled-annotation-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF scrolled annotation test' })
    await writeFile(join(scaffold.workspaceCwd, LONG_ANNOTATION_FILE_NAME), await longHighlightPdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-scrolled-annotation-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF scrolled annotation test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: LONG_ANNOTATION_FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.getByRole('tab', { name: 'Annotations' }).click()
    const scroll = reader.locator('.dsh-pdf-scroll')
    const input = reader.locator('.dsh-pdf-sidebar').getByRole('textbox', { name: 'Page' })
    await reader.locator('.dsh-pdf-windowed-pages').waitFor({ state: 'attached', timeout: 20_000 })
    await scroll.evaluate((root, { source, count }) => {
      const pages = root.querySelector<HTMLElement>('.dsh-pdf-windowed-pages')
      if (!pages) throw new Error('Book layout is not ready')
      root.scrollTop = pages.offsetHeight * (source - 0.9) / count
    }, { source: LONG_ANNOTATION_SOURCE, count: LONG_ANNOTATION_PAGE_COUNT })
    const source = reader.locator(`[data-pdf-page="${LONG_ANNOTATION_SOURCE}"]`)
    await source.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => input.inputValue()).toBe(String(LONG_ANNOTATION_SOURCE))

    await reader.locator('.dsh-pdf-comments .dsh-pdf-comment-item')
      .filter({ hasText: 'Distant book highlight' }).first().click()
    const target = reader.locator(`[data-pdf-page="${LONG_ANNOTATION_TARGET}"]`)
    await target.locator('.dsh-pdf-tile-surface').waitFor({ state: 'visible', timeout: 20_000 })
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => input.inputValue()).toBe(String(LONG_ANNOTATION_TARGET))
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    await expect.poll(() => target.evaluate(element => {
      const root = element.closest('.dsh-pdf-scroll')?.getBoundingClientRect()
      if (!root) return false
      return [...element.querySelectorAll<HTMLCanvasElement>('canvas[data-pdf-raster-ready="true"]')].some(canvas => {
        const box = canvas.getBoundingClientRect()
        if (box.bottom <= root.top || box.top >= root.bottom || box.right <= root.left || box.left >= root.right) return false
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return false
        const left = Math.max(0, Math.floor((Math.max(box.left, root.left) - box.left) * canvas.width / box.width))
        const top = Math.max(0, Math.floor((Math.max(box.top, root.top) - box.top) * canvas.height / box.height))
        const right = Math.min(canvas.width, Math.ceil((Math.min(box.right, root.right) - box.left) * canvas.width / box.width))
        const bottom = Math.min(canvas.height, Math.ceil((Math.min(box.bottom, root.bottom) - box.top) * canvas.height / box.height))
        if (right <= left || bottom <= top) return false
        const pixels = context.getImageData(left, top, right - left, bottom - top).data
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 100 && Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 180) return true
        }
        return false
      })
    }), { timeout: 20_000 }).toBe(true)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 150_000)

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
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const pageInput = sidebar.getByRole('textbox', { name: 'Page' })
    expect(await pageInput.isVisible()).toBe(true)
    expect(await toolbar.getByRole('textbox', { name: 'Page' }).count()).toBe(0)
    await pageInput.fill(String(LARGE_PAGE_COUNT))
    await pageInput.press('Enter')
    await reader.locator(`[data-pdf-page="${LARGE_PAGE_COUNT}"] canvas`).first().waitFor({ state: 'visible', timeout: 20_000 })
    expect(await reader.locator('.dsh-pdf-tile-surface').count()).toBeGreaterThan(0)
    expect(await reader.locator('[data-page-number]').count()).toBeLessThan(20)
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain(`Browser PDF page ${LARGE_PAGE_COUNT}`)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-page').count()).toBeLessThan(20)
    await expect.poll(() => reader.locator('[data-pdf-page="1"]').count()).toBe(0)

    await toolbar.getByRole('button', { name: '← Back', exact: true }).click()
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 1')
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-page').count()).toBeLessThan(20)

    // Select across two visible PDF text layers. A DOM Range avoids relying on
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

    // Page navigation stays in the sidebar in either width, and malformed
    // drafts never navigate or remain visible after submission.
    const pageBeforeInvalid = await pageInput.inputValue()
    await pageInput.fill(String(LARGE_PAGE_COUNT + 1))
    await pageInput.press('Enter')
    await expect.poll(() => pageInput.inputValue()).toBe(pageBeforeInvalid)
    await pageInput.fill('')
    await pageInput.press('Enter')
    await expect.poll(() => pageInput.inputValue()).toBe(pageBeforeInvalid)
    await sidebar.getByRole('button', { name: 'Collapse reading sidebar' }).click()
    expect(await sidebar.evaluate(element => element.classList.contains('is-collapsed'))).toBe(true)
    const compactPageInput = sidebar.getByRole('textbox', { name: 'Page' })
    expect(await compactPageInput.isVisible()).toBe(true)
    await compactPageInput.fill('2')
    await compactPageInput.press('Enter')
    await expect.poll(() => compactPageInput.inputValue()).toBe('2')
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 2')
    await compactPageInput.fill('1')
    await compactPageInput.press('Enter')
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 1')

    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)

it('keeps one new highlight uniform across overlapping quads before and after save', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-overlap-highlight-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF overlapping highlight test' })
    const path = join(scaffold.workspaceCwd, 'reader-overlap-highlight-e2e.pdf')
    const source = await PDFDocument.create()
    const sheet = source.addPage([240, 160])
    sheet.drawRectangle({ x: 0, y: 0, width: 240, height: 80, color: rgb(0.75, 0.75, 0.75) })
    await writeFile(path, await source.save({ useObjectStreams: false }))

    // Seed a real Host edit so the browser renders its unsaved SVG preview.
    // Each quad has a flat area and shares one overlapping 30-point strip.
    const service = scaffold.ctx.get('pdf') as { dispatch(sessionId: string, input: Record<string, unknown>,
      agent: { session: { id: string; header: { cwd?: string } } }, signal: AbortSignal): Promise<unknown> } | undefined
    expect(service).toBeDefined()
    const resolved = await scaffold.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const signal = new AbortController().signal
    const address = `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path.split('/').map(encodeURIComponent).join('/')}`
    const opened = await service!.dispatch(sessionId, { action: 'open', sessionId, address }, resolved.agent, signal) as { id: string; revision: number }
    const edited = await service!.dispatch(sessionId, { action: 'change', sessionId, id: opened.id, revision: opened.revision,
      operations: [{ type: 'add', annotation: {
        id: 'overlapping-quads', page: 1, subtype: 'Highlight', rect: [20, 40, 150, 120],
        quadPoints: [20, 120, 100, 120, 20, 40, 100, 40, 70, 120, 150, 120, 70, 40, 150, 40],
        color: [1, 0.38431, 0],
      } }],
    }, resolved.agent, signal) as { dirty: boolean }
    expect(edited.dirty).toBe(true)

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-overlap-highlight-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF overlapping highlight test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: 'reader-overlap-highlight-e2e.pdf', exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay path').first().waitFor({ state: 'visible' })
    expect(await reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay path').count()).toBe(1)
    expectUniformHighlight(await highlightPixels(page))

    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    await toolbar.locator('summary').click()
    await toolbar.getByRole('button', { name: 'Region screenshot', exact: true }).click()
    const box = await reader.locator('[data-pdf-page="1"]').boundingBox()
    expect(box).not.toBeNull()
    const point = (x: number, y: number) => ({ x: box!.x + x * box!.width / 240, y: box!.y + (160 - y) * box!.height / 160 })
    const start = point(10, 130), end = point(170, 30)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 8 })
    await page.mouse.up()
    const preview = reader.getByRole('dialog', { name: 'Screenshot preview' })
    await preview.waitFor({ state: 'visible' })
    expectUniformHighlight(await screenshotHighlightPixels(page))
    await preview.getByRole('button', { name: 'Close', exact: true }).click()

    const save = toolbar.getByRole('button', { name: 'Save', exact: true })
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay').waitFor({ state: 'detached' })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible' })
    expectUniformHighlight(await highlightPixels(page))
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)

it('highlights in yellow on the first click, then edits and persists five quick colors', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-highlight-colors-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF quick colors test' })
    const path = join(scaffold.workspaceCwd, 'reader-quick-colors-e2e.pdf')
    await writeFile(path, await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-quick-colors-browser'))
    const openReader = async () => {
      await page.getByRole('treeitem').filter({ hasText: 'PDF quick colors test' }).click()
      const reader = page.locator('.dsh-pdf-reader')
      if (!await reader.isVisible()) {
        const column = page.locator('[data-rightbar-col]')
        if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
        await column.locator('[data-sidebar-right-guide-entry="files"]').click()
        await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
        await column.locator('[data-files-reload]').click()
        await column.locator('[data-files-entry="file"]')
          .getByRole('button', { name: 'reader-quick-colors-e2e.pdf', exact: true }).click()
      }
      await reader.waitFor({ state: 'visible', timeout: 20_000 })
      await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
      await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
        .toContain('Browser PDF page one')
      return reader
    }
    const selectText = async () => {
      const selected = await page.locator('.dsh-pdf-reader').evaluate(element => {
        const text = element.querySelector('[data-pdf-page="1"] .dsh-pdf-text-layer span')?.firstChild
        const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
        if (!text || !scroll) throw new Error('PDF text layer is not ready for selection')
        const range = document.createRange()
        range.selectNodeContents(text)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
        return selection?.toString() ?? ''
      })
      expect(selected).toContain('Browser PDF page one')
      const toolbar = page.locator('.dsh-pdf-reader').getByRole('toolbar', { name: 'Selected text actions' })
      await toolbar.waitFor({ state: 'visible' })
      return toolbar
    }

    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    let reader = await openReader()
    let selectionToolbar = await selectText()
    const save = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
      .getByRole('button', { name: 'Save', exact: true })
    expect(await save.isDisabled()).toBe(true)
    expect(await reader.locator('.dsh-pdf-annotation-overlay path').count()).toBe(0)
    await selectionToolbar.getByRole('button', { name: 'Highlight', exact: true }).click()
    const firstOverlay = reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay path').first()
    await firstOverlay.waitFor({ state: 'visible' })
    await expect.poll(() => firstOverlay.getAttribute('fill')).toBe('rgb(255,255,0)')
    await expect.poll(() => save.isEnabled()).toBe(true)
    let selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await selectedToolbar.waitFor({ state: 'visible' })
    let quickColors = selectedToolbar.getByTestId('pdf-highlight-colors')
    await quickColors.waitFor({ state: 'visible' })
    const swatches = () => quickColors.locator('[data-testid^="pdf-highlight-swatch-"]')
    await expect.poll(() => swatches().count()).toBe(5)
    const palette = quickColors.getByTestId('pdf-highlight-palette')
    const add = quickColors.getByTestId('pdf-highlight-add-color')
    expect(await add.isDisabled()).toBe(true)

    await quickColors.getByTestId('pdf-highlight-swatch-4').click({ button: 'right' })
    const menu = page.getByTestId('pdf-highlight-color-menu')
    await menu.waitFor({ state: 'visible' })
    await menu.getByTestId('pdf-highlight-delete-color').click()
    await expect.poll(() => swatches().count()).toBe(4)
    await quickColors.getByTestId('pdf-highlight-swatch-3').click({ button: 'right' })
    await menu.waitFor({ state: 'visible' })
    await menu.getByTestId('pdf-highlight-edit-color').fill('#35b954')
    await expect.poll(() => quickColors.getByTestId('pdf-highlight-swatch-3')
      .evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(53, 185, 84)')
    // Editing a saved swatch changes only the palette, not the PDF annotation.
    expect(await firstOverlay.getAttribute('fill')).toBe('rgb(255,255,0)')
    // Choosing a palette color recolors the selected annotation, and that
    // color can be saved into the now-available fifth quick slot.
    await palette.fill('#128ace')
    await expect.poll(() => firstOverlay.getAttribute('fill')).toBe('rgb(18,138,206)')
    await expect.poll(() => add.isEnabled()).toBe(true)
    await add.click()
    await expect.poll(() => swatches().count()).toBe(5)
    expect(await add.isDisabled()).toBe(true)

    await quickColors.getByTestId('pdf-highlight-swatch-4').click({ button: 'right' })
    await menu.waitFor({ state: 'visible' })
    await menu.getByTestId('pdf-highlight-edit-color').fill('#a1b2c3')
    await expect.poll(() => quickColors.getByTestId('pdf-highlight-swatch-4')
      .evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(161, 178, 195)')
    expect(await firstOverlay.getAttribute('fill')).toBe('rgb(18,138,206)')
    await quickColors.getByTestId('pdf-highlight-swatch-4').click()
    await expect.poll(() => firstOverlay.getAttribute('fill')).toBe('rgb(161,178,195)')
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(async () => (await savedHighlightColors(path)).length).toBe(1)

    // The palette belongs to the user, not to this Reader instance. Reloading
    // the DSH client must retain its edited five-slot bar.
    await page.reload({ waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    reader = await openReader()
    selectionToolbar = await selectText()
    await selectionToolbar.getByRole('button', { name: 'Highlight', exact: true }).click()
    const overlay = reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay path').last()
    await overlay.waitFor({ state: 'visible' })
    await expect.poll(() => overlay.getAttribute('fill')).toBe('rgb(255,255,0)')
    selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await selectedToolbar.waitFor({ state: 'visible' })
    quickColors = selectedToolbar.getByTestId('pdf-highlight-colors')
    await quickColors.waitFor({ state: 'visible' })
    await expect.poll(() => quickColors.locator('[data-testid^="pdf-highlight-swatch-"]').count()).toBe(5)
    await expect.poll(() => quickColors.getByTestId('pdf-highlight-swatch-4')
      .evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(161, 178, 195)')

    // The saved quick color recolors the new highlight with one click.
    await quickColors.getByTestId('pdf-highlight-swatch-4').click()
    await expect.poll(() => overlay.getAttribute('fill')).toBe('rgb(161,178,195)')
    await quickColors.getByTestId('pdf-highlight-swatch-0').click()
    await expect.poll(() => overlay.getAttribute('fill')).not.toBe('rgb(161,178,195)')
    await quickColors.getByTestId('pdf-highlight-swatch-4').click()
    await expect.poll(() => overlay.getAttribute('fill')).toBe('rgb(161,178,195)')
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(async () => {
      const colors = await savedHighlightColors(path)
      return colors.length === 2 && colors.every(color => color.every((channel, index) =>
        Math.abs(channel - [161 / 255, 178 / 255, 195 / 255][index]) < 1e-6))
    }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)
