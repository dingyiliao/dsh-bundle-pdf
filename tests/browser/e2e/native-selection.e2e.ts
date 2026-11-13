import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Browser, type Locator } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import type { DshTranslationLlm } from '../../../src/adapters/host/dsh/translation-model.ts'
import { launchPdfBrowser } from '../launch.ts'
import { FILE_NAME, openReader } from '../support/panels.ts'
import { launchWebScaffold, MODEL_FIXTURE, MODEL_FIXTURE_AVAILABLE, ROOT, saveFailureShot, seedSession, SESSION, watchConsole } from '../support/scaffold.ts'
import { chooseZoom } from '../support/toolbar.ts'
import { inspectFixturePdf } from '../../fixtures/native-document.ts'
import { plainPdf } from '../../fixtures/pdf-fixture-kit.ts'

const labels = ['Alpha selection', 'Omega selection'] as const
const geometry = { width: 420, height: 240, x: 50, y: 170, fontSize: 20 }

async function selectionFixture(angled = false) {
  return { bytes: plainPdf(labels.map(label => ({ size: [geometry.width, geometry.height] as const,
    lines: [{ text: label, x: geometry.x, y: geometry.y, size: geometry.fontSize }],
    rotate: angled && label === labels[0] ? 23 : 0 }))), widths: [150, 160] }
}

async function seedReader(scaffold: Awaited<ReturnType<typeof launchWebScaffold>>, bytes: Uint8Array, title: string,
  nativeSelectionPreview = true) {
  await scaffold.ctx.settings.mutate('pdf-reader', [{ op: 'set', path: ['nativeSelectionPreview'], value: nativeSelectionPreview }])
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-native-selection-e2e')
  await workspace.attachSession(sessionId)
  await scaffold.ctx.sessionController.rename({ sessionId, title })
  const path = join(scaffold.workspaceCwd, FILE_NAME)
  await writeFile(path, bytes)
  return { path, sessionId }
}

async function textPoint(page: Locator, x: number) {
  const box = (await page.boundingBox())!
  return {
    x: box.x + x * box.width / geometry.width,
    y: box.y + (geometry.height - geometry.y - geometry.fontSize / 3) * box.height / geometry.height,
  }
}

