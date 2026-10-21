/** Keyless browser proof through the shipped Web profile, Loader and PDF workspace file. */
import { existsSync, realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts, rgb } from 'pdf-lib'
import { build } from 'esbuild'
import { chromium, type Browser, type Locator, type Page as BrowserPage } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode,
} from '../../deepseek-harness/apps/web/tests/scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, openSettings, saveFailureShot } from '../../deepseek-harness/apps/web/tests/support.ts'
import { attachPdfBrowserCoverage } from './browser-coverage.ts'
import type { SessionOcrLlm } from '../src/adapters/host/dsh/ocr-session-llm.ts'
import { loadPdfDocument } from '../src/adapters/host/pdf-lib/pdf-document.ts'
import { readPagePresentationMeta } from '../src/adapters/host/dsh/pdf-evidence-meta.ts'
import { evidenceSha256 } from '../src/modules/evidence/index.ts'
import { joinPageText } from '../src/shared/page-text.ts'

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

async function chooseZoom(reader: Locator, label: string) {
  const zoom = reader.locator('.dsh-pdf-toolbar-zoom')
  await zoom.locator('summary').click()
  await zoom.locator('.dsh-pdf-zoom-menu').getByRole('button', { name: label, exact: true }).click()
}

/** Main toolbar actions are icon-only, except the Tools entry. */
async function expectIconOnlyMainToolbar(toolbar: Locator) {
  const presentation = await toolbar.evaluate(element => {
    const visible = (control: HTMLElement) => control.getClientRects().length > 0
      && getComputedStyle(control).display !== 'none'
      && getComputedStyle(control).visibility !== 'hidden'
    const controls = element.querySelector<HTMLElement>('.dsh-pdf-toolbar-controls')!
    const actions = [...controls.querySelectorAll<HTMLElement>(
      ':scope > button, :scope > .dsh-pdf-toolbar-zoom > summary, :scope > .dsh-pdf-toolbar-back-split > button',
    )]
      .filter(visible).map(control => {
        const label = control.querySelector<HTMLElement>('.dsh-pdf-toolbar-label')
        const labelBox = label?.getBoundingClientRect()
        return {
          ariaLabel: control.getAttribute('aria-label'),
          tooltip: control.getAttribute('data-tooltip'),
          hasIcon: !!control.querySelector('svg'),
          visibleLabel: !!labelBox && labelBox.width > 4 && labelBox.height > 4,
        }
      })
    const toolsLabel = element.querySelector<HTMLElement>('.dsh-pdf-tools > summary .dsh-pdf-toolbar-label')!
    return { actions, toolsLabelWidth: toolsLabel.getBoundingClientRect().width }
  })
  expect(presentation.actions.length).toBeGreaterThan(0)
  expect(presentation.actions.every(action => action.ariaLabel?.trim())).toBe(true)
  expect(presentation.actions.every(action => action.tooltip?.trim())).toBe(true)
  expect(presentation.actions.every(action => action.hasIcon)).toBe(true)
  expect(presentation.actions.every(action => !action.visibleLabel)).toBe(true)
  expect(presentation.toolsLabelWidth).toBeGreaterThan(20)
}

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
  if (process.env.PDF_BENCH_CHROMIUM) return attachPdfBrowserCoverage(await chromium.launch({ executablePath: process.env.PDF_BENCH_CHROMIUM }))
  if (existsSync(chromium.executablePath())) return attachPdfBrowserCoverage(await chromium.launch())
  try { return attachPdfBrowserCoverage(await chromium.launch({ channel: 'chrome' })) }
  catch (error) {
    if (!/executable doesn't exist|distribution 'chrome' is not found/i.test(String(error))) throw error
    return attachPdfBrowserCoverage(await chromium.launch({ channel: 'msedge' }))
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

/** Real PDF outline destinations exercise the reader's vertical and rectangle fit modes. */
async function fittedOutlinePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= 4; number++) {
    const page = document.addPage([400, 560])
    page.drawText(`Fit destination page ${number}`, { x: 50, y: 490, size: 18, font })
  }
  const outlines = document.context.obj({ Type: 'Outlines', Count: 2 })
  const outlinesRef = document.context.register(outlines)
  const vertical = document.context.obj({ Title: PDFHexString.fromText('Fit vertical'), Parent: outlinesRef,
    Dest: [document.getPage(1).ref, PDFName.of('FitV'), 70] })
  const rectangle = document.context.obj({ Title: PDFHexString.fromText('Fit rectangle'), Parent: outlinesRef,
    Dest: [document.getPage(2).ref, PDFName.of('FitR'), 50, 120, 350, 430] })
  const verticalRef = document.context.register(vertical)
  const rectangleRef = document.context.register(rectangle)
  vertical.set(PDFName.of('Next'), rectangleRef)
  rectangle.set(PDFName.of('Prev'), verticalRef)
  outlines.set(PDFName.of('First'), verticalRef)
  outlines.set(PDFName.of('Last'), rectangleRef)
  document.catalog.set(PDFName.of('Outlines'), outlinesRef)
  return document.save({ useObjectStreams: false })
}

/** An external-reader highlight with two /IRT replies and a nested follow-up. */
async function externalThreadPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.load(await sourcePdf())
  const page = document.getPage(0)
  const root = document.context.register(document.context.obj({
    Type: 'Annot', Subtype: 'Highlight', P: page.ref, Rect: [48, 485, 270, 510],
    QuadPoints: [48, 510, 270, 510, 48, 485, 270, 485], C: [1, 1, 0], F: 4,
    NM: PDFString.of('external-thread-root'), T: PDFString.of('Document owner'),
  }))
  const alice = document.context.register(document.context.obj({
    Type: 'Annot', Subtype: 'Text', P: page.ref, Rect: [48, 485, 68, 505],
    IRT: root, RT: 'R', Contents: PDFHexString.fromText('Alice asks about the method'),
    T: PDFHexString.fromText('Alice'), CreationDate: PDFString.of("D:20261017100500+08'00'"),
    M: PDFString.of("D:20261017100500+08'00'"),
  }))
  const bob = document.context.register(document.context.obj({
    Type: 'Annot', Subtype: 'Text', P: page.ref, Rect: [48, 485, 68, 505],
    IRT: alice, RT: 'R', Contents: PDFHexString.fromText('Bob follows up'),
    T: PDFHexString.fromText('Bob'), CreationDate: PDFString.of("D:20261017102000+08'00'"),
    M: PDFString.of("D:20261017102000+08'00'"),
  }))
  page.node.set(PDFName.of('Annots'), document.context.obj([root, alice, bob]))
  return document.save({ useObjectStreams: false })
}

/** A selectable text mark without a comment, for the on-page comment flow. */
async function uncommentedHighlightPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.load(await sourcePdf())
  const target = document.getPage(0)
  const annotation = document.context.obj({
    Type: 'Annot', Subtype: 'Highlight', P: target.ref, Rect: [48, 485, 270, 510],
    QuadPoints: [48, 510, 270, 510, 48, 485, 270, 485], C: [1, 1, 0], F: 4,
  })
  target.node.set(PDFName.of('Annots'), document.context.obj([document.context.register(annotation)]))
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
    if (number === 1 || number === 2 || number === 115 || number === LARGE_PAGE_COUNT) {
      page.drawText(`Browser PDF page ${number}`, { x: 50, y: 490, size: 18, font })
    }
    if (number === 1 || number === LARGE_PAGE_COUNT) {
      const action = number === 1 ? 'LastPage' : 'FirstPage'
      const link = document.context.obj({ Type: 'Annot', Subtype: 'Link', P: page.ref, Rect: [50, 430, 180, 455],
        A: { S: PDFName.of('Named'), N: PDFName.of(action) } })
      page.node.set(PDFName.of('Annots'), document.context.obj([document.context.register(link)]))
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

it('keeps concurrent floating statuses ordered, cancelable, timed, and inside a narrow reader', async () => {
  const bundle = await build({ entryPoints: [join(ROOT, 'tests', 'modules', 'viewer', 'floating-status.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser' })
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
    await page.setContent('<div class="dsh-pdf-reader"><div class="dsh-pdf-content"><div class="dsh-pdf-floating-controls"><div class="dsh-pdf-floating-controls-layout" id="rail-root"></div></div></div></div>')
    await page.addStyleTag({ content: `:root { --dsw-alias-bg-base:#f5f5f5; --dsw-alias-bg-layer-1:#fff; --dsw-alias-label-primary:#222; --dsw-alias-border-l2:#ddd; --dsw-alias-link:#4278ed; } html,body { margin:0; height:100%; } ${await readFile(join(ROOT, 'src/client/reader.css'), 'utf8')}` })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const rail = page.locator('.dsh-pdf-floating-status-rail')
    await rail.waitFor({ state: 'attached' })
    const set = (items: { id: string; label: string; durationMs?: number; occurrence?: number }[]) => page.evaluate(next => {
      const fixture = (window as typeof window & { __pdfFloatingStatusFixture?: { set(items: typeof next): void } }).__pdfFloatingStatusFixture
      fixture!.set(next)
    }, items)
    await set([{ id: 'save', label: 'Saved', occurrence: 1 }])
    await expect.poll(() => rail.locator('.dsh-pdf-floating-status').count()).toBe(1)
    await set([{ id: 'ocr', label: 'Recognizing text' }, { id: 'save', label: 'Saved', occurrence: 1 }])
    await expect.poll(() => rail.locator('.dsh-pdf-floating-status').count()).toBe(2)
    expect(await rail.locator('.dsh-pdf-floating-status-content').allTextContents()).toEqual(['Saved', 'Recognizing text'])
    const [first, second] = await Promise.all([rail.locator('.dsh-pdf-floating-status').nth(0).boundingBox(),
      rail.locator('.dsh-pdf-floating-status').nth(1).boundingBox()])
    expect(first!.x).toBeLessThan(second!.x)
    await page.setViewportSize({ width: 1000, height: 600 })
    await expect.poll(async () => {
      const [wideStatus, wideToolbar] = await Promise.all([
        rail.locator('.dsh-pdf-floating-status').first().boundingBox(),
        page.locator('.dsh-pdf-main-toolbar').boundingBox(),
      ])
      return Math.abs(wideStatus!.y - wideToolbar!.y)
    }).toBeLessThanOrEqual(2)
    const [alignedToolbar, alignedContent, alignedStatuses] = await Promise.all([
      page.locator('.dsh-pdf-main-toolbar').boundingBox(),
      page.locator('.dsh-pdf-content').boundingBox(),
      rail.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements.map(element => {
        const { left, right } = element.getBoundingClientRect()
        return { left, right }
      })),
    ])
    expect(alignedStatuses.every(status => status.left >= alignedToolbar!.x + alignedToolbar!.width + 7),
      JSON.stringify({ alignedToolbar, alignedContent, alignedStatuses })).toBe(true)
    expect(alignedStatuses.every(status => status.right <= alignedContent!.x + alignedContent!.width - 11)).toBe(true)
    if (process.env.DSH_PDF_FLOATING_PREVIEW_PATH) {
      await page.screenshot({ path: process.env.DSH_PDF_FLOATING_PREVIEW_PATH.replace(/\.png$/, '-aligned.png') })
    }
    await page.setViewportSize({ width: 700, height: 600 })
    const [stackedToolbar, stackedRail, stackedContent] = await Promise.all([
      page.locator('.dsh-pdf-main-toolbar').boundingBox(), rail.boundingBox(), page.locator('.dsh-pdf-content').boundingBox(),
    ])
    expect(stackedRail!.y).toBeGreaterThanOrEqual(stackedToolbar!.y + stackedToolbar!.height + 7)
    expect(stackedRail!.x + stackedRail!.width).toBeLessThanOrEqual(stackedContent!.x + stackedContent!.width - 11)
    await page.setViewportSize({ width: 1200, height: 600 })
    await rail.getByRole('button', { name: 'Cancel ocr' }).click()
    await expect.poll(() => rail.locator('.dsh-pdf-floating-status').count()).toBe(1)
    expect(await page.evaluate(() => (window as typeof window & { __pdfFloatingStatusFixture?: { presses(): number } }).__pdfFloatingStatusFixture!.presses())).toBe(1)
    await set([{ id: 'save', label: 'Saved', occurrence: 1 }, { id: 'timed', label: 'Temporary', durationMs: 400, occurrence: 1 }])
    await expect.poll(() => rail.locator('.dsh-pdf-floating-status').count()).toBe(2)
    await page.waitForTimeout(200)
    await set([{ id: 'save', label: 'Saved', occurrence: 1 }, { id: 'timed', label: 'Temporary again', durationMs: 800, occurrence: 2 }])
    await page.waitForTimeout(300)
    expect(await rail.locator('.dsh-pdf-floating-status').count()).toBe(2)
    await expect.poll(() => rail.locator('.dsh-pdf-floating-status').count(), { timeout: 3000 }).toBe(1)
    await page.setViewportSize({ width: 380, height: 600 })
    await set([{ id: 'save', label: 'A long status about a PDF region that must stay readable', occurrence: 1 },
      { id: 'screenshot', label: 'Creating screenshot', occurrence: 1 }])
    await expect.poll(() => rail.locator('.dsh-pdf-floating-status').count()).toBe(2)
    const bounds = await rail.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements.map(element => {
      const { left, right, top } = element.getBoundingClientRect()
      return { left, right, top }
    }))
    const contentRight = await page.locator('.dsh-pdf-content').evaluate(element => element.getBoundingClientRect().right)
    expect(bounds.every(item => item.right <= contentRight - 10)).toBe(true)
    expect(Math.abs(Math.max(...bounds.map(item => item.right)) - contentRight + 12)).toBeLessThanOrEqual(2)
    expect(bounds[0]!.top).toBeLessThanOrEqual(bounds[1]!.top)
    await page.setViewportSize({ width: 200, height: 600 })
    const tinyBounds = await rail.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements.map(element => {
      const { left, right } = element.getBoundingClientRect()
      return { left, right }
    }))
    const tinyContent = await page.locator('.dsh-pdf-content').boundingBox()
    expect(tinyBounds.every(item => item.left >= tinyContent!.x + 11)).toBe(true)
    expect(tinyBounds.every(item => item.right <= tinyContent!.x + tinyContent!.width - 11)).toBe(true)
    await page.setViewportSize({ width: 380, height: 600 })
    if (process.env.DSH_PDF_FLOATING_PREVIEW_PATH) await page.screenshot({ path: process.env.DSH_PDF_FLOATING_PREVIEW_PATH })
  } finally { await browser.close() }
})