it('copies and persists a cross-page PDFium selection without building glyph DOM', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const title = 'PDF native selection test'
    const { bytes, widths } = await selectionFixture()
    const { path } = await seedReader(scaffold, bytes, title)

    browser = await launchPdfBrowser()
    const page = await browser.newPage({ viewport: { width: 1680, height: 900 }, locale: 'en-US' })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-native-selection'))
    const reader = await openReader(page, scaffold.authenticatedUrl, title)
    const fullscreen = page.locator('[data-sidebar-right-mode="fullscreen"]')
    if (await fullscreen.isVisible()) await fullscreen.click()
    await chooseZoom(reader, '100%')
    const scroll = reader.locator('.dsh-pdf-scroll')
    await expect.poll(() => scroll.getAttribute('data-pdf-selection')).toBe('native-preview')
    await scroll.evaluate(element => { element.scrollTop = 0 })
    const first = scroll.locator('[data-pdf-page="1"]')
    const second = scroll.locator('[data-pdf-page="2"]')
    await second.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible' })
    expect(await scroll.locator('.dsh-pdf-text-layer span[data-pdf-run]').count()).toBe(0)
    await expect.poll(() => first.getByRole('document').ariaSnapshot()).toContain(labels[0])
    expect(await scroll.getByRole('document').count()).toBe(1)

    const actions = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(scaffold.authenticatedUrl).origin })
    await scroll.focus()
    await page.keyboard.press('Shift+End')
    await actions.waitFor({ state: 'visible' })
    await page.keyboard.press('ControlOrMeta+c')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(labels[0])
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+End')
    await expect.poll(async () => {
      await page.keyboard.press('ControlOrMeta+c')
      return page.evaluate(() => navigator.clipboard.readText())
    }).toBe(labels.join('\n'))
    await page.keyboard.press('Escape')
    await actions.waitFor({ state: 'hidden' })
    await scroll.evaluate(element => { element.scrollTop = 0 })

    const from = await textPoint(first, geometry.x + 1)
    const to = await textPoint(second, geometry.x + widths[1] - 1)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 16 })
    await second.locator('svg.dsh-pdf-selection-overlay path').waitFor({ state: 'visible' })
    // The pointer may be outside any glyph when the user finishes selecting.
    const whitespace = await textPoint(second, geometry.x + widths[1] + 40)
    await page.mouse.move(whitespace.x, whitespace.y)
    await page.mouse.up()

    await actions.waitFor({ state: 'visible' })
    expect(await page.evaluate(() => window.getSelection()?.toString().trim() ?? '')).toBe('')
    const copyEvent = await scroll.evaluate(element => {
      const clipboardData = new DataTransfer()
      const event = new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true })
      element.dispatchEvent(event)
      return { cancelled: event.defaultPrevented, text: clipboardData.getData('text/plain') }
    })
    expect(copyEvent).toEqual({ cancelled: true, text: labels.join('\n') })
    await page.keyboard.press('ControlOrMeta+c')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(labels.join('\n'))
    await actions.getByRole('button', { name: 'Highlight', exact: true }).click()

    const save = reader.getByRole('toolbar', { name: 'PDF reading and editing' }).getByRole('button', { name: 'Save', exact: true })
    await expect.poll(() => save.getAttribute('data-save-state')).toBe('dirty')
    await save.click()
    await expect.poll(() => save.getAttribute('data-save-state')).toMatch(/^saved(?:-success)?$/)
    const persisted = await inspectFixturePdf(new Uint8Array(await readFile(path)))
    const persistedHighlights = persisted.annotations.filter(annotation => annotation.subtype === 'Highlight')
    // PDF annotations are page-local dictionaries. A cross-page selection is
    // therefore represented by one highlight per covered page, while the
    // reader keeps the selection as one logical operation.
    expect(persistedHighlights).toHaveLength(labels.length)
    expect(persistedHighlights.map(annotation => annotation.page)).toEqual([1, 2])

    await chooseZoom(reader, '200%')
    await scroll.evaluate(element => { element.scrollTop = 0 })
    await first.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible' })
    await expect.poll(() => first.getByRole('document').ariaSnapshot()).toContain(labels[0])
    const start = await textPoint(first, geometry.x + 1)
    const readerBounds = (await scroll.boundingBox())!
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x, readerBounds.y + readerBounds.height - 2)
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(40)
    await page.mouse.up()
    await actions.waitFor({ state: 'visible' })
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await page.keyboard.press('ControlOrMeta+c')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(labels.join('\n'))
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it.skipIf(!MODEL_FIXTURE_AVAILABLE)('passes a PDFium selection unchanged to translation and verified explanation materials', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] },
    replayFixture: MODEL_FIXTURE, replayProvidersOnly: true })
  let browser: Browser | undefined
  try {
    const title = 'PDF native selection features'
    const { sessionId } = await seedReader(scaffold, (await selectionFixture()).bytes, title)
    await scaffold.ctx.sessionController.selectModel({ sessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    const llm = scaffold.ctx.get('llm') as DshTranslationLlm | undefined
    if (!llm) throw new Error('The Web profile has no model runtime')
    const translatedInputs: string[] = []
    const translated = 'Fixture translation.'
    llm.stream = async function* (request) {
      translatedInputs.push(JSON.parse(request.messages[0]!.content[0]!.text).text)
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'sentence', translation: translated }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    browser = await launchPdfBrowser()
    const page = await browser.newPage({ viewport: { width: 1680, height: 900 }, locale: 'en-US' })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-native-selection-features'))
    const reader = await openReader(page, scaffold.authenticatedUrl, title)
    const fullscreen = page.locator('[data-sidebar-right-mode="fullscreen"]')
    if (await fullscreen.isVisible()) await fullscreen.click()
    await chooseZoom(reader, '100%')
    const scroll = reader.locator('.dsh-pdf-scroll[data-pdf-selection="native-preview"]')
    const first = scroll.locator('[data-pdf-page="1"]')
    await expect.poll(() => first.getByRole('document').ariaSnapshot()).toContain(labels[0])
    const actions = reader.getByRole('toolbar', { name: 'Selected text actions' })

    await scroll.focus()
    await page.keyboard.press('Shift+End')
    await actions.getByRole('button', { name: 'Translate', exact: true }).click()
    const panel = reader.locator('.dsh-pdf-translation-content')
    await expect.poll(() => panel.locator('.dsh-pdf-translation-source-text').textContent()).toBe(labels[0])
    await expect.poll(() => panel.locator('.dsh-pdf-translation-text').textContent()).toBe(translated)
    expect(translatedInputs).toEqual([labels[0]])
    await scroll.focus()
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })

    const point = await textPoint(first, geometry.x + 12)
    await page.mouse.dblclick(point.x, point.y)
    await actions.getByRole('button', { name: 'Ask about this passage', exact: true }).click()
    const question = 'What does this word refer to?'
    const editor = reader.getByRole('dialog', { name: 'Ask about this passage' })
    await editor.getByRole('textbox').fill(question)
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await reader.getByRole('button', { name: 'Explanation materials: 1', exact: true }).click()
    const materials = reader.getByRole('dialog', { name: 'Explanation materials' })
    await expect.poll(() => materials.locator('.dsh-pdf-explanation-material small').textContent()).toBe('Page 1 · Alpha')
    expect(await materials.getByText(question, { exact: true }).count()).toBe(1)
    expect(await scroll.locator('span[data-pdf-run]').count()).toBe(0)
    expect(await page.evaluate(() => window.getSelection()?.toString().trim() ?? '')).toBe('')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('keeps real rotated text selectable through the browser fallback', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const title = 'PDF geometry fallback test'
    // Exercise the browser text-layer path explicitly. The native selection
    // preview is a separate capability and is covered by the preceding test;
    // rotated pages must remain selectable when that preview is disabled.
    await seedReader(scaffold, (await selectionFixture(true)).bytes, title, false)
    browser = await launchPdfBrowser()
    const page = await browser.newPage({ viewport: { width: 1680, height: 900 }, locale: 'en-US' })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-native-selection-fallback'))
    const reader = await openReader(page, scaffold.authenticatedUrl, title)
    const scroll = reader.locator('.dsh-pdf-scroll')
    const firstText = scroll.locator('[data-pdf-page="1"] .dsh-pdf-text-layer')
    await expect.poll(() => firstText.textContent()).toContain(labels[0])
    expect(await scroll.getAttribute('data-pdf-selection')).toBeNull()
    expect(await scroll.getByRole('document').count()).toBe(0)
    await scroll.focus()
    await firstText.evaluate(element => {
      const range = element.ownerDocument.createRange()
      range.selectNodeContents(element)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    await page.keyboard.press('Shift')
    const actions = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await actions.waitFor({ state: 'visible' })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(scaffold.authenticatedUrl).origin })
    await actions.getByRole('button', { name: 'Copy text', exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(labels[0])
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