it('remembers the selected translation language for the next selection and after client reload', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.name === '@local/dsh-pdf')
    expect(entry?.fiber?.state).toBe(2)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-translation-language-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF translation language test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-translation-language-browser'))
    const reader = page.locator('.dsh-pdf-reader')
    const panel = reader.locator('.dsh-pdf-translation-panel')
    const target = panel.locator('.dsh-pdf-translation-language-trigger')
    const languageMenu = panel.locator('.dsh-pdf-translation-language-menu')
    const selectFirstWord = (start: number, end?: number) => reader.evaluate((element, offsets) => {
      const layer = element.querySelector('[data-pdf-page="1"] [data-pdf-text="active"]')
      const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
      const first = layer?.querySelector<HTMLElement>('span[data-pdf-run]')
      if (!first || !scroll) throw new Error('PDF text layer is not ready for translation selection')
      const spans = [...layer!.querySelectorAll<HTMLElement>('span[data-pdf-run]')]
        .filter(span => span.dataset.pdfRun === first.dataset.pdfRun)
      const word = spans.map(span => span.textContent ?? '').join('').match(/^\p{L}{5,}/u)?.[0]
      if (!word || spans.length < word.length) throw new Error('The PDF test page needs a positioned initial word')
      const stop = offsets.end ?? word.length
      if (offsets.start < 0 || stop > word.length || offsets.start >= stop) throw new Error('Invalid word selection offsets')
      const firstGlyph = spans[offsets.start]!.firstChild
      const lastGlyph = spans[stop - 1]!.firstChild
      if (!firstGlyph || !lastGlyph) throw new Error('PDF glyph text nodes are unavailable')
      const range = document.createRange()
      range.setStart(firstGlyph, 0)
      range.setEnd(lastGlyph, lastGlyph.textContent?.length ?? 0)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
      return word
    }, { start, end })
    const openReader = async () => {
      await page.getByRole('treeitem').filter({ hasText: 'PDF translation language test' }).click()
      if (!await reader.isVisible()) {
        const column = page.locator('[data-rightbar-col]')
        if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
        await column.locator('[data-sidebar-right-guide-entry="files"]').click()
        await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
        await column.locator('[data-files-reload]').click()
        await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()
      }
      await reader.waitFor({ state: 'visible', timeout: 20_000 })
      await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
        .toContain('Browser PDF page one')
    }
    const openTranslation = async () => {
      await selectFirstWord(0)
      const toolbar = reader.getByRole('toolbar', { name: 'Selected text actions' })
      await toolbar.waitFor({ state: 'visible' })
      await toolbar.getByRole('button', { name: 'Translate', exact: true }).click()
      await target.waitFor({ state: 'visible' })
    }

    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await openReader()
    const fullWord = await selectFirstWord(1, 5)
    const selectionToolbar = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await selectionToolbar.waitFor({ state: 'visible' })
    await selectionToolbar.getByRole('button', { name: 'Translate', exact: true }).click()
    await expect.poll(() => panel.locator('.dsh-pdf-translation-source-text').textContent()).toBe(fullWord.slice(1, 5))
    expect(await panel.locator('.dsh-pdf-translation-review').count()).toBe(0)
    const partialSelectionResult = panel.locator('.dsh-pdf-translation-result')
    await partialSelectionResult.waitFor({ state: 'visible' })
    await expect.poll(async () => await partialSelectionResult.getAttribute('aria-busy') === 'true'
      || await partialSelectionResult.locator('.dsh-pdf-translation-error').count() > 0).toBe(true)
    await panel.getByRole('button', { name: 'Close translation' }).click()
    await openTranslation()
    await expect.poll(() => target.getAttribute('aria-label')).toBe('Target language: Chinese')
    await target.click()
    await languageMenu.waitFor({ state: 'visible' })
    const panelBox = await panel.boundingBox()
    const menuBox = await languageMenu.boundingBox()
    expect(panelBox).not.toBeNull()
    expect(menuBox).not.toBeNull()
    const safeInset = 8
    expect(menuBox!.x).toBeGreaterThanOrEqual(panelBox!.x + safeInset)
    expect(menuBox!.y).toBeGreaterThanOrEqual(panelBox!.y + safeInset)
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width - safeInset)
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height - safeInset)
    const chineseOption = languageMenu.getByRole('button', { name: 'Chinese', exact: true })
    const englishOption = languageMenu.getByRole('button', { name: 'English', exact: true })
    await expect.poll(() => chineseOption.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => englishOption.getAttribute('aria-pressed')).toBe('false')
    const optionVisuals = await languageMenu.evaluate(element => {
      const selected = element.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      const unselected = element.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')
      if (!selected || !unselected) throw new Error('Translation language options are missing')
      return { selectedBackground: getComputedStyle(selected).background,
        unselectedBackground: getComputedStyle(unselected).background }
    })
    expect(optionVisuals.selectedBackground).not.toBe(optionVisuals.unselectedBackground)
    await languageMenu.getByRole('button', { name: 'French', exact: true }).click()
    await expect.poll(() => target.getAttribute('aria-label')).toBe('Target language: French')
    // Wait for the Host-backed ConfigForm mutation, not just the local menu
    // state, before simulating a fresh Client instance.
    await expect.poll(() => entry?.fiber?.config?.translationTargetLanguage?.get()).toBe('fr')
    await panel.getByRole('button', { name: 'Close translation' }).click()
    await openTranslation()
    await expect.poll(() => target.getAttribute('aria-label')).toBe('Target language: French')
    await panel.getByRole('button', { name: 'Close translation' }).click()

    await page.reload({ waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await openReader()
    await openTranslation()
    await expect.poll(() => target.getAttribute('aria-label')).toBe('Target language: French')
    await panel.getByRole('button', { name: 'Close translation' }).click()
    await selectFirstWord(0)
    const selectedTextActions = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await selectedTextActions.waitFor({ state: 'visible' })
    await selectedTextActions.getByRole('button', { name: 'Note', exact: true }).click()
    const noteCard = reader.locator('.dsh-pdf-page-comment-card')
    await noteCard.waitFor({ state: 'visible' })
    await expect.poll(() => noteCard.getByRole('textbox', { name: 'Note' }).evaluate(element => document.activeElement === element)).toBe(true)
    await noteCard.getByRole('button', { name: 'Cancel' }).click()
    await noteCard.waitFor({ state: 'hidden' })
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)

it('requires a question before saving an explanation passage, then edits or removes its page mark', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-explanation-mark-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF explanation mark test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-explanation-mark-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF explanation mark test' }).click()
    const reader = page.locator('.dsh-pdf-reader')
    if (!await reader.isVisible()) {
      const column = page.locator('[data-rightbar-col]')
      if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
      await column.locator('[data-sidebar-right-guide-entry="files"]').click()
      await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
      await column.locator('[data-files-reload]').click()
      await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()
    }
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page one')
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    const mainToolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const statusRail = reader.locator('.dsh-pdf-floating-status-rail')
    await mainToolbar.locator('.dsh-pdf-tools > summary').click()
    await mainToolbar.getByRole('button', { name: 'Note', exact: true }).click()
    await statusRail.locator('[data-status-id="note-mode"]').waitFor({ state: 'visible' })
    expect(await reader.locator('.dsh-pdf-notice').filter({ hasText: 'Click on the page to place a note.' }).count()).toBe(0)
    await mainToolbar.locator('.dsh-pdf-tools > summary').click()
    await mainToolbar.getByRole('button', { name: 'Region screenshot' }).click()
    const regionStatus = statusRail.locator('[data-status-id="region-selection"]')
    await regionStatus.waitFor({ state: 'visible' })
    expect(await statusRail.locator('[data-status-id="note-mode"]').count()).toBe(0)
    const regionContent = reader.locator('.dsh-pdf-content')
    const originalRegionContentStyle = await regionContent.getAttribute('style')
    try {
      await regionContent.evaluate(element => {
        const style = (element as HTMLElement).style
        style.flex = 'none'
        style.width = '1000px'
      })
      await regionStatus.evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished))
      })
      const [regionToolbarBox, regionStatusBox, regionContentBox] = await Promise.all([
        mainToolbar.boundingBox(), regionStatus.boundingBox(), regionContent.boundingBox(),
      ])
      expect(Math.abs(regionStatusBox!.y - regionToolbarBox!.y)).toBeLessThanOrEqual(2)
      expect(regionStatusBox!.x).toBeGreaterThanOrEqual(regionToolbarBox!.x + regionToolbarBox!.width + 7)
      expect(regionStatusBox!.x + regionStatusBox!.width)
        .toBeLessThanOrEqual(regionContentBox!.x + regionContentBox!.width - 11)
    } finally {
      await regionContent.evaluate((element, style) => {
        if (style === null) element.removeAttribute('style')
        else element.setAttribute('style', style)
      }, originalRegionContentStyle)
    }
    await reader.locator('.dsh-pdf-scroll').focus()
    await page.keyboard.press('Escape')
    await regionStatus.waitFor({ state: 'hidden' })
    expect(await reader.locator('.dsh-pdf-mode-region').count()).toBe(0)
    await mainToolbar.locator('.dsh-pdf-tools > summary').click()
    await mainToolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    const status = reader.getByRole('region', { name: 'Explain passages' })
    await status.waitFor({ state: 'visible' })
    expect(await statusRail.locator('[data-status-id="region-selection"]').count()).toBe(0)
    await mainToolbar.locator('.dsh-pdf-tools > summary').click()
    expect(await mainToolbar.getByRole('button', { name: 'Note', exact: true }).isDisabled()).toBe(true)
    expect(await mainToolbar.getByRole('button', { name: 'Region screenshot' }).isDisabled()).toBe(true)
    await mainToolbar.locator('.dsh-pdf-tools > summary').click()
    expect(await status.getByRole('button', { name: 'Send for explanation' }).isDisabled()).toBe(true)
    const [toolbarBox, statusBox, railBox, contentBox, controlsBox] = await Promise.all([
      mainToolbar.boundingBox(), status.boundingBox(), statusRail.boundingBox(), reader.locator('.dsh-pdf-content').boundingBox(),
      reader.locator('.dsh-pdf-floating-controls').boundingBox(),
    ])
    expect(toolbarBox).not.toBeNull()
    expect(statusBox).not.toBeNull()
    expect(railBox).not.toBeNull()
    expect(contentBox).not.toBeNull()
    expect(controlsBox).not.toBeNull()
    expect(Math.abs(railBox!.x + railBox!.width - controlsBox!.x - controlsBox!.width)).toBeLessThanOrEqual(2)
    expect(statusBox!.x).toBeGreaterThanOrEqual(contentBox!.x + 11)
    expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(contentBox!.x + contentBox!.width - 11)
    if (controlsBox!.width > 800) {
      expect(Math.abs(statusBox!.y - toolbarBox!.y)).toBeLessThanOrEqual(2)
      expect(statusBox!.x).toBeGreaterThanOrEqual(toolbarBox!.x + toolbarBox!.width + 7)
    } else expect(statusBox!.y).toBeGreaterThanOrEqual(toolbarBox!.y + toolbarBox!.height + 7)
    if (process.env.DSH_PDF_FLOATING_PREVIEW_PATH) {
      await reader.screenshot({ path: process.env.DSH_PDF_FLOATING_PREVIEW_PATH.replace(/\.png$/, '-explanation.png') })
    }
    const content = reader.locator('.dsh-pdf-content')
    const originalContentStyle = await content.getAttribute('style')
    try {
      await content.evaluate(element => {
        const style = (element as HTMLElement).style
        style.flex = 'none'
        style.width = '1000px'
      })
      const [wideToolbar, wideStatus, wideContent] = await Promise.all([
        mainToolbar.boundingBox(), status.boundingBox(), content.boundingBox(),
      ])
      expect(wideContent!.width).toBe(1000)
      expect(Math.abs(wideStatus!.y - wideToolbar!.y)).toBeLessThanOrEqual(2)
      expect(wideStatus!.x).toBeGreaterThanOrEqual(wideToolbar!.x + wideToolbar!.width + 7)
      expect(wideStatus!.x + wideStatus!.width).toBeLessThanOrEqual(wideContent!.x + wideContent!.width - 11)
      const overflowingActions = await status.evaluate(element => {
        const card = element.getBoundingClientRect()
        return [...element.querySelectorAll('button')].filter(button => button.getBoundingClientRect().right > card.right + 1)
          .map(button => button.getAttribute('aria-label') ?? button.textContent?.trim())
      })
      expect(overflowingActions).toEqual([])
    } finally {
      await content.evaluate((element, style) => {
        if (style === null) element.removeAttribute('style')
        else element.setAttribute('style', style)
      }, originalContentStyle)
    }
    const selectFirstWordForExplanation = () => reader.evaluate(element => {
      const layer = element.querySelector('[data-pdf-page="1"] [data-pdf-text="active"]')
      const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
      const first = layer?.querySelector<HTMLElement>('span[data-pdf-run]')
      if (!first || !scroll) throw new Error('PDF text layer is not ready for explanation selection')
      const glyphs = [...layer!.querySelectorAll<HTMLElement>('span[data-pdf-run]')]
        .filter(span => span.dataset.pdfRun === first.dataset.pdfRun)
      if (!glyphs.map(span => span.textContent).join('').startsWith('Browser')) {
        throw new Error('The PDF test page needs a positioned initial word')
      }
      let offset = 7
      const endSpan = glyphs.find(span => {
        const length = span.textContent?.length ?? 0
        if (offset <= length) return true
        offset -= length
        return false
      })
      const start = glyphs[0]?.firstChild, end = endSpan?.firstChild
      if (!start || !end) throw new Error('PDF glyph text nodes are unavailable')
      const range = document.createRange()
      range.setStart(start, 0)
      range.setEnd(end, offset)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
    })
    await selectFirstWordForExplanation()

    const editor = reader.getByRole('dialog', { name: 'Ask about this passage' })
    await editor.waitFor({ state: 'visible', timeout: 10_000 })
    const passageQuestion = editor.getByRole('textbox')
    const saveQuestion = editor.getByRole('button', { name: 'Save', exact: true })
    if (process.env.PDF_EXPLANATION_SCREENSHOT) {
      await page.screenshot({ path: process.env.PDF_EXPLANATION_SCREENSHOT })
    }
    await expect.poll(() => page.evaluate(() => {
      const active = document.activeElement
      return active?.closest('.dsh-pdf-explanation-question-editor') ? 'question editor'
        : `${active?.tagName ?? 'none'} ${active?.getAttribute('class') ?? ''}`
    })).toBe('question editor')
    expect(await saveQuestion.isDisabled()).toBe(true)
    await passageQuestion.fill('  ')
    expect(await saveQuestion.isDisabled()).toBe(true)
    const preview = reader.locator('[data-pdf-explanation-preview]')
    await expect.poll(() => preview.count()).toBe(1)
    expect(await preview.first().evaluate(element => ({ tag: element.tagName, hidden: element.getAttribute('aria-hidden') })))
      .toEqual({ tag: 'SPAN', hidden: 'true' })
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(0)
    expect(await reader.getByRole('button', { name: 'Edit question for passage 1' }).count()).toBe(0)
    await passageQuestion.fill('Why is this passage important?')
    expect(await saveQuestion.isEnabled()).toBe(true)
    await saveQuestion.click()
    await editor.waitFor({ state: 'hidden' })
    await expect.poll(() => preview.count()).toBe(0)
    const marker = reader.getByRole('button', { name: 'Edit question for passage 1' })
    await marker.waitFor({ state: 'visible' })
    expect(await status.getByRole('button', { name: 'Send for explanation' }).isEnabled()).toBe(true)
    const marks = reader.locator('[data-pdf-explanation-mark]')
    await expect.poll(() => marks.count()).toBe(1)
    expect(await marks.first().evaluate(element => ({
      tag: element.tagName,
      visible: element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0,
      color: getComputedStyle(element).backgroundColor,
    }))).toMatchObject({ tag: 'DIV', visible: true })
    expect(await marks.first().evaluate(element => getComputedStyle(element).backgroundColor))
      .not.toBe('rgba(0, 0, 0, 0)')
    expect(await reader.locator('.dsh-pdf-explanation-overlay polygon').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-explanation-index').allTextContents()).toEqual(['1'])
    const [markBox, statusBoxAfterSave] = await Promise.all([marks.first().boundingBox(), status.boundingBox()])
    expect(markBox).not.toBeNull()
    expect(statusBoxAfterSave).not.toBeNull()
    await marker.click()
    await editor.waitFor({ state: 'visible' })
    expect(await editor.getByRole('textbox').inputValue()).toBe('Why is this passage important?')
    await expect.poll(() => editor.getByRole('textbox').evaluate(element => document.activeElement === element)).toBe(true)
    await editor.getByRole('textbox').fill(' ')
    expect(await editor.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    await editor.getByRole('textbox').fill('A discarded edit')
    await editor.getByRole('button', { name: 'Cancel' }).click()
    await marker.click()
    expect(await editor.getByRole('textbox').inputValue()).toBe('Why is this passage important?')
    await expect.poll(() => editor.getByRole('textbox').evaluate(element => document.activeElement === element)).toBe(true)
    await editor.getByRole('textbox').fill('Why is the revised passage important?')
    await expect.poll(() => editor.getByRole('textbox').inputValue()).toBe('Why is the revised passage important?')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await marker.click()
    await expect.poll(() => editor.getByRole('textbox').inputValue()).toBe('Why is the revised passage important?')
    await editor.getByRole('button', { name: /Delete|Remove passage/ }).click()
    await expect.poll(() => marks.count()).toBe(0)
    expect(await marker.count()).toBe(0)
    expect(await status.getByRole('button', { name: 'Send for explanation' }).isDisabled()).toBe(true)
    // Recreate a passage and send it through the ordinary Session prompt API.
    // This proves the browser action becomes a visible user turn, not merely a
    // local draft that disappears when the PDF tab closes.
    await selectFirstWordForExplanation()
    await editor.waitFor({ state: 'visible' })
    await editor.getByRole('textbox').fill('Explain this first word in context.')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => status.getByRole('button', { name: 'Send for explanation' }).isEnabled()).toBe(true)
    // A lost connection must keep the question as an editable draft and show
    // why the ordinary Session prompt could not be queued. The user can retry
    // after reconnecting rather than reconstructing the PDF selection.
    await page.context().setOffline(true)
    await status.getByRole('button', { name: 'Send for explanation' }).click()
    await status.getByRole('alert').waitFor({ state: 'visible', timeout: 10_000 })
    expect((await status.getByRole('alert').textContent())?.trim()).toBeTruthy()
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(1)
    await expect.poll(() => status.getByRole('button', { name: 'Send for explanation' }).isEnabled()).toBe(true)
    await page.context().setOffline(false)
    await status.getByRole('button', { name: 'Send for explanation' }).click()
    await status.waitFor({ state: 'hidden', timeout: 20_000 })
    await expect.poll(() => page.locator('[class*="centerCol"]')
      .getByText('Explain this first word in context.', { exact: false }).count(),
      { timeout: 20_000 }).toBeGreaterThan(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)

it('captures an explanation image on another page only after a vision model is selected', async () => {
  // The real replay adapter publishes image-input metadata without issuing a
  // model call; the question stays a draft until the user explicitly sends it.
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: ROOT, enabled: true }] },
    replayFixture: join(DSH_ROOT, 'apps/web/tests/fixtures/deepseek-model-label-1017/session.v4.jsonl'),
    replayProvidersOnly: true,
  })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-explanation-region-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF explanation image test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-explanation-region-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF explanation image test' }).click()
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
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    const status = reader.getByRole('region', { name: 'Explain passages' })
    const imageRegion = status.getByRole('button', { name: 'Select image region' })
    await status.waitFor({ state: 'visible' })
    // The seeded text-only model must not offer a screenshot it cannot read.
    await expect.poll(() => imageRegion.isDisabled()).toBe(true)
    await status.getByRole('button', { name: 'Exit explanation mode' }).click()
    await status.waitFor({ state: 'hidden' })
    const selection = await scaffold.ctx.sessionController.selectModel({ sessionId,
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    expect(selection).toMatchObject({ selected: { model: 'deepseek-v4-flash-vision-exp' } })
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    await status.waitFor({ state: 'visible' })
    await expect.poll(() => imageRegion.isEnabled()).toBe(true)

    // Area selection is a reversible mode; cancelling it must leave the
    // explanation draft available for the next actual region selection.
    await imageRegion.click()
    await expect.poll(() => status.getByRole('button', { name: 'Cancel region selection' }).getAttribute('aria-pressed')).toBe('true')
    await status.getByRole('button', { name: 'Cancel region selection' }).click()
    await expect.poll(() => imageRegion.getAttribute('aria-pressed')).toBe('false')

    const secondPage = reader.locator('[data-pdf-page="2"]')
    await secondPage.scrollIntoViewIfNeeded()
    await secondPage.locator('canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await imageRegion.click()
    await reader.locator('.dsh-pdf-mode-region[data-pdf-page="2"]').waitFor({ state: 'visible' })
    const box = await secondPage.boundingBox()
    const bar = await toolbar.boundingBox()
    if (!box || !bar) throw new Error('The second PDF page is not available for region selection')
    const start = { x: box.x + 52, y: Math.max(box.y + 125, bar.y + bar.height + 18) }
    const end = { x: Math.min(box.x + box.width - 20, start.x + 180),
      y: Math.min(box.y + box.height - 20, start.y + 75) }
    expect(end.y - start.y).toBeGreaterThan(20)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 8 })
    await page.mouse.up()

    const editor = reader.getByRole('dialog', { name: 'Ask about this passage' })
    await editor.waitFor({ state: 'visible', timeout: 10_000 })
    const save = editor.getByRole('button', { name: 'Save', exact: true })
    expect(await save.isDisabled()).toBe(true)
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(0)
    await editor.getByRole('textbox').fill('What does this part of the second page show?')
    await save.click()
    await editor.waitFor({ state: 'hidden', timeout: 20_000 })
    const regionMark = secondPage.locator('[data-pdf-explanation-mark][data-pdf-explanation-kind="region"]')
    await regionMark.waitFor({ state: 'visible' })
    expect(await status.getByRole('button', { name: 'Send for explanation' }).isEnabled()).toBe(true)
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(1)
    // Reloading the source creates a new document content version. Its saved
    // explanation question must not be offered against the replacement view.
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Reload source' }).click()
    await status.waitFor({ state: 'hidden', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-explanation-mark]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)

it('stops accepting explanation passages and image regions at the visible item limit', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: ROOT, enabled: true }] },
    replayFixture: join(DSH_ROOT, 'apps/web/tests/fixtures/deepseek-model-label-1017/session.v4.jsonl'),
    replayProvidersOnly: true,
  })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-explanation-limit-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF explanation limit test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())
    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-explanation-limit-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF explanation limit test' }).click()
    const column = page.locator('[data-rightbar-col]')
    if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] [data-pdf-text="active"]').waitFor({ state: 'visible', timeout: 20_000 })
    const selection = await scaffold.ctx.sessionController.selectModel({ sessionId,
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    expect(selection).toMatchObject({ selected: { model: 'deepseek-v4-flash-vision-exp' } })
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    const status = reader.getByRole('region', { name: 'Explain passages' })
    await status.waitFor({ state: 'visible' })
    const editor = reader.getByRole('dialog', { name: 'Ask about this passage' })
    const selectPassage = () => reader.evaluate(element => {
      const layer = element.querySelector('[data-pdf-page="1"] [data-pdf-text="active"]')
      const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
      const first = layer?.querySelector<HTMLElement>('span[data-pdf-run]')
      if (!first || !scroll) throw new Error('PDF passage is not available for selection')
      const glyphs = [...layer!.querySelectorAll<HTMLElement>('span[data-pdf-run]')]
        .filter(span => span.dataset.pdfRun === first.dataset.pdfRun)
      let offset = 7
      const last = glyphs.find(span => {
        const length = span.textContent?.length ?? 0
        if (offset <= length) return true
        offset -= length
        return false
      })
      if (!glyphs[0]?.firstChild || !last?.firstChild) throw new Error('PDF passage glyphs are unavailable')
      const range = document.createRange()
      range.setStart(glyphs[0].firstChild, 0)
      range.setEnd(last.firstChild, offset)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
    })
    for (let index = 1; index <= 20; index++) {
      await selectPassage()
      await editor.waitFor({ state: 'visible' })
      await editor.getByRole('textbox').fill(`Question ${index} about the same passage?`)
      await editor.getByRole('button', { name: 'Save', exact: true }).click()
      await editor.waitFor({ state: 'hidden' })
      await expect.poll(() => status.locator('.dsh-pdf-explanation-status-count').textContent()).toBe(`${index}/20`)
    }
    await expect.poll(() => status.getByRole('button', { name: 'Select image region' }).isEnabled()).toBe(true)
    await selectPassage()
    await expect.poll(() => status.getByRole('alert').textContent())
      .toContain('Up to 20 passages or regions can be explained together.')
    expect(await editor.count()).toBe(0)
    await status.getByRole('button', { name: 'Select image region' }).click()
    await expect.poll(() => reader.locator('.dsh-pdf-mode-region').count()).toBe(0)
    expect(await status.locator('.dsh-pdf-explanation-status-count').textContent()).toBe('20/20')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)

it('recognizes the current PDF page through Host OCR and searches its page-level transcript', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: ROOT, enabled: true }] },
    replayFixture: join(DSH_ROOT, 'apps/web/tests/fixtures/deepseek-model-label-1017/session.v4.jsonl'),
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
      yield { type: 'text-delta', index: 0, text: 'Quartz OCR proof on page one.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-ocr-transcript-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    const recognizePage = toolbar.getByRole('button', { name: 'OCR page' })
    await expect.poll(() => recognizePage.isEnabled(), { timeout: 10_000 }).toBe(true)
    await recognizePage.click()
    await expect.poll(() => reader.locator('.dsh-pdf-ocr-transcript').textContent(), { timeout: 20_000 })
      .toBe('Quartz OCR proof on page one.')
    expect(modelCalls).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp',
      sessionId, mediaType: 'image/png' }])
    expect(await reader.locator('.dsh-pdf-ocr-meta').innerText()).toContain('Page 1')

    await reader.getByRole('tab', { name: 'Search', exact: true }).click()
    const search = reader.locator('.dsh-pdf-search-panel')
    await search.getByRole('textbox', { name: 'Search' }).fill('Quartz OCR proof')
    await search.getByRole('button', { name: 'Search', exact: true }).click()
    const hit = search.locator('.dsh-pdf-search-hit')
    await expect.poll(() => hit.count(), { timeout: 10_000 }).toBe(1)
    expect(await hit.innerText()).toContain('OCR transcript · page-level match')
    expect(await hit.innerText()).toContain('Quartz OCR proof')
    await hit.click()
    holdNextOcr = true
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await recognizePage.click()
    await expect.poll(() => modelCalls.length).toBe(2)
    const ocrStatus = reader.locator('[data-status-id="ocr"]')
    await ocrStatus.waitFor({ state: 'visible' })
    await ocrStatus.getByRole('button', { name: 'Cancel' }).click()
    await ocrStatus.waitFor({ state: 'hidden', timeout: 10_000 })
    expect(await reader.locator('.dsh-pdf-ocr-transcript').textContent()).toBe('Quartz OCR proof on page one.')
    holdNextOcr = false
    failNextOcr = true
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await recognizePage.click()
    const ocrError = reader.locator('.dsh-pdf-error[role="alert"]')
    await expect.poll(() => ocrError.textContent()).toContain('request or usage limit')
    expect(await reader.locator('.dsh-pdf-ocr-transcript').textContent()).toBe('Quartz OCR proof on page one.')
    await ocrError.getByRole('button', { name: 'Dismiss' }).click()
    await ocrError.waitFor({ state: 'hidden' })
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)

it('keeps all PDF sidebar sections aligned and usable at the minimum width', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-sidebar-style-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF sidebar style test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'pdf-sidebar-style-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF sidebar style test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const sidebarMaterial = await sidebar.evaluate(element => {
      const style = getComputedStyle(element.querySelector('.dsh-pdf-sidebar-shell')!)
      const position = getComputedStyle(element)
      const heading = element.querySelector('.dsh-pdf-panel-heading')!
      const footer = element.querySelector('.dsh-pdf-sidebar-footer')!
      return { backgroundImage: style.backgroundImage, backgroundColor: style.backgroundColor,
        backdropFilter: style.backdropFilter, position: position.position,
        top: position.top, right: position.right, bottom: position.bottom,
        borderRadius: style.borderRadius, boxShadow: style.boxShadow,
        heading: getComputedStyle(heading).backgroundColor,
        footer: getComputedStyle(footer).backgroundColor }
    })
    expect(sidebarMaterial.backgroundImage).toContain('linear-gradient')
    expect(sidebarMaterial.backdropFilter).toContain('blur(24px)')
    expect(sidebarMaterial.position).toBe('absolute')
    expect(sidebarMaterial.top).toBe('64px')
    expect(sidebarMaterial.right).toBe('12px')
    expect(sidebarMaterial.bottom).toBe(sidebarMaterial.top)
    expect(sidebarMaterial.borderRadius).toBe('16px')
    expect(sidebarMaterial.boxShadow).not.toBe('none')
    expect(sidebarMaterial.heading).toBe('rgba(0, 0, 0, 0)')
    expect(sidebarMaterial.footer).toBe('rgba(0, 0, 0, 0)')
    await page.emulateMedia({ contrast: 'more' })
    expect(await sidebar.evaluate(element => getComputedStyle(element.querySelector('.dsh-pdf-sidebar-shell')!).backdropFilter)).toBe('none')
    expect(await sidebar.evaluate(element => getComputedStyle(element.querySelector('.dsh-pdf-sidebar-shell')!).backgroundImage)).toBe('none')
    expect(await sidebar.evaluate(element => getComputedStyle(element.querySelector('.dsh-pdf-sidebar-shell')!).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    await page.emulateMedia({ contrast: 'no-preference' })
    const sections = ['Pages', 'Bookmarks', 'Annotations', 'Search', 'Translation', 'OCR'] as const
    let baseline: { top: number; left: number; height: number; fontSize: string; footerTop: number } | undefined
    for (const name of sections) {
      await reader.getByRole('tab', { name, exact: true }).click()
      const panel = reader.locator('.dsh-pdf-sidebar-panel:not([hidden])')
      const heading = panel.locator('.dsh-pdf-panel-heading').first()
      await heading.waitFor({ state: 'visible' })
      await expect.poll(() => heading.evaluate(element =>
        Math.abs(new DOMMatrix(getComputedStyle(element).transform).m41))).toBeLessThan(0.1)
      const geometry = await heading.evaluate(element => {
        const panel = element.closest('.dsh-pdf-sidebar-panel')!.getBoundingClientRect()
        const title = element.querySelector('h3')!
        const header = element.getBoundingClientRect()
        return { top: header.top - panel.top, left: title.getBoundingClientRect().left - panel.left,
          height: header.height, fontSize: getComputedStyle(title).fontSize,
          footerTop: element.closest('.dsh-pdf-sidebar')!.querySelector('.dsh-pdf-sidebar-footer')!.getBoundingClientRect().top }
      })
      if (baseline) {
        expect(Math.abs(geometry.top - baseline.top), `${name} heading top`).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.left - baseline.left), `${name} heading inset`).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.height - baseline.height), `${name} heading height`).toBeLessThanOrEqual(1)
        expect(geometry.fontSize, `${name} heading font`).toBe(baseline.fontSize)
        expect(Math.abs(geometry.footerTop - baseline.footerTop), `${name} footer position`).toBeLessThanOrEqual(1)
      } else baseline = geometry
      if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
        await sidebar.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, `${name.toLowerCase()}.png`) })
      }
    }

    await reader.getByRole('tab', { name: 'Bookmarks' }).click()
    if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
      await reader.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'reader-bookmarks.png') })
    }
    const [toolbarBounds, sidebarBounds] = await Promise.all([
      reader.locator('.dsh-pdf-main-toolbar').boundingBox(), sidebar.boundingBox(),
    ])
    expect(toolbarBounds).not.toBeNull()
    expect(sidebarBounds).not.toBeNull()
    const sampleMaterial = async (x: number, y: number): Promise<number[]> => {
      const png = await page.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } })
      return page.evaluate(async bytes => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(bitmap, 0, 0)
        const color = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
        bitmap.close()
        return color
      }, [...png])
    }
    const [toolbarTint, sidebarTint] = await Promise.all([
      sampleMaterial(toolbarBounds!.x + 45, toolbarBounds!.y + toolbarBounds!.height - 12),
      sampleMaterial(sidebarBounds!.x + sidebarBounds!.width / 2, sidebarBounds!.y + sidebarBounds!.height / 2),
    ])
    expect(Math.max(...toolbarTint.map((channel, index) => Math.abs(channel - sidebarTint[index]))),
      JSON.stringify({ toolbarTint, sidebarTint })).toBeLessThanOrEqual(4)
    expect(await reader.getByRole('button', { name: 'Bookmark current location' })
      .evaluate(element => getComputedStyle(element).borderRadius)).toBe('6px')
    await reader.getByRole('tab', { name: 'Annotations' }).click()
    const filter = reader.getByRole('combobox', { name: 'Filter annotations' })
    expect(await filter.evaluate(element => getComputedStyle(element).borderRadius)).toBe('6px')
    await sidebar.evaluate(element => { (element as HTMLElement).style.width = '220px' })
    const annotationBounds = await reader.locator('.dsh-pdf-annotations-heading').evaluate(element => {
      const title = element.querySelector('h3')!.getBoundingClientRect()
      const control = element.querySelector('select')!.getBoundingClientRect()
      const heading = element.getBoundingClientRect()
      return { titleRight: title.right, controlLeft: control.left, controlRight: control.right, headingRight: heading.right }
    })
    expect(annotationBounds.titleRight).toBeLessThanOrEqual(annotationBounds.controlLeft)
    expect(annotationBounds.controlRight).toBeLessThanOrEqual(annotationBounds.headingRight - 11)
    await sidebar.evaluate(element => { (element as HTMLElement).style.width = '' })

    await reader.getByRole('tab', { name: 'Search' }).click()
    const searchPanel = reader.locator('.dsh-pdf-search-panel')
    expect(await searchPanel.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    const [searchPanelBox, searchInputBox, searchButtonBox] = await Promise.all([
      searchPanel.boundingBox(), searchPanel.locator('form input').boundingBox(), searchPanel.locator('form button').boundingBox(),
    ])
    expect(searchPanelBox).not.toBeNull()
    expect(searchInputBox).not.toBeNull()
    expect(searchButtonBox).not.toBeNull()
    expect(Math.abs(searchInputBox!.y + searchInputBox!.height / 2 - searchButtonBox!.y - searchButtonBox!.height / 2)).toBeLessThanOrEqual(1)
    expect(searchInputBox!.x + searchInputBox!.width).toBeLessThan(searchButtonBox!.x)
    expect(searchButtonBox!.x + searchButtonBox!.width).toBeLessThanOrEqual(searchPanelBox!.x + searchPanelBox!.width)
    expect(await searchPanel.locator('form input').evaluate(element => getComputedStyle(element).borderRadius)).toBe('6px')
    expect(await searchPanel.locator('form button').evaluate(element => getComputedStyle(element).borderRadius)).toBe('6px')

    // The heading belongs to the fixed panel shell, not the scrolling results.
    // A narrow, short viewport reproduces the overlap seen after scrolling hits.
    await sidebar.evaluate(element => { (element as HTMLElement).style.width = '220px' })
    const searchScroll = searchPanel.locator(':scope > .dsh-pdf-panel-scroll')
    const searchHeading = searchPanel.locator(':scope > .dsh-pdf-panel-heading')
    await searchPanel.locator('form input').fill('Browser')
    await searchPanel.locator('form button').click()
    await expect.poll(() => searchPanel.locator('.dsh-pdf-search-hit').count()).toBe(2)
    // A second query on the same native PDF reuses the per-page text index.
    // A definite miss must not leave stale hits, and repeating the original
    // query must still return the correct positioned results.
    await searchPanel.locator('form input').fill('not-in-this-pdf')
    await searchPanel.locator('form button').click()
    await expect.poll(() => searchPanel.getByText('No matching text in the available text layers.', { exact: true }).count()).toBe(1)
    expect(await searchPanel.locator('.dsh-pdf-search-hit').count()).toBe(0)
    await searchPanel.locator('form input').fill('Browser')
    await searchPanel.locator('form button').click()
    await expect.poll(() => searchPanel.locator('.dsh-pdf-search-hit').count()).toBe(2)
    const headingBeforeScroll = await searchHeading.boundingBox()
    await searchScroll.evaluate(element => {
      const scroll = element as HTMLElement
      scroll.style.height = '170px'
      scroll.scrollTop = scroll.scrollHeight
    })
    await expect.poll(() => searchScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    const [headingAfterScroll, scrollAfterScroll, lastHit] = await Promise.all([
      searchHeading.boundingBox(), searchScroll.boundingBox(), searchPanel.locator('.dsh-pdf-search-hit').last().boundingBox(),
    ])
    expect(headingBeforeScroll).not.toBeNull()
    expect(headingAfterScroll).not.toBeNull()
    expect(scrollAfterScroll).not.toBeNull()
    expect(lastHit).not.toBeNull()
    expect(Math.abs(headingAfterScroll!.y - headingBeforeScroll!.y)).toBeLessThanOrEqual(1)
    expect(scrollAfterScroll!.y).toBeGreaterThanOrEqual(headingAfterScroll!.y + headingAfterScroll!.height - 1)
    expect(lastHit!.y).toBeGreaterThanOrEqual(scrollAfterScroll!.y - 1)
    expect(lastHit!.x).toBeGreaterThanOrEqual(scrollAfterScroll!.x - 1)
    expect(lastHit!.x + lastHit!.width).toBeLessThanOrEqual(scrollAfterScroll!.x + scrollAfterScroll!.width + 1)
    expect(await searchScroll.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
      await sidebar.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'search-narrow-scrolled.png') })
    }
    await sidebar.evaluate(element => { (element as HTMLElement).style.width = '' })

    const toggle = sidebar.locator('.dsh-pdf-sidebar-toggle')
    const main = sidebar.locator('.dsh-pdf-sidebar-main')
    const motion = await sidebar.evaluate(element => ({
      sidebar: getComputedStyle(element).transitionProperty,
      shell: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-shell')!).transitionProperty,
      content: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-main')!).transitionProperty,
      panels: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-panels')!).transitionProperty,
      footer: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-footer')!).transitionProperty,
      arrow: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-toggle svg')!).transitionProperty,
    }))
    expect(motion.sidebar).not.toContain('width')
    expect(motion.shell).toContain('clip-path')
    expect(motion.content).toContain('opacity')
    expect(motion.panels).toContain('transform')
    expect(motion.footer).toContain('transform')
    expect(motion.arrow).toContain('transform')
    await toggle.click()
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await main.getAttribute('aria-hidden')).toBe('true')
    expect(await main.evaluate(element => (element as HTMLElement).inert)).toBe(true)
    expect(await sidebar.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(55)
    await expect.poll(() => sidebar.evaluate(element => getComputedStyle(element.querySelector('.dsh-pdf-sidebar-shell')!).clipPath))
      .toContain('44px')
    const compact = sidebar.locator('.dsh-pdf-sidebar-compact-nav')
    expect(await compact.getAttribute('aria-hidden')).toBe('false')
    expect(await compact.evaluate(element => (element as HTMLElement).inert)).toBe(false)
    await toggle.click()
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await main.evaluate(element => (element as HTMLElement).inert)).toBe(false)
    expect(await compact.evaluate(element => (element as HTMLElement).inert)).toBe(true)
    await expect.poll(() => main.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await sidebar.locator('.dsh-pdf-sidebar-shell').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    expect(await sidebar.locator('.dsh-pdf-sidebar-panels').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    expect(await toggle.locator('svg').evaluate(element => getComputedStyle(element).transitionProperty)).toBe('none')
    const setReaderWidth = async (width: number) => {
      await reader.evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px` }, width)
      await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(width)
      await reader.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    }
    await setReaderWidth(960)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await setReaderWidth(700)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    await setReaderWidth(960)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)

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
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
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
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
      await pdfPage.click({ position: { x: 100, y: 62 } })
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
    await reader.locator('[data-status-id="save"][data-kind="saved"]').waitFor({ state: 'visible' })
    await expect.poll(() => save.isDisabled()).toBe(true)

    const savedDocument = await loadPdfDocument(await readFile(join(scaffold.workspaceCwd, filename)))
    const savedPosition = savedDocument.annotations.find(annotation => annotation.subtype === 'Highlight')?.commentPosition
    expect(savedPosition?.length).toBe(2)
    expect(savedPosition?.every(Number.isFinite)).toBe(true)

    // Reopen from disk: the external root, nested reply relation, edit and
    // deletion all survive a real saved-file round trip. A full client reload
    // discards every Client-side annotation draft; only the saved PDF remains.
    await page.reload({ waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF external thread test' }).click()
    if (!await reader.isVisible()) await openFile()
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await chooseZoom(reader, '100%')
    await openThread()
    await expect.poll(async () => {
      const reopened = await card.boundingBox()
      return reopened && Math.abs(reopened.x - cardAfterMove!.x)
    }, { timeout: 5_000 }).toBeLessThanOrEqual(2)
    await expect.poll(async () => {
      const reopened = await card.boundingBox()
      return reopened && Math.abs(reopened.y - cardAfterMove!.y)
    }, { timeout: 5_000 }).toBeLessThanOrEqual(2)
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

it('keeps page numbers in the sidebar and a 16px gap between PDF pages', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-page-spacing-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF page spacing test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('treeitem').filter({ hasText: 'PDF page spacing test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.locator('[data-pdf-page="2"]').waitFor({ state: 'attached', timeout: 20_000 })
    expect(await reader.locator('.dsh-pdf-page-label').count()).toBe(0)
    await expect.poll(() => reader.evaluate(element => {
      const first = element.querySelector<HTMLElement>('[data-pdf-page="1"]')?.getBoundingClientRect()
      const second = element.querySelector<HTMLElement>('[data-pdf-page="2"]')?.getBoundingClientRect()
      return first && second ? second.top - first.bottom : null
    })).toBeCloseTo(16, 1)
    await reader.getByRole('tab', { name: 'Pages' }).click()
    await reader.getByRole('button', { name: 'Page 2 / 2' }).waitFor({ state: 'visible' })
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('routes a recorded PDF evidence card through the real session Slot, Host check, and visible Reader', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  let restoreRead: (() => void) | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-evidence-slot-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF evidence Slot test' })
    const path = join(scaffold.workspaceCwd, 'reader-evidence-slot-e2e.pdf')
    await writeFile(path, await sourcePdf())
    const resolved = await scaffold.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const service = scaffold.ctx.get('pdf') as {
      dispatch(sessionId: string, input: Record<string, unknown>, agent: typeof resolved.agent,
        signal: AbortSignal): Promise<unknown>
      readPageText(sessionId: string, documentId: string, page: number, signal: AbortSignal):
        Promise<{ content: { items: Parameters<typeof joinPageText>[0] } }>
    } | undefined
    expect(service).toBeDefined()
    const signal = new AbortController().signal
    const address = `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path.split('/').map(encodeURIComponent).join('/')}`
    const opened = await service!.dispatch(sessionId, { action: 'open', sessionId, address }, resolved.agent, signal) as {
      id: string; path: string; sourceVersion: string; contentVersion: string; revision: number;
      reader: { bytesHash: string }
    }
    const text = joinPageText((await service!.readPageText(sessionId, opened.id, 2, signal)).content.items)
    expect(text).toContain('Browser PDF page two')
    const valid = readPagePresentationMeta({ documentId: opened.id, path: opened.path, page: 2,
      sourceDigest: opened.reader.bytesHash, sourceVersion: opened.sourceVersion,
      pageTextDigest: evidenceSha256(text), contentVersion: opened.contentVersion,
      revision: opened.revision, text, offset: 0, nextOffset: null, totalChars: text.length, status: 'ok' })
    const entries = [
      { id: ToolCallId('pdf-evidence-slot-stale'), meta: { ...valid, pageTextDigest: evidenceSha256('stale page') } },
      { id: ToolCallId('pdf-evidence-slot-valid'), meta: valid },
    ]
    const session = resolved.agent.session
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Show the cited PDF page.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', { turn: 2, step: 1, stream: [],
      message: createAssistantMessage({
        content: entries.map(entry => ({ type: 'tool-call' as const, id: entry.id,
          name: 'pdf_read_page', arguments: JSON.stringify({ documentId: opened.id, page: 2 }) })),
        source: { provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    for (const entry of entries) {
      const args = JSON.stringify({ documentId: opened.id, page: 2 })
      const call = session.append('tool/call', { turn: 2, step: 1, callId: entry.id,
        name: 'pdf_read_page', arguments: args })
      session.append('tool/result', { turn: 2, step: 1, meta: entry.meta,
        message: createToolResultMessage({ callId: entry.id,
          content: [{ type: 'text', text }], isError: false }),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(session)

    let validationReads = 0
    const originalRead = service!.readPageText
    service!.readPageText = async (...args) => { validationReads++; return originalRead(...args) }
    restoreRead = () => { service!.readPageText = originalRead }

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-evidence-slot-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF evidence Slot test' }).click()
    const staleCard = page.locator(`[data-chat-call-id="${entries[0]!.id}"] .pdf-evidence-card`)
    const validCard = page.locator(`[data-chat-call-id="${entries[1]!.id}"] .pdf-evidence-card`)
    await staleCard.waitFor({ state: 'attached' })
    await expandOwningTurnProcess(page, staleCard)
    await staleCard.waitFor({ state: 'visible' })
    await validCard.waitFor({ state: 'visible' })
    expect(await staleCard.locator('.pdf-evidence-card-header strong').textContent()).toBe('PDF page read')
    const staleOpen = staleCard.locator('.pdf-evidence-card-entry button')
    const validOpen = validCard.locator('.pdf-evidence-card-entry button')
    expect(await staleOpen.count(), await staleCard.ariaSnapshot()).toBe(1)
    expect(await staleOpen.textContent()).toBe('Go to page')
    expect(await staleOpen.isDisabled()).toBe(true)

    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: 'reader-evidence-slot-e2e.pdf' }).click()
    const reader = page.locator('.dsh-pdf-reader')
    const pageInput = reader.locator('.dsh-pdf-page-input:visible').first()
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => pageInput.inputValue()).toBe('1')
    await expect.poll(() => staleOpen.isEnabled()).toBe(true)
    await staleOpen.click()
    await staleCard.locator('.pdf-evidence-card-notice').waitFor()
    expect(validationReads).toBeGreaterThanOrEqual(1)
    expect(await pageInput.inputValue()).toBe('1')

    await validOpen.click()
    await expect.poll(() => pageInput.inputValue()).toBe('2')
    await expect.poll(() => reader.locator('[data-pdf-page="2"] [data-pdf-text="active"]').textContent())
      .toContain('Browser PDF page two')
    expect(validationReads).toBeGreaterThanOrEqual(2)

    const related = await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('pdf-find-related-web-e2e'),
      name: 'pdf_find_related',
      arguments: { documentId: opened.id, query: 'Which browser PDF page is the second one?',
        terms: ['Browser PDF page two'], maxPages: 2 },
      agent: resolved.agent,
    })
    expect(related.isError).toBe(false)
    expect(related.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain('Browser PDF page two')
    const annotation = await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('pdf-mark-related-web-e2e'),
      name: 'pdf_annotate',
      arguments: { documentId: opened.id, expectedRevision: opened.revision,
        subtype: 'Highlight', target: { kind: 'pdf-text', page: 2, quote: 'Browser PDF page two' } },
      agent: resolved.agent,
    })
    expect(annotation.isError).toBe(false)
    await expect.poll(() => reader.locator('[data-pdf-page="2"] .dsh-pdf-annotation-overlay path').count())
      .toBeGreaterThan(0)

    // An annotation changes the working-copy revision. Navigation must still
    // accept the unchanged page-content version and preserve Reader history.
    const navigation = await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('pdf-agent-navigate-web-e2e'),
      name: 'pdf_navigate',
      arguments: { documentId: opened.id, page: 1, contentVersion: opened.contentVersion },
      agent: resolved.agent,
    })
    expect(navigation.isError).toBe(false)
    await expect.poll(() => pageInput.inputValue()).toBe('1')
    await reader.getByRole('button', { name: 'Back', exact: true }).click()
    await expect.poll(() => pageInput.inputValue()).toBe('2')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    restoreRead?.()
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

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
    // OCR availability is now determined by the Host for the active session,
    // rather than a user-facing toggle in PDF settings.
    expect(await ocrSwitch.count()).toBe(0)
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
    await expect.poll(() => pagesHeading.evaluate(element =>
      new DOMMatrix(getComputedStyle(element.parentElement!).transform).m41)).toBe(0)
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
    const bookmarkInfo = reader.locator('.dsh-pdf-bookmark-info')
    expect(await bookmarkInfo.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false)
    await bookmarkInfo.locator('summary').click()
    await bookmarkInfo.getByText('Saved by this plugin; not embedded in the PDF.').waitFor({ state: 'visible' })
    await bookmarkInfo.locator('summary').click()
    await reader.getByRole('button', { name: 'Bookmark current location' }).click()
    await reader.getByRole('textbox', { name: 'Bookmark name' }).fill('Browser test bookmark')
    await reader.getByRole('button', { name: 'Add', exact: true }).click()
    await reader.getByRole('button', { name: 'Browser test bookmark', exact: true }).waitFor({ state: 'visible' })
    await reader.getByRole('button', { name: 'More bookmark actions: Browser test bookmark' }).click()
    await reader.getByRole('button', { name: 'Delete bookmark: Browser test bookmark' }).click()
    await reader.getByRole('button', { name: 'Delete?', exact: true }).click()
    await reader.getByText('No personal bookmarks yet.', { exact: true }).waitFor({ state: 'visible' })
    await reader.getByRole('tab', { name: 'Annotations' }).click()
    expect(await reader.getByRole('tab', { name: 'Notes', exact: true }).count()).toBe(0)
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const save = toolbar.getByRole('button', { name: 'Save', exact: true })
    const content = reader.locator('.dsh-pdf-content')
    const [toolbarBox, contentBox, controlsBox] = await Promise.all([
      toolbar.boundingBox(), content.boundingBox(), reader.locator('.dsh-pdf-floating-controls').boundingBox(),
    ])
    expect(toolbarBox).not.toBeNull()
    expect(contentBox).not.toBeNull()
    expect(controlsBox).not.toBeNull()
    expect(Math.abs(toolbarBox!.x + toolbarBox!.width / 2 - controlsBox!.x - controlsBox!.width / 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(toolbarBox!.y - contentBox!.y - 12)).toBeLessThanOrEqual(2)
    expect(toolbarBox!.x).toBeGreaterThanOrEqual(contentBox!.x + 11)
    expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(contentBox!.x + contentBox!.width - 11)
    const firstPageBox = await reader.locator('[data-pdf-page="1"]').boundingBox()
    expect(firstPageBox).not.toBeNull()
    // The toolbar floats independently of document scroll and page centering.
    // Verify that the page remains in the reading area without coupling its y
    // coordinate to the toolbar's overlay position.
    expect(firstPageBox!.y + firstPageBox!.height).toBeGreaterThan(contentBox!.y)
    expect(firstPageBox!.y).toBeLessThan(contentBox!.y + contentBox!.height)
    const material = await toolbar.evaluate(element => {
      const surface = getComputedStyle(element, '::before')
      return { backgroundImage: surface.backgroundImage, backdropFilter: surface.backdropFilter,
        containerBackdropFilter: getComputedStyle(element).backdropFilter }
    })
    expect(material.backgroundImage).toContain('linear-gradient')
    expect(material.backdropFilter).toContain('blur(14px)')
    expect(material.containerBackdropFilter).toBe('none')
    await page.emulateMedia({ contrast: 'more' })
    expect(await toolbar.evaluate(element => getComputedStyle(element, '::before').backdropFilter)).toBe('none')
    await page.emulateMedia({ contrast: 'no-preference' })
    expect(await toolbar.locator('.dsh-pdf-tools > summary').evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap')
    const zoomTrigger = toolbar.locator('.dsh-pdf-toolbar-zoom')
    const zoomControl = zoomTrigger.locator('summary')
    expect(await zoomControl.locator('svg').count()).toBe(1)
    expect(await zoomControl.getAttribute('aria-label')).toBe('Zoom: Fit width')
    const zoomIdleBackground = await zoomTrigger.evaluate(element => getComputedStyle(element).backgroundColor)
    await zoomControl.hover()
    const zoomHoverBackground = await zoomTrigger.evaluate(element => getComputedStyle(element).backgroundColor)
    expect(zoomHoverBackground).not.toBe(zoomIdleBackground)
    expect(await zoomControl.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    await zoomControl.click()
    const zoomMenu = zoomTrigger.locator('.dsh-pdf-zoom-menu')
    expect(await zoomMenu.getByRole('button', { name: 'Fit width' }).getAttribute('aria-pressed')).toBe('true')
    expect(await zoomMenu.getByRole('button', { name: 'Fit page' }).count()).toBe(1)
    await page.mouse.move(0, 0)
    expect(await zoomTrigger.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(zoomHoverBackground)
    const [zoomMenuBox, zoomToolbarBox] = await Promise.all([zoomMenu.boundingBox(), toolbar.boundingBox()])
    expect(zoomMenuBox).not.toBeNull()
    expect(zoomToolbarBox).not.toBeNull()
    expect(zoomMenuBox!.y + zoomMenuBox!.height).toBeGreaterThan(zoomToolbarBox!.y + zoomToolbarBox!.height)
    expect(await zoomMenu.getByRole('button', { name: '100%' }).evaluate(element => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
    })).toBe(true)
    await zoomMenu.getByRole('button', { name: '100%' }).click()
    expect(await zoomMenu.isVisible()).toBe(false)
    expect(await zoomControl.getAttribute('aria-label')).toBe('Zoom: 100%')
    // The arrow marks the disclosure the way Tools does: it is not a second
    // control, and it still belongs to the one click target that opens the menu.
    const zoomArrow = zoomControl.locator('.dsh-pdf-zoom-chevron')
    expect(await zoomArrow.count()).toBe(1)
    expect(await zoomArrow.evaluate(element => element.parentElement?.tagName)).toBe('SUMMARY')
    expect(await toolbar.locator('.dsh-pdf-toolbar-zoom button.dsh-pdf-zoom-chevron').count()).toBe(0)
    expect((await zoomArrow.boundingBox())!.width).toBeGreaterThan(2)
    await zoomArrow.click()
    expect(await zoomMenu.isVisible()).toBe(true)
    await zoomControl.click()
    expect(await zoomMenu.isVisible()).toBe(false)
    await chooseZoom(reader, 'Fit width')
    expect(await zoomControl.getAttribute('aria-label')).toBe('Zoom: Fit width')
    await reader.evaluate(element => { element.style.maxHeight = '220px' })
    await zoomControl.click()
    await expect.poll(() => zoomMenu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const [shortMenu, shortReader] = await Promise.all([zoomMenu.boundingBox(), reader.boundingBox()])
    expect(shortMenu).not.toBeNull()
    expect(shortReader).not.toBeNull()
    expect(shortMenu!.y + shortMenu!.height).toBeLessThanOrEqual(shortReader!.y + shortReader!.height + 1)
    await zoomMenu.getByRole('button', { name: '300%' }).click()
    expect(await zoomControl.getAttribute('aria-label')).toBe('Zoom: 300%')
    await chooseZoom(reader, 'Fit width')
    await reader.evaluate(element => { element.style.maxHeight = '' })
    await page.mouse.move(0, 0)
    const saveFeedback = reader.locator('.dsh-pdf-save-feedback')
    expect(await saveFeedback.count()).toBe(0)
    expect(await save.isDisabled()).toBe(true)
    // This tab can mount below the responsive threshold. The wide-reader
    // scenario below owns the exact toolbar snapshot; here verify semantics.
    await expectIconOnlyMainToolbar(toolbar)

    // The desktop Mac shell uses this platform CSS and Electron app regions.
    // Chromium here verifies the selectable text layer and deferred selection
    // capture through the installed plugin; native macOS remains a separate check.
    await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin' })
    const textSpan = reader.locator('[data-pdf-page="1"] .dsh-pdf-text-layer span[data-pdf-run]').first()
    await textSpan.waitFor({ state: 'visible' })
    // Earlier bookmark/zoom actions can leave the first line underneath the
    // floating toolbar. Move the reading viewport to the page start before a
    // real pointer drag, as a user would do to select that line.
    const selectionScroll = reader.locator('.dsh-pdf-scroll')
    await selectionScroll.evaluate(element => { element.scrollTo({ top: 0, left: 0, behavior: 'instant' }) })
    await expect.poll(() => selectionScroll.evaluate(element => element.scrollTop)).toBe(0)
    expect(await textSpan.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-user-select'))).toBe('text')
    expect(await reader.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
    // PDFium positions one span per glyph; the first span contains only "B".
    // Measure the full fixture line to exercise a real cross-glyph drag.
    const textLineBox = () => textSpan.evaluate(element => {
      const glyphs = [...element.parentElement!.querySelectorAll<HTMLElement>('span[data-pdf-run]')]
      const label = 'Browser PDF page one'
      if (!glyphs.map(glyph => glyph.textContent).join('').startsWith(label)) {
        throw new Error('The PDF text layer does not contain the fixture line')
      }
      let remaining = label.length
      const boxes: DOMRect[] = []
      for (const glyph of glyphs) {
        if (remaining <= 0) break
        boxes.push(glyph.getBoundingClientRect())
        remaining -= glyph.textContent?.length ?? 0
      }
      const left = Math.min(...boxes.map(box => box.left)), top = Math.min(...boxes.map(box => box.top))
      const right = Math.max(...boxes.map(box => box.right)), bottom = Math.max(...boxes.map(box => box.bottom))
      return { x: left, y: top, width: right - left, height: bottom - top }
    })
    await expect.poll(async () => (await textLineBox()).y).toBeGreaterThan(toolbarBox!.y + toolbarBox!.height)
    const textBox = await textLineBox()
    await page.mouse.move(textBox.x + 8, textBox.y + textBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(textBox.x + textBox.width * 0.75, textBox.y + textBox.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toMatch(/rowser PDF pag/)
    const selectionToolbar = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await selectionToolbar.waitFor({ state: 'visible' })
    const selectionToolbarBox = await selectionToolbar.boundingBox()
    expect(selectionToolbarBox).not.toBeNull()
    expect(selectionToolbarBox!.y).toBeGreaterThanOrEqual(toolbarBox!.y + toolbarBox!.height + 8)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(scaffold.authenticatedUrl).origin })
    await selectionToolbar.getByRole('button', { name: 'Copy text' }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/rowser PDF pag/)
    await selectionToolbar.getByRole('button', { name: 'Copied' }).waitFor({ state: 'visible' })
    await selectionToolbar.getByRole('button', { name: 'Translate', exact: true }).click()
    const translationPanel = reader.locator('.dsh-pdf-translation-panel')
    const panelTargetLanguage = translationPanel.locator('.dsh-pdf-translation-language-trigger')
    await panelTargetLanguage.waitFor({ state: 'visible' })
    await expect.poll(() => panelTargetLanguage.getAttribute('aria-label')).toBe('Target language: Chinese')
    await panelTargetLanguage.click()
    const languageMenu = translationPanel.locator('.dsh-pdf-translation-language-menu')
    expect((await languageMenu.getByRole('button').allTextContents()).map(label => label.trim()))
      .toEqual(['Chinese', 'English', 'Japanese', 'Korean', 'French', 'German'])
    await expect.poll(() => languageMenu.getByRole('button', { name: 'Chinese', exact: true }).getAttribute('aria-pressed'))
      .toBe('true')
    await panelTargetLanguage.focus()
    await page.keyboard.press('Escape')
    await languageMenu.waitFor({ state: 'hidden' })
    await translationPanel.getByRole('button', { name: 'Close translation' }).focus()
    await page.keyboard.press('Escape')
    await translationPanel.locator('.dsh-pdf-translation-content').waitFor({ state: 'hidden' })
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    const explanationStatus = reader.getByRole('region', { name: 'Explain passages' })
    await explanationStatus.waitFor({ state: 'visible' })
    const explanationEditor = reader.getByRole('dialog', { name: 'Ask about this passage' })
    const selectExcerpt = async (start: number, end: number) => {
      await reader.evaluate((element, offsets) => {
        const layer = element.querySelector('[data-pdf-page="1"] .dsh-pdf-text-layer')
        const glyphs = [...layer?.querySelectorAll<HTMLElement>('span[data-pdf-run]') ?? []]
        const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
        if (!scroll || !glyphs.map(glyph => glyph.textContent).join('').startsWith('Browser PDF page one')) {
          throw new Error('PDF text layer is not ready for explanation selection')
        }
        const position = (offset: number) => {
          for (const glyph of glyphs) {
            const length = glyph.textContent?.length ?? 0
            if (offset <= length && glyph.firstChild) return { node: glyph.firstChild, offset }
            offset -= length
          }
          throw new Error('PDF selection offset exceeds the fixture line')
        }
        const first = position(offsets[0]), last = position(offsets[1])
        const range = document.createRange()
        range.setStart(first.node, first.offset)
        range.setEnd(last.node, last.offset)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
        scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
      }, [start, end] as [number, number])
      await explanationEditor.waitFor({ state: 'visible' })
    }
    await selectExcerpt(0, 7)
    const explanationMarks = reader.locator('[data-pdf-explanation-mark]')
    expect(await explanationMarks.count()).toBe(0)
    await explanationEditor.getByRole('textbox').fill('Why does the first passage matter?')
    // Recapturing the same PDF glyphs must preserve the question already typed
    // into the in-progress explanation draft.
    await selectExcerpt(0, 7)
    expect(await explanationEditor.getByRole('textbox').inputValue()).toBe('Why does the first passage matter?')
    await explanationEditor.getByRole('button', { name: 'Save', exact: true }).click()
    // Saving a text passage is a Host round trip (selector re-extraction and
    // evidence persistence); the mark appears after that completes.
    await expect.poll(() => explanationMarks.count()).toBeGreaterThan(0)
    await explanationEditor.waitFor({ state: 'hidden' })
    await expect.poll(() => explanationStatus.innerText()).toContain('1/20')
    expect(await explanationMarks.first().evaluate(element => element.tagName)).toBe('DIV')
    expect(await explanationMarks.first().evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    expect(await reader.locator('.dsh-pdf-explanation-overlay polygon').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-explanation-index').allTextContents()).toEqual(['1'])
    expect(await save.isDisabled()).toBe(true)
    await selectExcerpt(8, 15)
    await explanationEditor.getByRole('textbox').fill('How does the second passage differ?')
    await explanationEditor.getByRole('button', { name: 'Save', exact: true }).click()
    await explanationEditor.waitFor({ state: 'hidden' })
    await expect.poll(() => reader.locator('.dsh-pdf-explanation-index').allTextContents()).toEqual(['1', '2'])
    expect(await save.isDisabled()).toBe(true)
    await reader.getByRole('button', { name: 'Edit question for passage 1' }).click()
    await explanationEditor.getByRole('button', { name: /Delete|Remove passage/ }).click()
    expect(await reader.locator('.dsh-pdf-explanation-index').allTextContents()).toEqual(['1'])
    await reader.getByRole('button', { name: 'Edit question for passage 1' }).click()
    expect(await explanationEditor.getByRole('textbox').inputValue())
      .toBe('How does the second passage differ?')
    await explanationEditor.getByRole('button', { name: 'Cancel' }).click()
    await explanationStatus.getByRole('button', { name: 'Exit explanation mode' }).click()
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(0)
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 8, y: 8 } })
    await selectionToolbar.waitFor({ state: 'hidden' })

    await toolbar.locator('.dsh-pdf-tools > summary').click()
    const toolsMenu = toolbar.locator('.dsh-pdf-tools > .dsh-pdf-tools-menu')
    const noteTool = toolsMenu.getByRole('button', { name: 'Note', exact: true })
    const menuMaterial = await toolsMenu.evaluate(element => {
      const toolbar = element.closest('.dsh-pdf-main-toolbar')!
      const menu = getComputedStyle(element), surface = getComputedStyle(toolbar, '::before')
      return { backgroundImage: menu.backgroundImage, backdropFilter: menu.backdropFilter,
        toolbarBackgroundImage: surface.backgroundImage, toolbarBackdropFilter: surface.backdropFilter }
    })
    expect(menuMaterial.backgroundImage).toBe(menuMaterial.toolbarBackgroundImage)
    expect(menuMaterial.backdropFilter).toBe(menuMaterial.toolbarBackdropFilter)
    expect(await toolsMenu.evaluate(element => getComputedStyle(element).borderRadius)).toBe('12px')
    expect(await noteTool.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('0px')
    const noteIdleBackground = await noteTool.evaluate(element => getComputedStyle(element).backgroundColor)
    await noteTool.hover()
    expect(await noteTool.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(noteIdleBackground)
    await noteTool.click()
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 120, y: 140 } })
    const notePanel = reader.locator('.dsh-pdf-comments')
    const commentCard = reader.locator('.dsh-pdf-page-comment-card')
    const noteEditor = commentCard.getByRole('textbox', { name: 'Note' })
    await commentCard.waitFor({ state: 'visible' })
    await expect.poll(() => noteEditor.evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.type(NOTE)
    expect(await noteEditor.inputValue()).toBe(NOTE)
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => reader.getByRole('toolbar', { name: 'Selected annotation' }).count()).toBe(0)
    const noteCardPalette = await commentCard.evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, foreground: style.color, border: style.borderTopColor }
    })
    const closedNoteMarker = reader.locator('[data-pdf-page="1"] .dsh-pdf-note-marker[data-pdf-note-id]')
    await expect.poll(() => closedNoteMarker.count()).toBe(0)
    await commentCard.getByRole('button', { name: 'Close note', exact: true }).click()
    await expect.poll(() => closedNoteMarker.count()).toBe(1)
    await closedNoteMarker.first().waitFor({ state: 'visible' })
    const noteMarkerPalette = await closedNoteMarker.first().evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, foreground: style.color, border: style.borderTopColor }
    })
    expect(noteMarkerPalette).toEqual(noteCardPalette)
    await expect.poll(() => saveFeedback.getAttribute('data-kind')).toBe('unsaved')
    expect(await saveFeedback.locator('[role="status"]').innerText()).toBe('Unsaved changes')
    const [feedbackBox, feedbackContentBox, feedbackToolbarBox, feedbackControlsBox] = await Promise.all([
      saveFeedback.boundingBox(), content.boundingBox(), toolbar.boundingBox(), reader.locator('.dsh-pdf-floating-controls').boundingBox(),
    ])
    expect(feedbackBox).not.toBeNull()
    expect(feedbackContentBox).not.toBeNull()
    expect(feedbackToolbarBox).not.toBeNull()
    // When the floating sidebar is open at narrow widths, toolbar and status
    // share its reduced safe area; otherwise that area spans the content.
    expect(feedbackControlsBox).not.toBeNull()
    expect(Math.abs(feedbackBox!.x + feedbackBox!.width - feedbackControlsBox!.x - feedbackControlsBox!.width)).toBeLessThanOrEqual(2)
    if (feedbackControlsBox!.width <= 800) {
      await expect.poll(async () => {
        const [notice, bar] = await Promise.all([saveFeedback.boundingBox(), toolbar.boundingBox()])
        return notice && bar ? notice.y - bar.y - bar.height : 0
      }).toBeGreaterThanOrEqual(7)
    } else {
      expect(Math.abs(feedbackBox!.y - feedbackToolbarBox!.y)).toBeLessThanOrEqual(2)
    }
    await expect.poll(() => save.isEnabled()).toBe(true).catch(async failure => {
      throw new Error(`${String(failure)}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
    // The Host has durably recorded this draft. It must not veto a Desktop
    // window unload merely because the original PDF still needs saving.
    expect(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    })).toBe(false)
    await reader.getByRole('tab', { name: 'Annotations' }).click()
    await notePanel.locator('.dsh-pdf-comment-item').filter({ hasText: NOTE }).waitFor({ state: 'visible' })
    await expect.poll(() => notePanel.locator('.dsh-pdf-comment-item').getByText(NOTE, { exact: true }).count()).toBe(1)
    await expectIconOnlyMainToolbar(toolbar)

    // The reader width drives the floating toolbar's compact layout; the
    // sidebar is an overlay and does not reduce the PDF content flex item.
    const originalReaderWidth = await reader.evaluate(element => (element as HTMLElement).style.width)
    const originalContentSizing = await content.evaluate(element => {
      const style = (element as HTMLElement).style
      return { flex: style.flex, width: style.width }
    })
    for (const paneWidth of [700, 400]) {
      await reader.evaluate((element, width) => { (element as HTMLElement).style.width = `${width}px` }, paneWidth)
      await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(paneWidth)
      await expect.poll(() => reader.evaluate(element => {
        const sidebar = element.querySelector<HTMLElement>('.dsh-pdf-sidebar')!
        const reserved = Number.parseFloat(getComputedStyle(element).getPropertyValue('--pdf-sidebar-open-width'))
        return Math.abs(reserved - sidebar.getBoundingClientRect().width)
      })).toBeLessThanOrEqual(1)
      const [compactToolbar, compactContent] = await Promise.all([toolbar.boundingBox(), content.boundingBox()])
      expect(compactToolbar).not.toBeNull()
      expect(compactContent).not.toBeNull()
      expect(compactToolbar!.x, `toolbar at ${paneWidth}px`).toBeGreaterThanOrEqual(compactContent!.x + 11)
      expect(compactToolbar!.x + compactToolbar!.width, `toolbar at ${paneWidth}px`)
        .toBeLessThanOrEqual(compactContent!.x + compactContent!.width - 11)
      const fit = await toolbar.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const controls = element.querySelector<HTMLElement>('.dsh-pdf-toolbar-controls')!
        const clipped = [...element.querySelectorAll<HTMLElement>(
          'summary, .dsh-pdf-toolbar-controls > button, .dsh-pdf-toolbar-controls > .dsh-pdf-toolbar-zoom, .dsh-pdf-toolbar-controls > .dsh-pdf-toolbar-back-split',
        )].filter(control => control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden')
          .filter(control => {
            const rect = control.getBoundingClientRect()
            return rect.left < bounds.left - 1 || rect.right > bounds.right + 1
          }).map(control => control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName)
        const reader = element.closest<HTMLElement>('.dsh-pdf-reader')!
        const sidebar = reader.querySelector<HTMLElement>('.dsh-pdf-sidebar')!
        const floating = reader.querySelector<HTMLElement>('.dsh-pdf-floating-controls')!
        return { clipped, overflow: controls.scrollWidth - controls.clientWidth,
          toolbar: { left: bounds.left, right: bounds.right, width: bounds.width },
          readerWidth: reader.clientWidth, sidebarWidth: sidebar.getBoundingClientRect().width,
          reservedSidebarWidth: getComputedStyle(reader).getPropertyValue('--pdf-sidebar-open-width'),
          floatingWidth: floating.getBoundingClientRect().width }
      })
      expect(fit.clipped, `visible controls at ${paneWidth}px: ${JSON.stringify(fit)}`).toEqual([])
      expect(fit.overflow, `horizontal control overflow at ${paneWidth}px`).toBeLessThanOrEqual(1)
      const zoomWidth = await zoomTrigger.evaluate(element => Math.round(element.getBoundingClientRect().width))
      // getBoundingClientRect may round fractional flex distribution to an
      // adjacent CSS pixel at narrow widths; allow a 2px rounding envelope.
      expect(Math.abs(zoomWidth - 52), `zoom control width at ${paneWidth}px`).toBeLessThanOrEqual(2)
      expect(await zoomTrigger.locator('svg').isVisible()).toBe(true)
      if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
        await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, `pdf-toolbar-${paneWidth}.png`) })
      }
      await toolbar.locator('.dsh-pdf-toolbar-zoom > summary').waitFor({ state: 'visible' })
      if (paneWidth === 400) {
        // The overlay panel leaves a micro-width toolbar; navigation and edit
        // actions intentionally move into Tools instead of overflowing.
        await toolbar.locator('.dsh-pdf-tools > summary').click()
        const compactMenu = toolbar.locator('.dsh-pdf-tools > .dsh-pdf-tools-menu')
        for (const name of [/Back$/, /^Undo/, /^Redo/, 'Save']) {
          expect(await compactMenu.getByRole('button', { name, exact: true }).count(),
            `accessible ${String(name)} in compact Tools menu`).toBe(1)
        }
        await toolbar.locator('.dsh-pdf-tools > summary').click()
      } else {
        for (const name of [/Back$/, /^Undo/, /^Redo/, 'Save']) {
          expect(await toolbar.getByRole('button', { name, exact: true }).count(),
            `accessible ${String(name)} at ${paneWidth}px`).toBe(1)
        }
      }
      if (paneWidth === 400 || paneWidth === 200) {
        await zoomControl.click()
        const popup = await zoomTrigger.locator('.dsh-pdf-zoom-menu').boundingBox()
        expect(popup).not.toBeNull()
        expect(popup!.x).toBeGreaterThanOrEqual(compactContent!.x + 11)
        expect(popup!.x + popup!.width).toBeLessThanOrEqual(compactContent!.x + compactContent!.width - 11)
        await zoomControl.click()
      }
      if (paneWidth === 400) {
        await toolbar.locator('.dsh-pdf-tools > summary').click()
        const menu = toolbar.locator('.dsh-pdf-tools > .dsh-pdf-tools-menu')
        expect(await menu.getByRole('button', { name: 'Save as', exact: true }).isEnabled()).toBe(true)
        expect(await menu.getByRole('button', { name: 'Discard all changes', exact: true }).isEnabled()).toBe(true)
        // Web has no OS picker: the compact action still opens the checked
        // path dialog, and cancelling it must leave the draft untouched.
        await menu.getByRole('button', { name: 'Save as', exact: true }).click()
        const saveAsDialog = reader.locator('.dsh-pdf-dialog')
        await saveAsDialog.getByRole('textbox', { name: 'PDF path' }).waitFor({ state: 'visible' })
        await saveAsDialog.getByRole('button', { name: 'Cancel' }).click()
        await saveAsDialog.waitFor({ state: 'hidden' })
        if (!await menu.isVisible()) await toolbar.locator('.dsh-pdf-tools > summary').click()
        expect(await menu.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(true)
        await toolbar.locator('.dsh-pdf-tools > summary').click()
      }
    }
    await reader.evaluate((element, width) => { (element as HTMLElement).style.width = width }, originalReaderWidth)

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
    await reader.locator('.dsh-pdf-floating-status-rail').evaluate(element => {
      const owner = window as typeof window & {
        __pdfSaveFeedbackStates?: { kind: string | null; visible: string | null; at: number }[]
        __pdfSaveFeedbackObserver?: MutationObserver
      }
      owner.__pdfSaveFeedbackStates = []
      const record = () => {
        const feedback = element.querySelector('.dsh-pdf-save-feedback')
        owner.__pdfSaveFeedbackStates!.push({
          kind: feedback?.getAttribute('data-kind') ?? null, visible: feedback ? 'true' : 'false', at: performance.now(),
        })
      }
      owner.__pdfSaveFeedbackObserver = new MutationObserver(record)
      owner.__pdfSaveFeedbackObserver.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-kind'] })
    })
    await save.click()
    await expect.poll(() => page.evaluate(() => {
      const owner = window as typeof window & { __pdfSaveFeedbackStates?: { kind: string | null; visible: string | null }[] }
      return owner.__pdfSaveFeedbackStates?.some(state => state.kind === 'saved' && state.visible === 'true') ?? false
    }), { timeout: 5000 }).toBe(true).catch(async failure => {
      const states = await page.evaluate(() => {
        const owner = window as typeof window & { __pdfSaveFeedbackStates?: { kind: string | null; visible: string | null }[] }
        return owner.__pdfSaveFeedbackStates
      })
      throw new Error(`${String(failure)}\nFeedback states: ${JSON.stringify(states)}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(() => saveFeedback.count(), { timeout: 5000 }).toBe(0)
    const feedbackStates = await page.evaluate(() => {
      const owner = window as typeof window & {
        __pdfSaveFeedbackStates?: { kind: string | null; visible: string | null; at: number }[]
        __pdfSaveFeedbackObserver?: MutationObserver
      }
      owner.__pdfSaveFeedbackObserver?.disconnect()
      const states = owner.__pdfSaveFeedbackStates ?? []
      delete owner.__pdfSaveFeedbackStates
      delete owner.__pdfSaveFeedbackObserver
      return states
    })
    const savedAt = feedbackStates.find(state => state.kind === 'saved' && state.visible === 'true')?.at
    const hiddenAt = feedbackStates.find(state => savedAt !== undefined && state.at > savedAt && state.visible === 'false')?.at
    expect(savedAt).toBeDefined()
    expect(hiddenAt! - savedAt!).toBeGreaterThanOrEqual(2400)
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
    const savedNoteAria = await captureStableAria(page, '.dsh-pdf-comments', scaffold.workspaceCwd)
    expect(savedNoteAria).toMatch(/- time: [A-Z][a-z]{2} \d{1,2}, \d{4}/)
    await compareOrRefreshGolden(
      join(EXPECTED, 'saved-note.expected.md'),
      savedNoteAria.replace(/[A-Z][a-z]{2} \d{1,2}, \d{4}/g, '{{date}}'),
      webSnapshotMode(),
    )

    // Saving rematerializes the PDF and can assign a new annotation identity.
    // Select the saved row rather than relying on the pre-save selection.
    await notePanel.locator('.dsh-pdf-comment-item').filter({ hasText: NOTE }).click()
    const selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    const noteEditField = commentCard.getByRole('textbox', { name: 'Note' })
    await expect.poll(() => selectedToolbar.count()).toBe(0)
    await commentCard.waitFor({ state: 'visible' })
    expect(await noteEditField.count()).toBe(0)
    expect(await selectedToolbar.getByLabel('Selected annotation color').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-comment-connector').count()).toBe(0)
    await commentCard.getByRole('button', { name: 'Edit note', exact: true }).click()
    expect(await selectedToolbar.count()).toBe(0)
    await noteEditField.fill('Edited standalone note')
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(() => savedNoteContents(path)).toEqual(['Edited standalone note'])

    // Exercise the same cropped native render path used to prepare OCR images.
    const cropRequests: unknown[] = []
    page.on('request', request => {
      if (!request.url().endsWith('/api/pdf.native') || request.method() !== 'POST') return
      const body = request.postDataJSON()
      if (body.payload?.action === 'tile') cropRequests.push(body.payload.tile)
    })
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    // The action stays discoverable, but this keyless fixture has no OCR-capable
    // session model, so the Host reports it unavailable.
    expect(await toolbar.getByRole('button', { name: 'OCR page' }).isDisabled()).toBe(true)
    await toolbar.getByRole('button', { name: 'Region screenshot', exact: true }).click()
    await reader.locator('.dsh-pdf-mode-region').first().waitFor({ state: 'visible' })
    await expect.poll(() => reader.locator('.dsh-pdf-floating-status-rail').innerText()).toContain('Drag to capture an area')
    expect(await reader.locator('.dsh-pdf-notice').filter({ hasText: 'Drag to capture an area' }).count()).toBe(0)
    // The region hint no longer changes the page layout; wait for the new
    // floating card before calculating where to begin the drag.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await textSpan.scrollIntoViewIfNeeded()
    // scrollIntoViewIfNeeded regards text behind the fixed floating toolbar as
    // visible; move it below the toolbar before starting a pointer drag.
    const obscuredText = await textLineBox()
    const activeToolbar = await toolbar.boundingBox()
    const floatingBoxes = await reader.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements
      .map(element => element.getBoundingClientRect()).map(box => ({ y: box.y, bottom: box.bottom })))
    const interactionSafeBottom = Math.max(activeToolbar!.y + activeToolbar!.height,
      ...floatingBoxes.map(box => box.bottom))
    if (obscuredText && obscuredText.y - 3 < interactionSafeBottom + 8) {
      const clearance = interactionSafeBottom + 12 - (obscuredText.y - 3)
      await reader.locator('.dsh-pdf-scroll').evaluate((element, delta) => { element.scrollTop -= delta }, clearance)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    }
    const shotText = await textLineBox()
    expect(shotText.y - 3).toBeGreaterThanOrEqual(interactionSafeBottom + 8)
    const sidebarBox = await reader.locator('.dsh-pdf-sidebar').boundingBox()
    const visibleTextWidth = sidebarBox
      ? Math.min(shotText.width, sidebarBox.x - shotText.x - 12)
      : shotText.width
    expect(visibleTextWidth).toBeGreaterThan(20)
    await page.mouse.move(shotText.x - 3, shotText.y - 3)
    await page.mouse.down()
    await page.mouse.move(shotText.x + visibleTextWidth, shotText.y + shotText.height + 3, { steps: 8 })
    await page.mouse.up()
    const screenshotStatus = reader.locator('[data-status-id="screenshot"]')
    await screenshotStatus.waitFor({ state: 'visible', timeout: 5_000 }).catch(async failure => {
      throw new Error(`${String(failure)}\nScreenshot did not enter capture phase: ${JSON.stringify({ shotText,
        mode: await reader.locator('.dsh-pdf-mode-region').count(), errors: tripwire.pageErrors })}`)
    })
    const preview = reader.getByRole('dialog', { name: 'Screenshot preview' })
    await preview.waitFor({ state: 'visible', timeout: 15_000 }).catch(async failure => {
      const dragStart = await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y)
        const root = document.querySelector('.dsh-pdf-scroll')
        return { target: target?.outerHTML.slice(0, 250), rootScrollTop: root?.scrollTop,
          mode: document.querySelector('.dsh-pdf-mode-region')?.getAttribute('class') }
      }, { x: shotText.x - 3, y: shotText.y - 3 })
      throw new Error(`${String(failure)}\nScreenshot drag: ${JSON.stringify({ shotText, dragStart,
        status: await screenshotStatus.innerText(), cropRequests,
        toolbar: await toolbar.boundingBox(), page: await reader.locator('[data-pdf-page="1"]').boundingBox() })}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
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

    // The keyboard commands operate on the PDF draft, not an input. Deleting a
    // saved note can be undone, redone, and finally reverted by a confirmed
    // source reload without changing the on-disk PDF.
    await reader.getByRole('tab', { name: 'Annotations' }).click()
    const savedRow = notePanel.locator('.dsh-pdf-comment-item').filter({ hasText: 'Edited standalone note' })
    await savedRow.click()
    await expect.poll(() => selectedToolbar.count()).toBe(0)
    await commentCard.waitFor({ state: 'visible' })
    await reader.locator('.dsh-pdf-scroll').focus()
    await page.keyboard.press('Delete')
    await expect.poll(() => savedRow.count()).toBe(0)
    await page.keyboard.press('Control+z')
    await expect.poll(() => savedRow.count()).toBe(1)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(() => savedRow.count()).toBe(0)
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Reload source' }).click()
    const reloadDialog = reader.locator('.dsh-pdf-dialog').filter({ hasText: 'Reload the source PDF and discard' })
    await reloadDialog.waitFor({ state: 'visible' })
    await reloadDialog.getByRole('button', { name: 'Cancel' }).click()
    expect(await savedRow.count()).toBe(0)
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Reload source' }).click()
    await reloadDialog.getByRole('button', { name: 'Reload source' }).click()
    await expect.poll(() => savedRow.count()).toBe(1)
    expect(await savedNoteContents(path)).toEqual(['Edited standalone note'])
    await savedRow.click()
    await expect.poll(() => selectedToolbar.count()).toBe(0)
    await commentCard.waitFor({ state: 'visible' })
    await reader.locator('.dsh-pdf-scroll').focus()
    await page.keyboard.press('Delete')
    await expect.poll(() => savedRow.count()).toBe(0)
    await content.evaluate(element => {
      const style = (element as HTMLElement).style
      style.flex = '0 0 400px'
      style.width = '400px'
    })
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.locator('.dsh-pdf-tools > .dsh-pdf-tools-menu')
      .getByRole('button', { name: 'Discard all changes' }).click()
    await expect.poll(() => savedRow.count()).toBe(1)
    await content.evaluate((element, sizing) => {
      const style = (element as HTMLElement).style
      style.flex = sizing.flex
      style.width = sizing.width
    }, originalContentSizing)

    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(EXPECTED, [
      'opened-toolbar.expected.md', 'dirty-toolbar.expected.md', 'saved-note.expected.md',
    ])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('auto-collapses the reading sidebar below 760px without overriding manual sidebar choices', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-narrow-sidebar-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF narrow sidebar test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-narrow-sidebar-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF narrow sidebar test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 10_000 })
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const toggle = sidebar.locator('.dsh-pdf-sidebar-toggle')
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const setReaderWidth = async (width: number) => {
      await reader.evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px` }, width)
      await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(width)
      await reader.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    }
    const assertToolbarClearOfSidebar = async () => {
      const [bar, content, rail] = await Promise.all([
        toolbar.boundingBox(), reader.locator('.dsh-pdf-content').boundingBox(), sidebar.boundingBox(),
      ])
      expect(bar).not.toBeNull(); expect(content).not.toBeNull(); expect(rail).not.toBeNull()
      expect(bar!.x).toBeGreaterThanOrEqual(content!.x + 11)
      expect(bar!.x + bar!.width).toBeLessThanOrEqual(rail!.x - 11)
      const clipped = await toolbar.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return [...element.querySelectorAll<HTMLElement>(
          'summary, .dsh-pdf-toolbar-controls > button, .dsh-pdf-toolbar-controls > select',
        )].filter(control => control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden')
          .filter(control => {
            const rect = control.getBoundingClientRect()
            return rect.left < bounds.left - 1 || rect.right > bounds.right + 1
          }).map(control => control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName)
      })
      expect(clipped).toEqual([])
    }
    const assertFeedbackClearOfToolbarAndSidebar = async () => {
      const rail = reader.locator('.dsh-pdf-floating-status-rail')
      await rail.evaluate(element => {
        const feedback = document.createElement('div')
        feedback.className = 'dsh-pdf-floating-status dsh-pdf-save-feedback'
        feedback.dataset.testFeedback = 'true'
        feedback.textContent = 'Unsaved changes'
        element.append(feedback)
      })
      const feedback = rail.locator('[data-test-feedback]')
      const [bar, notice, content, railBox] = await Promise.all([
        toolbar.boundingBox(), feedback.boundingBox(), reader.locator('.dsh-pdf-content').boundingBox(), rail.boundingBox(),
      ])
      expect(bar).not.toBeNull(); expect(notice).not.toBeNull(); expect(content).not.toBeNull(); expect(railBox).not.toBeNull()
      expect(notice!.x).toBeGreaterThanOrEqual(content!.x + 11)
      expect(notice!.x + notice!.width).toBeLessThanOrEqual(content!.x + content!.width - 11)
      if (content!.width > 800) {
        expect(Math.abs(railBox!.y - bar!.y)).toBeLessThanOrEqual(2)
        expect(notice!.x).toBeGreaterThanOrEqual(bar!.x + bar!.width + 7)
      } else {
        expect(railBox!.y - (bar!.y + bar!.height)).toBeGreaterThanOrEqual(7)
        expect(railBox!.y - (bar!.y + bar!.height)).toBeLessThanOrEqual(9)
      }
      await feedback.evaluate(element => element.remove())
    }

    // The host may initially mount a narrower tab; explicitly start this
    // scenario in a wide, expanded reader before crossing the threshold.
    await setReaderWidth(960)
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await expectIconOnlyMainToolbar(toolbar)
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-main-toolbar-wide.png') })
    }
    await compareOrRefreshGolden(
      join(EXPECTED, 'opened-toolbar.expected.md'),
      await captureStableAria(page, '.dsh-pdf-toolbar-controls', scaffold.workspaceCwd),
      webSnapshotMode(),
    )
    // Stepping a page locks navigation for a few hundred milliseconds. The
    // zoom must keep its appearance across that lock; the arrows legitimately
    // change state when moving from the first to the last page.
    {
      await reader.locator('.dsh-pdf-sidebar-tab').first().click()
      const nextPage = reader.locator('.dsh-pdf-sidebar-footer button[aria-label="Next page"]')
      await nextPage.waitFor({ state: 'visible' })
      const sampled = await page.evaluate(async () => {
        const read = () => ({
          zoom: getComputedStyle(document.querySelector('.dsh-pdf-toolbar-zoom > summary')!).opacity,
          zoomTrigger: getComputedStyle(document.querySelector('.dsh-pdf-toolbar-zoom')!).opacity,
          next: getComputedStyle(document.querySelector('.dsh-pdf-sidebar-footer button[aria-label="Next page"]')!).opacity,
        })
        const seen: string[] = []
        const started = performance.now()
        return await new Promise<string[]>(resolve => {
          const tick = () => {
            const state = read()
            const text = `${state.zoom}|${state.zoomTrigger}|${state.next}`
            if (seen.at(-1) !== text) seen.push(text)
            if (performance.now() - started < 1600) requestAnimationFrame(tick)
            else resolve(seen)
          }
          document.querySelector<HTMLButtonElement>('.dsh-pdf-sidebar-footer button[aria-label="Next page"]')!.click()
          requestAnimationFrame(tick)
        })
      })
      expect(sampled).toEqual(['1|1|1', '1|1|0.35'])
      await reader.locator('.dsh-pdf-sidebar-tab').first().click()
    }
    const zoomControl = toolbar.locator('.dsh-pdf-toolbar-zoom > summary')
    const tooltip = page.getByRole('tooltip')
    await zoomControl.hover()
    await tooltip.waitFor({ state: 'visible' })
    expect(await tooltip.innerText()).toBe('Zoom: Fit width')
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await page.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-main-toolbar-tooltip.png') })
    }
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: 'hidden' })
    // Move to this control with the keyboard, rather than programmatically
    // focusing it in pointer modality (which is not :focus-visible).
    await zoomControl.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect.poll(() => zoomControl.evaluate(element => document.activeElement === element)).toBe(true)
    await expect.poll(() => zoomControl.evaluate(element => element.matches(':focus-visible'))).toBe(true)
    await tooltip.waitFor({ state: 'visible' })
    expect(await tooltip.innerText()).toBe('Zoom: Fit width')
    await zoomControl.evaluate(element => (element as HTMLElement).blur())
    await tooltip.waitFor({ state: 'hidden' })
    const disabledSave = toolbar.getByRole('button', { name: 'Save', exact: true })
    expect(await disabledSave.isDisabled()).toBe(true)
    await disabledSave.hover()
    await tooltip.waitFor({ state: 'visible' })
    expect(await tooltip.innerText()).toBe('Save')
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: 'hidden' })

    const pageField = sidebar.getByRole('textbox', { name: 'Page' })
    await pageField.focus()
    await setReaderWidth(700)
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    await pageField.evaluate(input => input.blur())
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await sidebar.getAttribute('class')).toContain('is-collapsed')
    await assertToolbarClearOfSidebar()
    await expectIconOnlyMainToolbar(toolbar)
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-main-toolbar-narrow.png') })
    }
    await assertFeedbackClearOfToolbarAndSidebar()

    await setReaderWidth(960)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')

    await setReaderWidth(700)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await reader.getByRole('tab', { name: 'Pages' }).click()
    await reader.getByRole('button', { name: 'Page 1 / 2' }).waitFor({ state: 'visible' })
    await assertToolbarClearOfSidebar()

    // Match the cramped Desktop case: a manually reopened panel leaves only
    // about 200px for the PDF column, so Save must move into Tools.
    await setReaderWidth(365)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await assertToolbarClearOfSidebar()
    await expectIconOnlyMainToolbar(toolbar)
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-main-toolbar-cramped.png') })
    }
    await assertFeedbackClearOfToolbarAndSidebar()
    expect(await toolbar.locator('.dsh-pdf-toolbar-save').isVisible()).toBe(false)
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.locator('.dsh-pdf-tools > .dsh-pdf-tools-menu').getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible' })
    await toolbar.locator('.dsh-pdf-tools > summary').click()

    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    await setReaderWidth(960)
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('keeps collapsed page navigation compact and supports direct page entry', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-compact-page-nav-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF compact page navigation test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-compact-page-nav-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF compact page navigation test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 10_000 })
    await reader.evaluate(element => { (element as HTMLElement).style.width = '700px' })
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const compactNav = sidebar.locator('.dsh-pdf-sidebar-page-nav.is-compact')
    await compactNav.waitFor({ state: 'visible' })
    const input = compactNav.getByRole('textbox', { name: 'Page' })
    const previous = compactNav.getByRole('button', { name: 'Previous page' })
    const next = compactNav.getByRole('button', { name: 'Next page' })
    expect(await input.inputValue()).toBe('1')
    expect((await compactNav.locator('.dsh-pdf-page-total').innerText()).trim()).toBe('2')
    expect(await previous.isDisabled()).toBe(true)
    expect(await next.isDisabled()).toBe(false)
    const tops = await compactNav.evaluate(element => {
      const top = (selector: string) => element.querySelector(selector)!.getBoundingClientRect().top
      return [top('button:first-child'), top('input'), top('.dsh-pdf-page-total'), top('button:last-child')]
    })
    expect(tops.every((top, index) => index === 0 || top > tops[index - 1])).toBe(true)
    await input.fill('2')
    await input.press('Enter')
    await expect.poll(() => input.inputValue()).toBe('2')
    await expect.poll(() => next.isDisabled()).toBe(true)
    await expect.poll(() => input.isEnabled()).toBe(true)
    await input.press('ArrowDown')
    await expect.poll(() => input.inputValue()).toBe('1')
    await expect.poll(() => input.isEnabled()).toBe(true)
    await input.fill('99')
    await input.blur()
    await expect.poll(() => input.inputValue()).toBe('2')
    await input.fill('1')
    await input.press('Enter')
    await expect.poll(() => input.inputValue()).toBe('1')
    await expect.poll(() => input.isEnabled()).toBe(true)
    await input.fill('3')
    await input.press('Enter')
    await expect.poll(() => input.inputValue()).toBe('1')
    expect(await input.getAttribute('aria-invalid')).toBeNull()
    await input.press('Escape')
    await expect.poll(() => input.inputValue()).toBe('1')
    expect(tripwire.pageErrors).toEqual([])
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
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Note', exact: true }).click()
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 120, y: 140 } })
    const commentCard = reader.locator('.dsh-pdf-page-comment-card')
    await commentCard.getByRole('textbox', { name: 'Note' }).fill(NOTE)
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => save.isEnabled()).toBe(true)

    const clickToolbarAction = async (selector: string, name: string) => {
      const direct = toolbar.locator(selector)
      if (await direct.isVisible()) return direct.click()
      await toolbar.locator('.dsh-pdf-tools > summary').click()
      await toolbar.locator('.dsh-pdf-tools > .dsh-pdf-tools-menu').getByRole('button', { name, exact: true }).click()
    }
    await clickToolbarAction('.dsh-pdf-toolbar-save-as', 'Save as')
    expect(await reader.locator('.dsh-pdf-dialog').count()).toBe(0)
    expect(await save.isEnabled()).toBe(true)
    await page.evaluate(path => {
      (window as typeof window & { __pdfPickerNextPath?: string | null }).__pdfPickerNextPath = path
    }, copyPath)
    await clickToolbarAction('.dsh-pdf-toolbar-save-as', 'Save as')
    // Save As replaces the reader tab, so a transient status from the old
    // reader is not a stable way to identify the new resource.
    await expect.poll(() => savedNoteContents(copyPath)).toEqual([NOTE])
    const pickerDefaults = await page.evaluate(() =>
      (window as typeof window & { __pdfPickerDefaults?: string[] }).__pdfPickerDefaults)
    expect(pickerDefaults).toEqual([sourcePath.replace(/\.pdf$/i, '-annotated.pdf'), sourcePath.replace(/\.pdf$/i, '-annotated.pdf')])

    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Note', exact: true }).click()
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 180, y: 210 } })
    await commentCard.getByRole('textbox', { name: 'Note' }).fill('Unsaved after Save As')
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => save.isEnabled()).toBe(true)
    await writeFile(copyPath, original)
    await save.click()
    const conflict = reader.locator('.dsh-pdf-notice').filter({ hasText: 'The source file changed outside this reader.' })
    await conflict.waitFor({ state: 'visible' })
    expect(await conflict.count()).toBe(1)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    if (!await toolbar.locator('.dsh-pdf-toolbar-discard').isVisible()) await toolbar.locator('.dsh-pdf-tools > summary').click()
    const discard = toolbar.getByRole('button', { name: 'Discard all changes' })
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
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Note', exact: true }).click()
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 120, y: 140 } })
    const commentCard = reader.locator('.dsh-pdf-page-comment-card')
    await commentCard.getByRole('textbox', { name: 'Note' }).fill(NOTE)
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => toolbar.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(true)

    const directSaveAs = toolbar.locator('.dsh-pdf-toolbar-save-as')
    if (await directSaveAs.isVisible()) await directSaveAs.click()
    else {
      await toolbar.locator('.dsh-pdf-tools > summary').click()
      await toolbar.locator('.dsh-pdf-tools-menu').getByRole('button', { name: 'Save as', exact: true }).click()
    }
    const dialog = reader.locator('.dsh-pdf-dialog')
    await dialog.waitFor({ state: 'visible' })
    const path = dialog.getByRole('textbox', { name: 'PDF path' })
    const save = dialog.getByRole('button', { name: 'Save', exact: true })
    const defaultPath = sourcePath.replace(/\.pdf$/i, '-annotated.pdf')
    expect(await path.inputValue()).toBe(defaultPath)
    await dialog.getByText('A new PDF file will be created.').waitFor({ state: 'visible' })
    await expect.poll(() => save.isEnabled()).toBe(true)

    await path.fill(targetPath)
    await dialog.getByText('The target exists. Select overwrite to replace the inspected version.')
      .waitFor({ state: 'visible' })
    await expect.poll(() => save.isDisabled()).toBe(true)
    const overwrite = dialog.getByRole('checkbox', { name: 'Overwrite the existing target' })
    await overwrite.check()
    await expect.poll(() => save.isEnabled()).toBe(true)
    // This write happens after inspectTarget and before Save, so the Host must
    // reject the stale observed version instead of overwriting another writer.
    const externallyUpdated = await outlinedSourcePdf()
    await writeFile(targetPath, externallyUpdated)
    await save.click()
    await reader.getByRole('alert').waitFor({ state: 'visible' })
    expect(await readFile(targetPath)).toEqual(Buffer.from(externallyUpdated))
    expect(await dialog.isVisible()).toBe(true)

    // Editing the path runs a fresh asynchronous target inspection. The user
    // can then knowingly confirm and save against the new version.
    await path.fill(defaultPath)
    await dialog.getByText('A new PDF file will be created.').waitFor({ state: 'visible' })
    await path.fill(targetPath)
    await dialog.getByText('The target exists. Select overwrite to replace the inspected version.')
      .waitFor({ state: 'visible' })
    await overwrite.check()
    await save.click()
    await expect.poll(() => savedNoteContents(targetPath)).toEqual([NOTE])
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('applies real FitV and FitR PDF outline destinations in the browser reader', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-fit-outline-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF Fit outline test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await fittedOutlinePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-reader-fit-outline-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF Fit outline test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await reader.getByRole('tab', { name: 'Bookmarks' }).click()
    const pageInput = reader.locator('.dsh-pdf-sidebar').getByRole('textbox', { name: 'Page' })
    const scroll = reader.locator('.dsh-pdf-scroll')
    const zoom = reader.locator('.dsh-pdf-toolbar-zoom > summary')
    const vertical = reader.getByRole('button', { name: 'Fit vertical', exact: true })
    await expect.poll(() => vertical.isEnabled()).toBe(true)
    await vertical.click()
    await expect.poll(() => pageInput.inputValue()).toBe('2')
    await reader.locator('[data-pdf-page="2"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    const verticalScale = await reader.locator('[data-pdf-page="2"]').evaluate(element => element.getBoundingClientRect().height / 560)
    const expectedVerticalScale = await scroll.evaluate(element => Math.max(0.1, (element.clientHeight - 56) / 560))
    expect(Math.abs(verticalScale - expectedVerticalScale)).toBeLessThan(0.03)
    expect(await zoom.getAttribute('aria-label')).toBe(`Zoom: ${Math.round(expectedVerticalScale * 100)}%`)

    const rectangle = reader.getByRole('button', { name: 'Fit rectangle', exact: true })
    await expect.poll(() => rectangle.isEnabled()).toBe(true)
    await rectangle.click()
    await expect.poll(() => pageInput.inputValue()).toBe('3')
    await reader.locator('[data-pdf-page="3"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    const rectangleScale = await reader.locator('[data-pdf-page="3"]').evaluate(element => element.getBoundingClientRect().height / 560)
    const expectedRectangleScale = await scroll.evaluate(element => Math.max(0.1,
      Math.min((element.clientWidth - 32) / 300, (element.clientHeight - 56) / 310)))
    expect(Math.abs(rectangleScale - expectedRectangleScale)).toBeLessThan(0.03)
    expect(await zoom.getAttribute('aria-label')).toBe(`Zoom: ${Math.round(expectedRectangleScale * 100)}%`)
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
    // Opening the auto-collapsed sidebar preserves the reading anchor and can
    // leave a nonzero starting scroll offset at this responsive width.
    // The first canvas can become visible while Reader still has its initial
    // 600px viewport estimate. Wait for Fit width's actual 400×560 page size
    // before capturing the position that Back should restore.
    await expect.poll(() => scroll.evaluate(root => {
      const page = root.querySelector<HTMLElement>('[data-pdf-page="1"]')
      return page ? Math.abs(page.getBoundingClientRect().height - (root.clientWidth - 32) * 560 / 400) : Infinity
    })).toBeLessThan(2)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const originScrollTop = await scrollTop()
    const atOrigin = async () => Math.abs(await scrollTop() - originScrollTop)

    const chapter = reader.locator('.dsh-pdf-bookmark-row').filter({ hasText: 'Chapter 1' }).first()
    await expect.poll(() => chapter.getByRole('button', { name: 'Chapter 1' }).isEnabled()).toBe(true)
    await expect.poll(() => chapter.evaluate(row => {
      const bounds = row.getBoundingClientRect()
      return row.contains(document.elementFromPoint(bounds.x + 8, bounds.y + bounds.height / 2))
    })).toBe(true)
    const chapterBox = await chapter.boundingBox()
    expect(chapterBox).not.toBeNull()
    await page.mouse.click(chapterBox!.x + 8, chapterBox!.y + chapterBox!.height / 2)
    // The final page cannot always align to the viewport top because scrolling
    // clamps at the document end, so current-page tracking can remain on page 1.
    // Scroll position directly proves that the bookmark navigated to page 2.
    await expect.poll(scrollTop, { timeout: 20_000 }).toBeGreaterThan(200)
    await reader.getByRole('button', { name: 'Back', exact: true }).click()
    await expect.poll(atOrigin).toBeLessThan(20)
    await chapter.getByRole('button', { name: 'Expand bookmark section' }).click()
    await reader.getByRole('treeitem', { name: 'Section 1' }).waitFor({ state: 'visible' })
    expect(await atOrigin()).toBeLessThan(20)

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
    await expect.poll(atOrigin).toBeLessThan(20)
    await sidebarPage.fill('2'); await sidebarPage.press('Enter')
    await expect.poll(scrollTop).toBeGreaterThan(200)
    await personal.getByRole('button', { name: 'More bookmark actions: Whole-row bookmark' }).click()
    await personal.getByRole('button', { name: 'Rename bookmark: Whole-row bookmark' }).click()
    expect(await scrollTop()).toBeGreaterThan(200)
    await personal.getByRole('button', { name: 'Cancel' }).click()
    await personal.getByRole('button', { name: 'More bookmark actions: Whole-row bookmark' }).click()
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
    await chooseZoom(reader, '100%')
    const scroll = reader.locator('.dsh-pdf-scroll')
    await expect.poll(() => scroll.evaluate(root => root.scrollWidth)).toBeGreaterThan(3000)
    await scroll.evaluate(root => { root.scrollTop = 0; root.scrollLeft = 0 })
    await reader.locator('[data-pdf-page="1"]').waitFor({ state: 'attached' })
    await reader.getByRole('tab', { name: 'Annotations' }).click()
    const note = reader.locator('.dsh-pdf-comments .dsh-pdf-comment-item').filter({ hasText: 'Narrow-page note' })
    await note.waitFor({ state: 'visible' })
    await note.click()

    const target = reader.locator(`[data-pdf-page="${WIDE_NOTE_PAGE}"]`)
    await target.waitFor({ state: 'attached', timeout: 10_000 })
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    await expect.poll(() => reader.locator('.dsh-pdf-toolbar-zoom > summary').getAttribute('aria-disabled')).toBe('false')
    await expect.poll(() => scroll.evaluate(root => root.scrollLeft)).toBeGreaterThan(1000)
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('virtualizes annotation rows through editor resize, wheel focus, and excerpt revisits', async () => {
  const bundle = await build({
    entryPoints: [join(ROOT, 'tests', 'modules', 'viewer', 'annotation-list.web.fixture.tsx')], bundle: true, write: false,
    platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  })
  const css = await readFile(join(ROOT, 'src', 'client', 'reader.css'), 'utf8')
  const sidebarCss = await readFile(join(ROOT, 'src', 'client', 'reading-sidebar.css'), 'utf8')
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent(`<style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}
      :root{--dsw-alias-bg-base:#f4f5f7;--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#222;
      --dsw-alias-label-secondary:#666;--dsw-alias-border-l2:#ddd;--dsw-alias-link:#1765c0}
      #root>.dsh-pdf-reader{height:900px}.dsh-pdf-comments{width:320px;right:auto}
      #annotation-test-editor{padding:10px}#annotation-test-editor textarea{display:block;width:290px;height:80px;resize:vertical}
      ${css}${sidebarCss}</style><div id="root"></div>`)
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const panel = page.locator('.dsh-pdf-panel-scroll')
    const list = page.locator('.dsh-pdf-annotation-virtual')
    const rows = page.locator('.dsh-pdf-comment-item')
    await rows.first().waitFor()
    const heading = page.locator('.dsh-pdf-annotations-heading')
    const headingBox = await heading.boundingBox()
    const scrollBox = await panel.boundingBox()
    expect(headingBox && scrollBox).toBeTruthy()
    expect(Math.abs(headingBox!.y + headingBox!.height - scrollBox!.y)).toBeLessThan(1)
    expect(await panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    expect(await rows.count()).toBeLessThan(20)

    // Disable browser scroll anchoring for this probe: normally it adds the
    // editor's height delta to scrollTop and correctly keeps the same row in view.
    // Holding scrollTop fixed isolates whether our ResizeObserver remeasures.
    await panel.evaluate(element => { element.style.overflowAnchor = 'none'; element.scrollTop = 2500 })
    await expect.poll(async () => Number(await rows.first().getAttribute('data-annotation-index'))).toBeGreaterThan(20)
    const geometry = () => page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.dsh-pdf-panel-scroll')!
      const list = document.querySelector<HTMLElement>('.dsh-pdf-annotation-virtual')!
      const editor = document.querySelector<HTMLElement>('#annotation-test-editor')!
      return { scrollTop: panel.scrollTop, listTop: list.getBoundingClientRect().top,
        editorHeight: editor.getBoundingClientRect().height,
        first: document.querySelector<HTMLElement>('.dsh-pdf-comment-item')?.dataset.annotationIndex }
    })
    const beforeGeometry = await geometry()
    await page.getByRole('textbox', { name: 'Annotation editor' }).evaluate(element => { element.style.height = '260px' })
    await expect.poll(async () => (await geometry()).editorHeight).toBe(beforeGeometry.editorHeight + 180)
    await expect.poll(async () => (await geometry()).scrollTop).toBe(beforeGeometry.scrollTop)
    await expect.poll(async () => (await geometry()).listTop).toBeGreaterThan(beforeGeometry.listTop + 170)
    await expect.poll(async () => Number(await rows.first().getAttribute('data-annotation-index')))
      .toBeLessThan(Number(beforeGeometry.first))

    await panel.evaluate(element => { element.scrollTop = 0 })
    await expect.poll(() => rows.first().getAttribute('data-annotation-index')).toBe('0')
    await rows.first().focus()
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-annotation-index'))).toBe('0')
    await panel.hover()
    await page.mouse.wheel(0, 100_000)
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(70_000)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-annotation-index'))).toBe('0')
    expect(await rows.count()).toBeLessThan(20)
    await page.keyboard.press('End')
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-annotation-index'))).toBe('999')

    await page.evaluate(() => (window as any).annotationListProbe.setMode('multi-page-notes'))
    await panel.evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.getByText('Page 12', { exact: true }).waitFor()
    // The previously focused row remains mounted outside the visible window.
    expect(await rows.count()).toBeLessThanOrEqual(21)

    await page.evaluate(() => (window as any).annotationListProbe.setMode('highlights'))
    await panel.evaluate(element => { element.scrollTop = 0 })
    await page.getByText('Target phrase', { exact: true }).first().waitFor()
    const reads = () => page.evaluate(() => (window as any).annotationListProbe.reads as number[])
    await expect.poll(async () => (await reads()).filter(value => value === 1).length).toBe(1)
    await panel.evaluate(element => { element.scrollTop = 1400 })
    await expect.poll(async () => (await reads()).filter(value => value === 2).length).toBe(1)
    // Flush the negative excerpt cache for page 2 before evicting its group.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await panel.evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.getByText('Page 12', { exact: true }).waitFor()
    await panel.evaluate(element => { element.scrollTop = 0 })
    await page.getByText('Target phrase', { exact: true }).first().waitFor()
    await panel.evaluate(element => { element.scrollTop = 1400 })
    await page.getByText('Page 2', { exact: true }).waitFor()
    expect((await reads()).filter(value => value === 1).length).toBe(1)
    expect((await reads()).filter(value => value === 2).length).toBe(1)
    expect(errors).toEqual([])
  } finally { await browser.close() }
}, 40_000)

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
    await chooseZoom(reader, '100%')
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
    await expect.poll(() => reader.locator('.dsh-pdf-toolbar-zoom > summary').getAttribute('aria-disabled')).toBe('false')
    const commentCard = reader.locator('.dsh-pdf-page-comment-card')
    const selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await selectedToolbar.waitFor({ state: 'visible' })
    await commentCard.waitFor({ state: 'visible' })
    expect(await commentCard.getByText('Distant highlight', { exact: true }).count()).toBe(1)
    expect(await commentCard.getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    await commentCard.getByRole('button', { name: 'Add comment' }).click()
    await expect.poll(() => commentCard.getByRole('textbox', { name: 'Comment' }).evaluate(element => element === document.activeElement)).toBe(true)
    await commentCard.getByRole('textbox', { name: 'Comment' }).fill('Temporary question')
    await commentCard.getByRole('button', { name: 'Cancel' }).click()
    expect(await commentCard.getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    expect(await commentCard.getByText('Distant highlight', { exact: true }).count()).toBe(1)
    await selectedToolbar.getByLabel('Selected annotation color').fill('#ff0000')
    await expect.poll(() => reader.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(true)
    await selectedToolbar.waitFor({ state: 'visible' })
    await selectedToolbar.getByRole('button', { name: 'Deselect' }).click()
    await commentCard.waitFor({ state: 'hidden' })
    await reader.getByRole('button', { name: 'Back', exact: true }).click()
    await expect.poll(() => scroll.evaluate(root => root.scrollTop)).toBeLessThan(20)
    await target.waitFor({ state: 'detached' })
    await annotation.click()
    await target.waitFor({ state: 'attached', timeout: 10_000 })
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => target.locator('.dsh-pdf-page-loading').count()).toBe(0)
    await expect.poll(() => reader.locator('.dsh-pdf-toolbar-zoom > summary').getAttribute('aria-disabled')).toBe('false')
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
    // 1151-page layout + native raster can exceed 20 s under the instrumented
    // coverage build; this is a readiness timeout, not a relaxed assertion.
    await reader.locator(`[data-pdf-page="${LONG_ANNOTATION_SOURCE}"] canvas[data-pdf-raster-ready="true"]`).first()
      .waitFor({ state: 'visible', timeout: 60_000 })
    // Keep zoom=1 while fit width computes a different effective scale. A
    // previous jump used to rebuild the 1151-page layout and restore its old anchor.
    await chooseZoom(reader, '100%')
    await chooseZoom(reader, 'Fit width')
    await reader.getByRole('tab', { name: 'Annotations' }).click()
    await reader.locator('.dsh-pdf-comments .dsh-pdf-comment-item').filter({ hasText: 'Distant book highlight' }).click()

    const target = reader.locator(`[data-pdf-page="${LONG_ANNOTATION_TARGET}"]`)
    await target.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 60_000 })
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
    // A mounted virtual-page container may still use Reader's initial 600px
    // estimate. Scroll only after ResizeObserver has committed Fit width for
    // the actual viewport; otherwise its total height can change mid-scroll
    // and the requested distant page never enters the rendered window.
    await expect.poll(() => scroll.evaluate(root => {
      const stage = root.querySelector<HTMLElement>('[data-page-number="1"] .dsh-pdf-page-stage')
      return stage ? Math.abs(stage.getBoundingClientRect().width - (root.clientWidth - 32)) : Infinity
    }), { timeout: 20_000 }).toBeLessThan(2)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await scroll.evaluate((root, { source, count }) => {
      const pages = root.querySelector<HTMLElement>('.dsh-pdf-windowed-pages')
      if (!pages) throw new Error('Book layout is not ready')
      root.scrollTop = pages.offsetHeight * (source - 0.5) / count
    }, { source: LONG_ANNOTATION_SOURCE, count: LONG_ANNOTATION_PAGE_COUNT })
    const source = reader.locator(`[data-pdf-page="${LONG_ANNOTATION_SOURCE}"]`)
    await source.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => input.inputValue(), { timeout: 10_000 }).toBe(String(LONG_ANNOTATION_SOURCE))

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
    await reader.getByRole('tab', { name: 'Pages' }).click()
    await expect.poll(() => sidebar.locator('.dsh-pdf-sidebar-toggle').getAttribute('aria-expanded')).toBe('true')
    // Let fit-width consume the new PDF column width before starting a jump.
    await reader.locator('.dsh-pdf-scroll').evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await pageInput.fill('115')
    await pageInput.press('Enter')
    await reader.locator('[data-pdf-page="115"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 }).catch(async failure => {
        const state = await reader.evaluate(element => {
          const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
          const input = element.querySelector<HTMLInputElement>('.dsh-pdf-sidebar-page-nav input')
          return {
            sidebar: element.querySelector('.dsh-pdf-sidebar')?.className,
            input: input?.value, disabled: input?.disabled,
            scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight,
            scrollWidth: scroll?.clientWidth,
            pages: [...element.querySelectorAll<HTMLElement>('[data-page-number]')]
              .slice(0, 12).map(page => ({ page: page.dataset.pageNumber, top: page.getBoundingClientRect().top })),
            error: element.querySelector('.dsh-pdf-error')?.textContent,
          }
        })
        throw new Error(`${String(failure)}\nReader state: ${JSON.stringify(state)}\nPage errors: ${tripwire.pageErrors.join('\n')}`)
      })
    await reader.locator('.dsh-pdf-scroll').evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await expect.poll(() => pageInput.inputValue(), { timeout: 10_000 }).toBe('115').catch(async failure => {
      const state = await reader.evaluate(element => ({
        sidebar: element.querySelector('.dsh-pdf-sidebar')?.className,
        inputs: [...element.querySelectorAll<HTMLInputElement>('.dsh-pdf-sidebar-page-nav input')]
          .map(input => ({ value: input.value, disabled: input.disabled, visible: input.getClientRects().length > 0 })),
        error: element.querySelector('.dsh-pdf-error')?.textContent,
        scrollTop: element.querySelector('.dsh-pdf-scroll')?.scrollTop,
        current: [...element.querySelectorAll<HTMLElement>('[aria-current="page"]')]
          .map(node => node.getAttribute('aria-label')),
      }))
      throw new Error(`${String(failure)}\nReader state: ${JSON.stringify(state)}`)
    })
    await expect.poll(() => reader.getByRole('button', { name: `Page 115 / ${LARGE_PAGE_COUNT}` }).getAttribute('aria-current'))
      .toBe('page')
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 115')
    // Choosing a non-adjacent stop returns directly to it and drops every skipped stop.
    await pageInput.fill('64')
    await pageInput.press('Enter')
    await expect.poll(() => pageInput.inputValue()).toBe('64')
    await toolbar.getByRole('button', { name: 'Return to an earlier position' }).click()
    const historyMenu = toolbar.getByTestId('pdf-back-history')
    expect(await historyMenu.getByRole('button', { name: /Return to Page 115, 1 jump back/ }).count()).toBe(1)
    await historyMenu.getByRole('button', { name: /Return to Page 1, 2 jumps back/ }).click()
    await expect.poll(() => pageInput.inputValue()).toBe('1')
    expect(await toolbar.getByRole('button', { name: 'Back', exact: true }).isDisabled()).toBe(true)

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

    const content = reader.locator('.dsh-pdf-content')
    const originalSizing = await content.evaluate(element => ({ flex: (element as HTMLElement).style.flex,
      width: (element as HTMLElement).style.width }))
    await content.evaluate(element => {
      const style = (element as HTMLElement).style
      style.flex = '0 0 210px'
      style.width = '210px'
    })
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.locator('.dsh-pdf-tools-menu').getByRole('button', { name: 'Back', exact: true }).click()
    await content.evaluate((element, sizing) => {
      const style = (element as HTMLElement).style
      style.flex = sizing.flex
      style.width = sizing.width
    }, originalSizing)
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page 1')
    expect(await reader.locator('.dsh-pdf-error').count()).toBe(0)
    expect(await reader.locator('.dsh-pdf-page').count()).toBeLessThan(20)

    // Select across two visible PDF text layers. A DOM Range avoids relying on
    // platform-specific drag speed while exercising Reader's keyup capture path.
    await expect.poll(() => reader.locator('[data-pdf-page="2"] [data-pdf-text="active"]').textContent())
      .toContain('Browser PDF page 2')
    // Returning from the distant page and restoring the fit-width viewport can
    // leave text layers in their 64ms resize debounce. Creating a native Range
    // during that window lets the next text-layer replacement invalidate its
    // end point just as the selection is being pinned for virtualization.
    await expect.poll(() => reader.evaluate(element => [1, 2].every(pageNumber => {
      const page = element.querySelector<HTMLElement>(`[data-pdf-page="${pageNumber}"]`)
      const text = page?.querySelector<HTMLElement>('[data-pdf-text="active"]')
      return !!text?.childNodes.length && text.style.transform === ''
        && !!page?.querySelector('canvas[data-pdf-raster-ready="true"]')
    }))).toBe(true)
    await reader.locator('.dsh-pdf-scroll').evaluate(() => new Promise<void>((resolve, reject) => {
      let previous = '', stableFrames = 0
      const deadline = performance.now() + 5_000
      const check = () => {
        if (performance.now() > deadline) {
          reject(new Error('PDF text layers did not settle after restoring fit width'))
          return
        }
        const pages = [1, 2].map(pageNumber => {
          const page = document.querySelector<HTMLElement>(`.dsh-pdf-reader [data-pdf-page="${pageNumber}"]`)
          const text = page?.querySelector<HTMLElement>('[data-pdf-text="active"]')
          const bounds = page?.getBoundingClientRect()
          return { signature: `${bounds?.width}:${bounds?.height}:${text?.style.transform}:${text?.textContent?.length}`,
            stable: !!text && text.style.transform === '' }
        })
        const current = pages.map(page => page.signature).join('|')
        stableFrames = pages.every(page => page.stable) && current === previous ? stableFrames + 1 : 0
        previous = current
        if (stableFrames >= 8) resolve()
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    }))
    const selectedText = await reader.evaluate(element => {
      const firstLayer = element.querySelector('[data-pdf-page="1"] .dsh-pdf-text-layer')
      const secondLayer = element.querySelector('[data-pdf-page="2"] .dsh-pdf-text-layer')
      const first = firstLayer?.querySelector('span[data-pdf-run]')?.firstChild
      const second = secondLayer?.querySelector('span[data-pdf-run]:last-of-type')?.firstChild
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

    // Search the actual 128-page document, including pages outside the
    // virtualized viewport. A long scan must yield without losing results.
    await sidebar.getByRole('button', { name: 'Expand reading sidebar' }).click()
    await reader.getByRole('tab', { name: 'Search' }).click()
    const searchPanel = reader.locator('.dsh-pdf-search-panel')
    await searchPanel.getByRole('textbox', { name: 'Search' }).fill('Browser PDF page')
    await searchPanel.locator('form button').click()
    await expect.poll(() => searchPanel.locator('.dsh-pdf-search-hit').count(), { timeout: 40_000 }).toBe(4)
    expect(await searchPanel.locator('.dsh-pdf-search-hit').allTextContents())
      .toEqual(expect.arrayContaining([expect.stringContaining(`page ${LARGE_PAGE_COUNT}`)]))

    // The PDF's own named page actions also work through the keyboard-accessible
    // link controls, without relying on pixel-precise clicks on rendered text.
    await reader.locator('[data-pdf-page="1"] .dsh-pdf-keyboard-links button').first().focus()
    await page.keyboard.press('Enter')
    await reader.locator(`[data-pdf-page="${LARGE_PAGE_COUNT}"] canvas[data-pdf-raster-ready="true"]`).first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain(`Browser PDF page ${LARGE_PAGE_COUNT}`)
    await reader.locator(`[data-pdf-page="${LARGE_PAGE_COUNT}"] .dsh-pdf-keyboard-links button`).first().focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => pageInput.inputValue(), { timeout: 20_000 }).toBe('1')

    // A focused page field is not necessarily an unfinished edit. After a
    // committed jump, simply focusing it must not pin the old page on scroll.
    await reader.getByRole('tab', { name: 'Pages' }).click()
    await pageInput.fill('81')
    await pageInput.press('Enter')
    await reader.locator('.dsh-pdf-windowed-pages > [data-page-number="81"]').waitFor({ state: 'attached', timeout: 20_000 })
    await expect.poll(() => pageInput.getAttribute('title')).toBe(`81 / ${LARGE_PAGE_COUNT}`)
    await pageInput.focus()
    expect(await pageInput.evaluate(input => input === document.activeElement)).toBe(true)
    await reader.locator('.dsh-pdf-scroll').evaluate(scroll => {
      const source = scroll.querySelector<HTMLElement>('.dsh-pdf-windowed-pages > [data-page-number="81"]')
      if (!source) throw new Error('Page 81 is not mounted')
      scroll.scrollTop = source.offsetTop - (81 - 24) * source.offsetHeight
      scroll.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => pageInput.getAttribute('title'), { timeout: 20_000 }).toBe(`24 / ${LARGE_PAGE_COUNT}`)
    await expect.poll(() => pageInput.inputValue()).toBe('24')
    await expect.poll(() => reader.getByRole('button', { name: `Page 24 / ${LARGE_PAGE_COUNT}` }).getAttribute('aria-current'))
      .toBe('page')

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
    await toolbar.locator('.dsh-pdf-tools > summary').click()
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
    const annotations = reader.locator('.dsh-pdf-comments')
    await expect.poll(() => annotations.locator('.dsh-pdf-comment-item').count()).toBe(1)
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await toolbar.getByRole('button', { name: 'Note', exact: true }).click()
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 185, y: 90 } })
    const commentCard = reader.locator('.dsh-pdf-page-comment-card')
    await commentCard.getByRole('textbox', { name: 'Note' }).fill('Point-anchored note')
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    // Applying the note crosses an RPC and a subsequent Client render. Give
    // the observable list the same bounded budget as other PDF mutations.
    await expect.poll(() => annotations.locator('.dsh-pdf-comment-item').count(), { timeout: 20_000 }).toBe(2)
    const noteToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await expect.poll(() => noteToolbar.count()).toBe(0)
    const noteCard = reader.locator('.dsh-pdf-page-comment-card[data-card-kind="note"]')
    const closeNote = noteCard.getByRole('button', { name: 'Close note', exact: true })
    await closeNote.click()
    const noteMarker = reader.locator('[data-pdf-note-id]')
    await expect.poll(() => noteMarker.count()).toBe(1)
    const markerBefore = await noteMarker.boundingBox()
    expect(markerBefore).not.toBeNull()
    await noteMarker.click()
    await noteCard.waitFor({ state: 'visible' })
    await expect.poll(() => noteMarker.count()).toBe(0)
    const moveHandle = noteCard.getByRole('button', { name: /Move note card/ })
    const handleBox = await moveHandle.boundingBox()
    expect(handleBox).not.toBeNull()
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 26, handleBox!.y + handleBox!.height / 2 + 20, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => noteCard.getAttribute('data-moving')).toBe(null)
    await noteCard.getByRole('button', { name: 'Close note', exact: true }).click()
    await expect.poll(() => noteMarker.count()).toBe(1)
    const markerAfter = await noteMarker.boundingBox()
    expect(markerAfter).not.toBeNull()
    expect(markerAfter!.x).toBeGreaterThan(markerBefore!.x + 10)
    expect(markerAfter!.y).toBeGreaterThan(markerBefore!.y + 8)
    // A closed note is also movable. Drag it into opposite page corners,
    // then open it and verify the floating editor never leaves the reader.
    const pageBox = await reader.locator('[data-pdf-page="1"]').boundingBox()
    const scrollBox = await reader.locator('.dsh-pdf-scroll').boundingBox()
    const sidebarBox = await reader.locator('.dsh-pdf-sidebar').boundingBox()
    expect(pageBox).not.toBeNull()
    expect(scrollBox).not.toBeNull()
    expect(sidebarBox).not.toBeNull()
    const right = Math.min(pageBox!.x + pageBox!.width - 13, scrollBox!.x + scrollBox!.width - 13,
      sidebarBox!.x - 19)
    const bottom = Math.min(pageBox!.y + pageBox!.height - 13, scrollBox!.y + scrollBox!.height - 13)
    const top = Math.max(pageBox!.y + 13, scrollBox!.y + 13)
    for (const corner of [{ x: right, y: bottom }, { x: pageBox!.x + 13, y: top }]) {
      const before = await noteMarker.boundingBox()
      expect(before).not.toBeNull()
      await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2)
      await page.mouse.down()
      await page.mouse.move(corner.x, corner.y, { steps: 8 })
      await page.mouse.up()
      await expect.poll(() => noteMarker.getAttribute('data-moving'), { timeout: 20_000 }).toBe(null)
      await expect.poll(async () => {
        const moved = await noteMarker.boundingBox()
        return moved ? Math.hypot(moved.x + moved.width / 2 - corner.x, moved.y + moved.height / 2 - corner.y) : Infinity
      }, { timeout: 20_000 }).toBeLessThan(30)
      expect(await noteCard.count()).toBe(0)
      await noteMarker.click()
      await noteCard.waitFor({ state: 'visible' })
      const cardBox = await noteCard.boundingBox()
      const readerBox = await reader.locator('.dsh-pdf-content').boundingBox()
      expect(cardBox).not.toBeNull()
      expect(readerBox).not.toBeNull()
      expect(cardBox!.x).toBeGreaterThanOrEqual(readerBox!.x)
      expect(cardBox!.y).toBeGreaterThanOrEqual(readerBox!.y)
      expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(readerBox!.x + readerBox!.width)
      expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(readerBox!.y + readerBox!.height)
      await noteCard.getByRole('button', { name: 'Close note', exact: true }).click()
      await expect.poll(() => noteMarker.count()).toBe(1)
    }
    await reader.getByRole('tab', { name: 'Annotations' }).click()
    expect(await annotations.locator('.dsh-pdf-comment-item').first().innerText()).toContain('Highlight')
    expect(await annotations.locator('.dsh-pdf-comment-item').last().innerText()).toContain('Point-anchored note')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)

it('highlights from the split button, then edits and persists five quick colors', async () => {
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
        const layer = element.querySelector('[data-pdf-page="1"] .dsh-pdf-text-layer')
        const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
        const glyphs = [...layer?.querySelectorAll<HTMLElement>('span[data-pdf-run]') ?? []]
        const label = 'Browser PDF page one'
        if (!scroll || !glyphs.map(glyph => glyph.textContent).join('').startsWith(label)) {
          throw new Error('PDF text layer is not ready for selection')
        }
        let remaining = label.length
        const last = glyphs.find(glyph => {
          const length = glyph.textContent?.length ?? 0
          if (remaining <= length) return true
          remaining -= length
          return false
        })
        const firstText = glyphs[0]?.firstChild, lastText = last?.firstChild
        if (!firstText || !lastText) throw new Error('PDF glyph text nodes are unavailable')
        // Select text that a reader can actually see. Merely finding an active
        // text layer does not mean its absolute-positioned glyphs are inside the
        // PDF scrollport after earlier pane layout/scroll restoration.
        last?.scrollIntoView({ block: 'center', inline: 'center' })
        const range = document.createRange()
        range.setStart(firstText, 0)
        range.setEnd(lastText, remaining)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
        return selection?.toString() ?? ''
      })
      expect(selected).toContain('Browser PDF page one')
      const toolbar = page.locator('.dsh-pdf-reader').getByRole('toolbar', { name: 'Selected text actions' })
      // A synthetic Range can precede Page's onView effect. Retry the same
      // keyboard capture path until the Reader has registered its page view.
      await expect.poll(async () => {
        return page.locator('.dsh-pdf-reader').evaluate(reader => {
          const scroll = reader.querySelector<HTMLElement>('.dsh-pdf-scroll')!
          scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
          const element = reader.querySelector<HTMLElement>('.dsh-pdf-context-toolbar[aria-label="Selected text actions"]')!
          const bounds = scroll.getBoundingClientRect()
          const range = window.getSelection()?.getRangeAt(0).getBoundingClientRect()
          const main = reader.querySelector<HTMLElement>('.dsh-pdf-main-toolbar')?.getBoundingClientRect()
          const toolbarBounds = element.getBoundingClientRect()
          return { active: element.getAttribute('aria-hidden'), visible: element.dataset.visible,
            scroll: [bounds.left, bounds.top, bounds.right, bounds.bottom],
            range: range ? [range.left, range.top, range.right, range.bottom] : null,
            mainBottom: main?.bottom, toolbarSize: [toolbarBounds.width, toolbarBounds.height] }
        })
      }, { timeout: 10_000 }).toMatchObject({ active: 'false', visible: 'true' })
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
    const selectionActions = selectionToolbar.locator('.dsh-pdf-selection-actions > button, .dsh-pdf-selection-highlight > button')
    expect(await selectionActions.evaluateAll(buttons => buttons.length > 0 && buttons.every(button =>
      button.getAttribute('aria-label') && button.querySelector('svg') && !button.textContent?.trim()))).toBe(true)
    await selectionToolbar.getByRole('button', { name: 'Highlight colors' }).click()
    const selectionColors = selectionToolbar.getByTestId('pdf-selection-highlight-colors')
    await selectionColors.waitFor({ state: 'visible' })
    expect(await reader.locator('.dsh-pdf-annotation-overlay path').count()).toBe(0)
    expect(await save.isDisabled()).toBe(true)
    await selectionColors.getByTestId('pdf-highlight-swatch-1').click()
    const firstOverlay = reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay path').first()
    await firstOverlay.waitFor({ state: 'visible' })
    await expect.poll(() => firstOverlay.getAttribute('fill')).toBe('rgb(255,159,10)')
    await expect.poll(() => save.isEnabled()).toBe(true)
    await compareOrRefreshGolden(
      join(EXPECTED, 'dirty-toolbar.expected.md'),
      await captureStableAria(page, '.dsh-pdf-toolbar-controls', scaffold.workspaceCwd),
      webSnapshotMode(),
    )
    let selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await selectedToolbar.waitFor({ state: 'visible' })
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await selectedToolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-highlight-toolbar.png') })
    }
    expect(await selectedToolbar.locator('.dsh-pdf-annotation-kind').textContent()).toBe('Highlight')
    expect(await selectedToolbar.getByRole('button', { name: 'Comment', exact: true }).count()).toBe(1)
    await selectedToolbar.getByRole('button', { name: 'Delete annotation' }).waitFor({ state: 'visible' })
    expect(await selectedToolbar.locator('summary[aria-label="More annotation actions"]').count()).toBe(0)
    expect(await selectedToolbar.getByRole('button', { name: 'Deselect' }).count()).toBe(1)
    const sidebarToggle = reader.locator('.dsh-pdf-sidebar-toggle')
    if (await sidebarToggle.getAttribute('aria-expanded') === 'true') await sidebarToggle.click()
    await expect.poll(() => sidebarToggle.getAttribute('aria-expanded')).toBe('false')
    await selectedToolbar.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect.poll(() => sidebarToggle.getAttribute('aria-expanded')).toBe('false')
    const commentEditor = reader.locator('.dsh-pdf-page-comment-card').getByRole('textbox', { name: 'Comment' })
    await expect.poll(() => commentEditor.evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.type('Typed without clicking the editor')
    expect(await commentEditor.inputValue()).toBe('Typed without clicking the editor')
    await commentEditor.fill('')
    // The comment card and mark toolbar coexist; Cancel returns to the mark.
    await reader.locator('.dsh-pdf-page-comment-card').getByRole('button', { name: 'Cancel' }).click()
    await selectedToolbar.waitFor({ state: 'visible' })
    let quickColors = selectedToolbar.getByTestId('pdf-highlight-colors')
    await quickColors.waitFor({ state: 'visible' })
    expect(await quickColors.locator('.dsh-pdf-highlight-palette-wheel').count()).toBe(1)
    const swatches = () => quickColors.locator('[data-testid^="pdf-highlight-swatch-"]')
    const swatchCore = (index: number) => quickColors.getByTestId(`pdf-highlight-swatch-${index}`)
      .locator('.dsh-pdf-highlight-swatch-core')
    await expect.poll(() => swatches().count()).toBe(5)
    const palette = quickColors.getByTestId('pdf-highlight-palette')
    const add = quickColors.getByTestId('pdf-highlight-add-color')
    expect(await add.count()).toBe(0)

    await quickColors.getByTestId('pdf-highlight-swatch-4').click({ button: 'right' })
    const menu = page.getByTestId('pdf-highlight-color-menu')
    await menu.waitFor({ state: 'visible' })
    await menu.getByTestId('pdf-highlight-delete-color').click()
    await expect.poll(() => swatches().count()).toBe(4)
    await quickColors.getByTestId('pdf-highlight-swatch-3').click({ button: 'right' })
    await menu.waitFor({ state: 'visible' })
    await menu.getByTestId('pdf-highlight-edit-color').fill('#35b954')
    await expect.poll(() => swatchCore(3)
      .evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(53, 185, 84)')
    // Editing a saved swatch changes only the palette, not the PDF annotation.
    expect(await firstOverlay.getAttribute('fill')).toBe('rgb(255,159,10)')
    // Choosing a palette color recolors the selected annotation, and that
    // color can be saved into the now-available fifth quick slot.
    await palette.fill('#128ace')
    await expect.poll(() => firstOverlay.getAttribute('fill')).toBe('rgb(18,138,206)')
    await expect.poll(() => add.isEnabled()).toBe(true)
    await add.click()
    await expect.poll(() => swatches().count()).toBe(5)
    expect(await add.count()).toBe(0)

    await quickColors.getByTestId('pdf-highlight-swatch-4').click({ button: 'right' })
    await menu.waitFor({ state: 'visible' })
    await menu.getByTestId('pdf-highlight-edit-color').fill('#a1b2c3')
    await expect.poll(() => swatchCore(4)
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
    const newHighlight = reader.locator('[data-pdf-page="1"] .dsh-pdf-annotation-overlay g[data-annotation-id]').last()
    await newHighlight.waitFor({ state: 'visible' })
    const newHighlightId = await newHighlight.getAttribute('data-annotation-id')
    expect(newHighlightId).toBeTruthy()
    await expect.poll(() => reader.locator(`[data-pdf-page="1"] .dsh-pdf-annotation-overlay g[data-annotation-id="${newHighlightId}"] path`)
      .getAttribute('fill')).toBe('rgb(255,255,0)')
    selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await selectedToolbar.waitFor({ state: 'visible' })
    quickColors = selectedToolbar.getByTestId('pdf-highlight-colors')
    await quickColors.waitFor({ state: 'visible' })
    await expect.poll(() => quickColors.locator('[data-testid^="pdf-highlight-swatch-"]').count()).toBe(5)
    await expect.poll(() => swatchCore(4)
      .evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(161, 178, 195)')

    // The overlay is transient: once native tiles repaint, a dynamic `path:last`
    // locator can silently switch to the older highlight. Assert the visible
    // selected color now, then verify both saved annotation colors from the PDF.
    const selectedColor = () => quickColors.locator('.dsh-pdf-highlight-palette-current')
      .evaluate(element => getComputedStyle(element).backgroundColor)
    await quickColors.getByTestId('pdf-highlight-swatch-4').click()
    await expect.poll(selectedColor).toBe('rgb(161, 178, 195)')
    await expect.poll(() => quickColors.getByTestId('pdf-highlight-swatch-4').getAttribute('aria-pressed')).toBe('true')
    await quickColors.getByTestId('pdf-highlight-swatch-0').click()
    await expect.poll(selectedColor).toBe('rgb(255, 255, 0)')
    await expect.poll(() => quickColors.getByTestId('pdf-highlight-swatch-0').getAttribute('aria-pressed')).toBe('true')
    await quickColors.getByTestId('pdf-highlight-swatch-4').click()
    await expect.poll(selectedColor).toBe('rgb(161, 178, 195)')
    await expect.poll(() => quickColors.getByTestId('pdf-highlight-swatch-4').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(async () => {
      const colors = await savedHighlightColors(path)
      return colors.length === 2 && colors.every(color => color.every((channel, index) =>
        Math.abs(channel - [161 / 255, 178 / 255, 195 / 255][index]) < 1e-6))
    }).toBe(true)

    // Placing a free note should open the annotation editor ready for typing.
    const mainToolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    await mainToolbar.locator('.dsh-pdf-tools > summary').click()
    await mainToolbar.getByRole('button', { name: 'Note', exact: true }).click()
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 180, y: 90 } })
    const noteEditor = reader.locator('.dsh-pdf-page-comment-card').getByRole('textbox', { name: 'Note' })
    await expect.poll(() => noteEditor.evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.type('Free note starts here')
    await expect.poll(() => noteEditor.inputValue()).toBe('Free note starts here')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)

it('gives underline and strike-out the same color bar as a highlight', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-text-mark-colors-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF text mark colors test' })
    const name = 'reader-text-mark-colors-e2e.pdf'
    await writeFile(join(scaffold.workspaceCwd, name), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-text-mark-colors-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF text mark colors test' }).click()
    await page.locator('[data-sidebar-right-expand]').click()
    const column = page.locator('[data-rightbar-col]')
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await reader.locator('[data-pdf-page="1"] canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents()).toContain('Browser PDF page one')

    const selectLine = async () => {
      const selected = await reader.evaluate(async element => {
        const layer = element.querySelector('[data-pdf-page="1"] .dsh-pdf-text-layer')
        const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')
        const glyphs = [...layer?.querySelectorAll<HTMLElement>('span[data-pdf-run]') ?? []]
        const label = 'Browser PDF page one'
        if (!scroll || !glyphs.map(glyph => glyph.textContent).join('').startsWith(label)) {
          throw new Error('PDF text layer is not ready for selection')
        }
        let remaining = label.length
        const last = glyphs.find(glyph => {
          const length = glyph.textContent?.length ?? 0
          if (remaining <= length) return true
          remaining -= length
          return false
        })
        last?.scrollIntoView({ block: 'center', inline: 'center' })
        // Let the virtualized page settle after scrolling before taking a
        // browser Range; otherwise it can point at glyphs about to unmount.
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        const settled = [...element.querySelectorAll<HTMLElement>('[data-pdf-page="1"] .dsh-pdf-text-layer span[data-pdf-run]')]
        if (!settled.map(glyph => glyph.textContent).join('').startsWith(label)) {
          throw new Error('PDF text layer changed while scrolling to the selection')
        }
        remaining = label.length
        const settledLast = settled.find(glyph => {
          const length = glyph.textContent?.length ?? 0
          if (remaining <= length) return true
          remaining -= length
          return false
        })
        const firstText = settled[0]?.firstChild, lastText = settledLast?.firstChild
        if (!firstText || !lastText) throw new Error('PDF glyph text nodes are unavailable')
        const range = document.createRange()
        range.setStart(firstText, 0)
        range.setEnd(lastText, remaining)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
        return selection?.toString() ?? ''
      })
      expect(selected).toContain('Browser PDF page one')
      const selectionToolbar = reader.getByRole('toolbar', { name: 'Selected text actions' })
      await expect.poll(() => reader.evaluate(element => {
        const scroll = element.querySelector<HTMLElement>('.dsh-pdf-scroll')!
        scroll.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
        const toolbar = element.querySelector<HTMLElement>('.dsh-pdf-context-toolbar[aria-label="Selected text actions"]')
        return { active: toolbar?.getAttribute('aria-hidden'), visible: toolbar?.dataset.visible }
      }), { timeout: 10_000 }).toMatchObject({ active: 'false', visible: 'true' })
      await selectionToolbar.waitFor({ state: 'visible' })
      return selectionToolbar
    }

    const selectedToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    // Each mark is created from the selection toolbar, then inspected through the
    // selected-annotation toolbar, where all three must offer the same color bar.
    // The kind badge must show the mark's own action icon, not a bare color dot.
    const markIcons = new Map([['Underline', 'M6 4v8a6 6 0 0 0 12 0V4M4 21h16'], ['Strike out', 'M17 5c-1.4-1-3.2-1.5-5-1.5']])
    // label = the action on the selection toolbar; kind = what the badge reads once selected.
    for (const label of ['Underline', 'Strike out'] as const) {
      const selectionToolbar = await selectLine()
      await selectionToolbar.getByRole('button', { name: label, exact: true }).click()
      await selectedToolbar.waitFor({ state: 'visible' })
      await expect.poll(() => selectedToolbar.locator('.dsh-pdf-annotation-kind').textContent()).toBe(label)
      const badge = selectedToolbar.locator('.dsh-pdf-annotation-kind')
      expect(await badge.locator('svg').count()).toBe(1)
      const drawn = await badge.locator('svg path').first().getAttribute('d')
      expect(drawn).toContain(markIcons.get(label))
      const colorBar = selectedToolbar.getByTestId('pdf-highlight-colors')
      await colorBar.waitFor({ state: 'visible' })
      expect(await colorBar.locator('[data-testid^="pdf-highlight-swatch-"]').count()).toBe(5)
      expect(await colorBar.locator('.dsh-pdf-highlight-palette-wheel').count()).toBe(1)
      // Choosing a saved color applies it to this mark, exactly like a highlight.
      await colorBar.getByTestId('pdf-highlight-swatch-1').click()
      await expect.poll(() => colorBar.getByTestId('pdf-highlight-swatch-1').getAttribute('aria-pressed')).toBe('true')
      await selectedToolbar.getByRole('button', { name: 'Deselect' }).click()
      await selectedToolbar.waitFor({ state: 'hidden' })
    }
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)

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
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF resume position test' }).click()

    const pageField = (reader: Locator) => reader.locator(
      '.dsh-pdf-sidebar.is-collapsed .dsh-pdf-sidebar-page-nav.is-compact .dsh-pdf-page-input, '
      + '.dsh-pdf-sidebar:not(.is-collapsed) .dsh-pdf-sidebar-footer .dsh-pdf-page-input')
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
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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

it('keeps the last complete PDF frame through consecutive in-flight zoom renders', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  let releaseTiles: (() => void) | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-zoom-frame-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF zoom frame test' })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await sourcePdf())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    let blockTiles = false, requestedTiles = 0
    let blocked = new Promise<void>(resolve => { releaseTiles = resolve })
    await page.route('**/api/pdf.native', async route => {
      const request = route.request()
      if (request.method() === 'POST' && request.postDataJSON()?.payload?.action === 'tile' && blockTiles) {
        requestedTiles++
        await blocked
      }
      try { await route.continue() } catch { /* A superseded zoom cancels its tile request. */ }
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@local/dsh-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF zoom frame test' }).click()
    const column = page.locator('[data-rightbar-col]')
    if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    const surface = reader.locator('[data-pdf-page="1"] .dsh-pdf-tile-surface')
    await surface.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch'), { timeout: 20_000 }).not.toBeNull()
    await expect.poll(() => reader.locator('[data-pdf-page="1"] .dsh-pdf-text-layer span').count()).toBeGreaterThan(0)
    const initialEpoch = await surface.getAttribute('data-pdf-ready-epoch')
    expect(initialEpoch).not.toBeNull()

    // Keep raster replies in flight across multiple zoom changes. Each scale
    // effect is committed, but none can become the next complete frame yet.
    blockTiles = true
    await chooseZoom(reader, '125%')
    await expect.poll(() => requestedTiles).toBeGreaterThan(0)
    await chooseZoom(reader, '150%')
    await expect.poll(() => requestedTiles).toBeGreaterThan(1)
    await chooseZoom(reader, '200%')
    await expect.poll(() => requestedTiles).toBeGreaterThan(2)
    const fallback = await surface.locator('canvas[data-pdf-raster-ready="true"]').evaluateAll(canvases =>
      canvases.map(canvas => ({ epoch: (canvas as HTMLCanvasElement).dataset.tileEpoch,
        width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height })))
    expect(fallback.length).toBeGreaterThan(0)
    expect(fallback.every(canvas => canvas.epoch === initialEpoch && canvas.width > 0 && canvas.height > 0)).toBe(true)

    releaseTiles()
    releaseTiles = undefined
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch'), { timeout: 20_000 }).not.toBe(initialEpoch)
    const finalEpoch = await surface.getAttribute('data-pdf-ready-epoch')
    expect(await surface.locator('canvas[data-pdf-raster-ready="true"]').evaluateAll((canvases, epoch) =>
      canvases.every(canvas => (canvas as HTMLCanvasElement).dataset.tileEpoch === epoch), finalEpoch)).toBe(true)

    // The sidebar is a floating overlay, so resizing it must not perturb the
    // page viewport. Fit-width re-rasterizes when the reader viewport changes.
    await chooseZoom(reader, 'Fit width')
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch')).not.toBe(finalEpoch)
    const beforeResize = await surface.getAttribute('data-pdf-ready-epoch')
    // Let the 64 ms text-layer debounce from the preceding zoom settle before
    // observing the sidebar drag; otherwise its rebuild is attributed to the drag.
    await page.waitForTimeout(150)
    blockTiles = true
    blocked = new Promise<void>(resolve => { releaseTiles = resolve })
    const resizeRequestStart = requestedTiles
    const initialCanvasCount = await surface.locator('canvas[data-pdf-raster-ready="true"]').count()
    const resizeFrames = await reader.evaluate(async element => {
      const startingWidth = element.clientWidth
      const raster = element.querySelector<HTMLElement>('[data-pdf-page="1"] .dsh-pdf-tile-surface')!
      const textLayer = element.querySelector<HTMLElement>('[data-pdf-page="1"] .dsh-pdf-text-layer')!
      let blanks = 0, textBlanks = 0, textRebuilds = 0, peakCanvases = 0, last = performance.now()
      const observer = new MutationObserver(records => { textRebuilds += records.filter(record => record.type === 'childList').length })
      observer.observe(textLayer, { childList: true })
      const intervals: number[] = []
      // Each width lands in a separate paint frame, like resizing the reader.
      for (const width of Array.from({ length: 9 }, (_, index) => startingWidth - (8 - index) * 20)) {
        element.style.width = `${width}px`
        await new Promise<void>(resolve => requestAnimationFrame(now => {
          intervals.push(now - last); last = now
          const canvases = [...raster.querySelectorAll<HTMLCanvasElement>('canvas[data-pdf-raster-ready="true"]')]
          if (!canvases.some(canvas => canvas.width > 0 && canvas.height > 0)) blanks++
          if (!textLayer.querySelector('span')) textBlanks++
          peakCanvases = Math.max(peakCanvases, canvases.length)
          resolve()
        }))
      }
      observer.disconnect()
      const sorted = [...intervals].sort((a, b) => a - b)
      return { blanks, textBlanks, textRebuilds, peakCanvases, frames: intervals.length,
        p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] }
    })
    await expect.poll(() => requestedTiles).toBeGreaterThan(resizeRequestStart)
    expect(resizeFrames.frames).toBe(9)
    expect(resizeFrames.blanks).toBe(0)
    expect(resizeFrames.textBlanks).toBe(0)
    expect(resizeFrames.textRebuilds).toBeLessThanOrEqual(1)
    expect(resizeFrames.peakCanvases).toBeLessThanOrEqual(initialCanvasCount + 4)
    console.info(`PDF viewport resize (blocked tiles): ${JSON.stringify(resizeFrames)}`)
    const visibleEpoch = await surface.getAttribute('data-pdf-ready-epoch')
    expect(visibleEpoch).not.toBeNull()
    expect(await surface.locator('canvas[data-pdf-raster-ready="true"]').evaluateAll((canvases, epoch) =>
      canvases.length > 0 && canvases.every(canvas => (canvas as HTMLCanvasElement).dataset.tileEpoch === epoch
        && (canvas as HTMLCanvasElement).width > 0), visibleEpoch)).toBe(true)
    releaseTiles()
    releaseTiles = undefined
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch'), { timeout: 20_000 }).not.toBe(beforeResize)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    releaseTiles?.()
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
