/** Keyless browser proof through the shipped Web profile, Loader and PDF workspace file. */
import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts, rgb } from 'pdf-lib'
import { build } from 'esbuild'
import type { Browser, Locator, Page as BrowserPage } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode,
} from '../../deepseek-harness/apps/web/tests/scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, openSettings, saveFailureShot } from '../../deepseek-harness/apps/web/tests/support.ts'
import { launchPdfBrowser as launchBrowser } from './browser/launch.ts'
import { recordWheelZoomHandoff, zoomHandoffScenarios } from './browser/zoom-handoff.ts'
import type { SessionOcrLlm } from '../src/adapters/host/dsh/ocr-session-llm.ts'
import { loadPdfDocument } from '../src/adapters/host/pdf-lib/pdf-document.ts'
import { readPagePresentationMeta } from '../src/adapters/host/dsh/pdf-evidence-meta.ts'
import { evidenceSha256 } from '../src/modules/evidence/index.ts'
import { joinPageText } from '../src/shared/page-text.ts'
import { brokenTextMappingFixture } from './fixtures/broken-text-mapping.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { EmbeddingRegistry } from '../src/embedding/index.ts'

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

/** The released SDK dispatches one call; newer source test hosts dispatch batches. */
async function executeScaffoldTool(tools: Context['tools'], input: ToolExecutionInput): Promise<ToolExecutionResult> {
  if (!('setExecutor' in tools)) return tools.execute(input)
  const batchTools = tools as unknown as {
    execute(input: { signal: AbortSignal; agent?: ToolExecutionInput['agent'];
      calls: Array<{ type: 'tool-call'; id: ToolExecutionInput['callId']; name: string; arguments: string }> }):
      Promise<{ results: Array<{ callId: ToolExecutionInput['callId']; result: ToolExecutionResult }> }>
  }
  const batch = await batchTools.execute({ signal: input.signal, agent: input.agent,
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }] })
  expect(batch.results).toHaveLength(1)
  expect(batch.results[0]!.callId).toBe(input.callId)
  return batch.results[0]!.result
}

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
    await expect.poll(() => ocr.inputValue()).toBe('session-llm')
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

it('shows per-PDF indexing progress and cancels and resumes through the shared task entry', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  let unregister: (() => void) | undefined
  const pending: Array<{ signal: AbortSignal; complete(): void }> = []
  try {
    const embeddings = scaffold.ctx.get('pdfEmbedding') as EmbeddingRegistry
    unregister = embeddings.register({
      descriptor: { id: 'fixture.indexing', name: 'Fixture indexing', version: '1', execution: 'local' },
      describe: () => ({ engineId: 'fixture.indexing', engineVersion: '1', model: 'fixture', modelRevision: '1',
        dimensions: 2, maxBatchSize: 16, maxInputCharacters: 16000, encoding: 'fixture', fingerprint: 'fixture-indexing-v1' }),
      async embed(request) {
        return new Promise((resolve, reject) => {
          const abort = () => reject(request.signal.reason ?? new Error('cancelled'))
          const complete = () => { request.signal.removeEventListener('abort', abort); resolve(request.texts.map(() => [1, 0])) }
          pending.push({ signal: request.signal, complete })
          request.signal.addEventListener('abort', abort, { once: true })
          if (request.signal.aborted) abort()
        })
      },
    })
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-indexing-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF indexing test' })
    const document = await PDFDocument.create()
    for (let index = 0; index < 3; index++) document.addPage([300, 400]).drawText(`Indexing page ${index + 1}`, { x: 30, y: 300, size: 12 })
    const name = 'reader-indexing-e2e.pdf'
    await writeFile(join(scaffold.workspaceCwd, name), await document.save())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser), tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-indexing-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached' })
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    await settings.getByRole('combobox', { name: 'Semantic search engine', exact: true }).selectOption('fixture.indexing')
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'pdf-reader')?.value).toMatchObject({ embeddingEngine: 'fixture.indexing' })
    await expect.poll(() => settings.locator('.dsh-pdf-settings-save-status').textContent()).toMatch(/^Settings are up to date/)
    await page.keyboard.press('Escape')
    await page.getByRole('treeitem').filter({ hasText: 'PDF indexing test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible' })
    await reader.locator('.dsh-pdf-activity-trigger').click()
    const tasks = reader.locator('.dsh-pdf-activity-popover')
    const progress = tasks.getByRole('progressbar', { name: `Read pages: ${name}`, exact: true })
    await progress.waitFor({ state: 'visible' })
    // The Reader shell mounts before opening and preparing its durable plan.
    // Wait for the actual embedding phase before inspecting the held request.
    await tasks.getByText('Computing embeddings…', { exact: true }).waitFor()
    await expect.poll(() => pending.length).toBe(1)
    expect(await progress.getAttribute('max')).toBe('3')
    expect(await tasks.getByRole('progressbar', { name: `Indexed passages: ${name}`, exact: true }).count()).toBe(1)
    await tasks.getByRole('button', { name: `Cancel indexing: ${name}`, exact: true }).click()
    await tasks.getByText('Indexing cancelled', { exact: true }).waitFor()
    await expect.poll(() => pending[0]!.signal.aborted).toBe(true)
    // Search owns manual preparation; task notifications own progress and cancellation.
    await openSidebarSection(reader, 'Search')
    const manual = reader.locator('.dsh-pdf-search-indexing').getByRole('button', { name: /^(Index PDF|Update index)$/ })
    await expect.poll(() => manual.isEnabled()).toBe(true)
    await manual.click()
    await expect.poll(() => pending.length).toBe(2)
    if (!await tasks.isVisible()) await reader.locator('.dsh-pdf-activity-trigger').click()
    await progress.waitFor({ state: 'visible' })
    pending[1]!.complete()
    await tasks.getByText('Index ready', { exact: true }).waitFor()
    await expect.poll(() => manual.textContent()).toBe('Update index')
    await expect.poll(() => manual.isEnabled()).toBe(true)
    // Another resource Session opens the same bytes with its own working-copy
    // identity. It must reuse the completed resident index, even without a new
    // embedding reply being made available by this fixture.
    const secondSession = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-indexing-reuse-web-e2e')
    await workspace.attachSession(secondSession)
    await scaffold.ctx.sessionController.rename({ sessionId: secondSession, title: 'PDF indexing reuse test' })
    await page.getByRole('treeitem').filter({ hasText: 'PDF indexing reuse test' }).click()
    if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
    await openSidebarSection(reader, 'Search')
    await expect.poll(() => manual.textContent()).toBe('Update index')
    if (!await tasks.isVisible()) await reader.locator('.dsh-pdf-activity-trigger').click()
    await tasks.getByText('Index ready', { exact: true }).waitFor()
    expect(pending).toHaveLength(2)
    await page.clock.install()
    await page.clock.fastForward(60_000)
    expect(await tasks.locator('.dsh-pdf-indexing-status[data-tone="success"]').count()).toBe(1)
    await reader.locator('.dsh-pdf-activity-trigger').click()
    await reader.locator('.dsh-pdf-activity-trigger').click()
    expect(await tasks.getByText('Index ready', { exact: true }).isVisible()).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  } finally { for (const task of pending) task.complete(); unregister?.(); await browser?.close(); await scaffold.close() }
})

interface IndexingControlsFixture {
  calls(): Array<{ action: string; sessionId: string; documentId: string }>
  errors(): string[]
  revision(): string | undefined
  show(name: string): void
  publish(state: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled', sessionId?: string, documentId?: string): void
  republish(): void
  disable(): void
}

async function mountIndexingControls(page: BrowserPage) {
  page.setDefaultTimeout(5_000)
  const bundle = await build({ entryPoints: [join(ROOT, 'tests/modules/viewer/indexing-controls.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser' })
  const css = await Promise.all(['reader.css', 'reading-sidebar.css', 'glass.css']
    .map(file => readFile(join(ROOT, 'src/client', file), 'utf8')))
  await page.setContent('<div id="indexing-root" style="height:100%;width:100%"></div>')
  await page.addStyleTag({ content: `:root { --dsw-alias-bg-base:#f5f5f5; --dsw-alias-bg-layer-1:#fff; --dsw-alias-label-primary:#222; --dsw-alias-label-secondary:#666; --dsw-alias-border-l2:#ddd; --dsw-alias-link:#4278ed; --dsw-alias-button-primary-fill:#161718; --dsw-alias-label-primary-foreground:#fff; --dsw-alias-bg-document-preview:#edf0f3; --dsw-alias-interactive-bg-hover:#e7e9ed; } html,body { margin:0; height:100%; } ${css.join('\n')}` })
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
  await page.locator('[data-reader-view="first"] .dsh-pdf-search-indexing').getByRole('button', { name: 'Index PDF', exact: true }).waitFor()
}

const indexingFixture = (page: BrowserPage) => ({
  calls: () => page.evaluate(() => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.calls()),
  errors: () => page.evaluate(() => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.errors()),
  revision: () => page.evaluate(() => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.revision()),
  publish: (state: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled', sessionId?: string, documentId?: string) =>
    page.evaluate(input => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.publish(input.state, input.sessionId, input.documentId), { state, sessionId, documentId }),
  show: (name: string) => page.evaluate(name => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.show(name), name),
  republish: () => page.evaluate(() => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.republish()),
  disable: () => page.evaluate(() => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.disable()),
})

async function saveIndexingControlsShot(page: BrowserPage, name: string) {
  const directory = process.env.DSH_PDF_INDEXING_PREVIEW_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.mouse.move(page.viewportSize()!.width - 1, page.viewportSize()!.height - 1)
  await page.screenshot({ path: join(directory, `${name}.png`) })
}

async function openIndexingTasks(reader: Locator) {
  const trigger = reader.locator('.dsh-pdf-activity-trigger')
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
}

it('keeps indexing controls in search and shares dismissible task notifications across Readers through the real Client API', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-indexing-controls'))
    const tripwire = watchConsole(page)
    await mountIndexingControls(page)
    const fixture = indexingFixture(page)
    const first = page.locator('[data-reader-view="first"]')
    const search = first.locator('.dsh-pdf-search-indexing')
    expect(await first.locator('.dsh-pdf-toolbar-index').count()).toBe(0)
    await search.getByRole('button', { name: 'Index PDF', exact: true }).click()
    await expect.poll(fixture.calls).toEqual([{ action: 'start', sessionId: 'session-a', documentId: 'alpha' }])
    await first.locator('.dsh-pdf-activity-trigger').click()
    const task = first.locator('[data-status-id="indexing:alpha"]')
    await task.getByRole('progressbar', { name: 'Read pages: alpha.pdf', exact: true }).waitFor()
    expect(await task.getAttribute('data-tone')).toBe('progress')
    await saveIndexingControlsShot(page, 'indexing-running')
    await task.getByRole('button', { name: 'Cancel indexing: alpha.pdf', exact: true }).click()
    await task.getByText('Indexing cancelled', { exact: true }).waitFor()
    await search.getByRole('button', { name: 'Index PDF', exact: true }).click()
    await expect.poll(async () => (await fixture.calls()).map(call => call.action)).toEqual(['start', 'cancel', 'start'])
    await openIndexingTasks(first)
    await fixture.publish('ready')
    await task.getByRole('button', { name: 'Done: alpha.pdf', exact: true }).waitFor()
    await saveIndexingControlsShot(page, 'indexing-ready')
    await task.getByRole('button', { name: 'Done: alpha.pdf', exact: true }).click()
    expect(await first.locator('[data-status-id="indexing:alpha"]').count()).toBe(0)
    await expect.poll(() => search.getByRole('button', { name: 'Update index', exact: true }).textContent()).toBe('Update index')
    const beforeRepublish = await fixture.revision()
    await fixture.republish()
    await expect.poll(fixture.revision).not.toBe(beforeRepublish)
    expect(await first.locator('[data-status-id="indexing:alpha"]').count()).toBe(0)

    // A second mounted view of the same resource Session shares the acknowledgement.
    await fixture.show('mirror')
    const mirror = page.locator('[data-reader-view="mirror"]')
    await openIndexingTasks(mirror)
    expect(await mirror.locator('[data-status-id="indexing:alpha"]').count()).toBe(0)
    await mirror.locator('.dsh-pdf-search-indexing').getByRole('button', { name: 'Update index', exact: true }).click()
    await expect.poll(async () => (await fixture.calls()).at(-1)).toEqual({ action: 'start', sessionId: 'session-a', documentId: 'alpha' })
    await openIndexingTasks(mirror)
    const mirrorTask = mirror.locator('[data-status-id="indexing:alpha"]')
    await mirrorTask.getByRole('progressbar', { name: 'Read pages: alpha.pdf', exact: true }).waitFor()
    await fixture.publish('failed')
    await expect.poll(() => mirrorTask.getAttribute('data-tone')).toBe('error')
    await saveIndexingControlsShot(page, 'indexing-failed')
    await mirrorTask.getByRole('button', { name: 'Rebuild index: alpha.pdf', exact: true }).click()
    await expect.poll(async () => (await fixture.calls()).map(call => call.action)).toEqual(['start', 'cancel', 'start', 'start', 'rebuild'])
    await fixture.publish('ready')
    await mirrorTask.getByRole('button', { name: 'Done: alpha.pdf', exact: true }).click()
    await fixture.show('first')
    expect(await first.locator('[data-status-id="indexing:alpha"]').count()).toBe(0)

    // Another Session has its own notifications, even when its view was hidden.
    await fixture.publish('ready', 'session-b', 'beta')
    await fixture.show('other-session')
    const other = page.locator('[data-reader-view="other-session"]')
    await openIndexingTasks(other)
    await other.getByRole('button', { name: 'Done: beta.pdf', exact: true }).waitFor()
    expect(await fixture.errors()).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  } finally { await browser.close() }
})

it('keeps indexing actions reachable in the short search panel and hides manual commands when semantic indexing is disabled', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 320 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-indexing-controls-short'))
    await mountIndexingControls(page)
    const fixture = indexingFixture(page)
    const reader = page.locator('[data-reader-view="first"]')
    const search = reader.locator('.dsh-pdf-search-indexing')
    const start = search.getByRole('button', { name: 'Index PDF', exact: true })
    await start.click()
    const bounds = await start.evaluate(element => {
      const button = element.getBoundingClientRect(), panel = element.closest('.dsh-pdf-search-panel')!.getBoundingClientRect()
      return { inside: button.left >= panel.left && button.right <= panel.right && button.top >= panel.top && button.bottom <= panel.bottom }
    })
    expect(bounds.inside).toBe(true)
    // Settings actions must also fit the true minimum drawer width. Their
    // complete labels can wrap instead of widening the shared scrollport.
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    await sidebar.locator('.dsh-pdf-sidebar-divider').press('Home')
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    const scroll = reader.locator('.dsh-pdf-search-panel > .dsh-pdf-panel-scroll')
    expect(await scroll.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const settingsActions = search.locator('.dsh-pdf-index-secondary-actions button')
    expect(await settingsActions.count()).toBe(2)
    const settingsBounds = await settingsActions.evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect(), viewport = button.closest('.dsh-pdf-panel-scroll')!.getBoundingClientRect()
      return { fits: box.left >= viewport.left - 1 && box.right <= viewport.right + 1,
        textFits: button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1 }
    }))
    expect(settingsBounds.every(button => button.fits && button.textFits)).toBe(true)
    await saveIndexingControlsShot(page, 'indexing-search-short')
    expect(await reader.locator('[data-pdf-tool-rail] [data-document-command="index"]').count()).toBe(0)
    await reader.locator('.dsh-pdf-document-menu > summary').click()
    expect(await reader.locator('.dsh-pdf-tools-menu').getByRole('button', { name: /Index PDF|Update index|Recompute entire index/ }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await reader.locator('.dsh-pdf-activity-trigger').click()
    await reader.getByRole('button', { name: 'Cancel indexing: alpha.pdf', exact: true }).click()
    await fixture.disable()
    await expect.poll(() => search.getByRole('button', { name: /^(Index PDF|Update index|Recompute entire index)$/ }).count()).toBe(0)
    expect(await search.getByRole('combobox').count()).toBe(0)
    expect(await search.getByRole('checkbox').count()).toBe(2)
    expect(await search.getByRole('checkbox', { name: 'Recognize scanned or damaged text', exact: true }).isEnabled()).toBe(true)
    expect(await search.getByRole('button', { name: 'Use current defaults', exact: true }).isEnabled()).toBe(true)
    expect(await fixture.errors()).toEqual([])
  } finally { await browser.close() }
})

it('saves only document content switches across mirror views without starting work or changing another PDF', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 620 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-document-index-settings'))
    const tripwire = watchConsole(page)
    await mountIndexingControls(page)
    const fixture = indexingFixture(page)
    const first = page.locator('[data-reader-view="first"]')
    const settings = first.locator('.dsh-pdf-search-indexing')
    await fixture.publish('ready')
    await expect.poll(() => settings.getByRole('button', { name: 'Update index', exact: true }).isEnabled()).toBe(true)
    expect(await settings.getByRole('combobox').count()).toBe(0)
    expect(await settings.getByRole('checkbox').count()).toBe(2)
    await settings.getByRole('checkbox', { name: 'Include image descriptions', exact: true }).check()
    await expect.poll(fixture.calls).toEqual([{ action: 'configure', sessionId: 'session-a', documentId: 'alpha' }])
    await settings.getByText('Settings saved. The existing index is still using its previous settings.', { exact: true }).waitFor()
    expect(await first.locator('[data-status-id="indexing:alpha"][data-tone="success"]').count()).toBe(1)

    await fixture.show('other-document')
    const another = page.locator('[data-reader-view="other-document"] .dsh-pdf-search-indexing')
    expect(await another.getByRole('checkbox', { name: 'Include image descriptions', exact: true }).isChecked()).toBe(false)
    expect(await another.getByRole('combobox').count()).toBe(0)
    await fixture.show('mirror')
    const mirror = page.locator('[data-reader-view="mirror"]')
    const mirrorSettings = mirror.locator('.dsh-pdf-search-indexing')
    expect(await mirrorSettings.getByRole('checkbox', { name: 'Include image descriptions', exact: true }).isChecked()).toBe(true)
    expect(await mirrorSettings.getByRole('combobox').count()).toBe(0)
    await mirrorSettings.getByRole('button', { name: 'Update index', exact: true }).click()
    await expect.poll(async () => (await fixture.calls()).map(call => call.action)).toEqual(['configure', 'start'])
    await fixture.publish('ready')
    await mirrorSettings.getByText('Settings saved for this PDF.', { exact: true }).waitFor()
    await mirrorSettings.getByRole('checkbox', { name: 'Recognize scanned or damaged text', exact: true }).uncheck()
    await expect.poll(async () => (await fixture.calls()).map(call => call.action)).toEqual(['configure', 'start', 'configure'])
    expect(await mirrorSettings.getByRole('checkbox', { name: 'Include image descriptions', exact: true }).isChecked()).toBe(true)
    await mirrorSettings.getByRole('button', { name: 'Use current defaults', exact: true }).click()
    await expect.poll(async () => (await fixture.calls()).map(call => call.action)).toEqual(['configure', 'start', 'configure', 'defaults'])
    expect(await mirrorSettings.getByRole('checkbox', { name: 'Recognize scanned or damaged text', exact: true }).isChecked()).toBe(true)
    expect(await mirrorSettings.getByRole('checkbox', { name: 'Include image descriptions', exact: true }).isChecked()).toBe(false)

    await fixture.show('other-session')
    const other = page.locator('[data-reader-view="other-session"] .dsh-pdf-search-indexing')
    expect(await other.getByRole('checkbox', { name: 'Include image descriptions', exact: true }).isChecked()).toBe(false)
    expect(await other.getByRole('combobox').count()).toBe(0)
    expect(await fixture.errors()).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  } finally { await browser.close() }
})

it('recovers an invalid Unicode text layer and allows dragging the formerly missing English label', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-text-recovery-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF text recovery test' })
    const path = join(scaffold.workspaceCwd, 'reader-broken-text-e2e.pdf'), bytes = await brokenTextMappingFixture()
    await writeFile(path, bytes)
    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('treeitem').filter({ hasText: 'PDF text recovery test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: 'reader-broken-text-e2e.pdf' }).click()
    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible' })
    const words = reader.locator('[data-pdf-page="1"] .dsh-pdf-text-layer span')
    // Opening the Reader precedes native rendering and local OCR startup.
    // Wait for the recovered text layer before checking its exact contents.
    await words.first().waitFor({ state: 'visible' })
    await expect.poll(() => words.allTextContents()).toEqual(['Full ', 'name ', 'in ', 'English'])
    const first = await words.first().boundingBox(), last = await words.last().boundingBox()
    expect(first).not.toBeNull(); expect(last).not.toBeNull()
    await page.mouse.move(first!.x + 1, first!.y + first!.height / 2)
    await page.mouse.down()
    await page.mouse.move(last!.x + last!.width - 1, last!.y + last!.height / 2, { steps: 12 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Full name in English')
    await expect.poll(() => reader.locator('.dsh-pdf-selection-overlay div').count()).toBeGreaterThan(0)
    expect(new Uint8Array(await readFile(path))).toEqual(bytes)
  } finally { await browser?.close(); await scaffold.close() }
})

it('fills an AcroForm field through the Reader and saves its Unicode appearance', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] },
    replayFixture: join(DSH_ROOT, 'apps/web/tests/fixtures/deepseek-model-label-1017/session.v4.jsonl'),
    replayProvidersOnly: true })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-form-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF form test' })
    const path = join(scaffold.workspaceCwd, 'reader-form-e2e.pdf')
    const document = await PDFDocument.create()
    const pageSource = document.addPage([300, 400])
    pageSource.drawText('1. PERSONAL DETAILS', { x: 20, y: 330, size: 12 })
    pageSource.drawText('Applicant name', { x: 30, y: 143, size: 10 })
    pageSource.drawText('If option 2 is checked, provide applicant name', { x: 20, y: 250, size: 9 })
    pageSource.drawText('Select one option', { x: 20, y: 280, size: 9 })
    document.getForm().createTextField('applicant').addToPage(pageSource,
      { x: 30, y: 100, width: 150, height: 30 })
    for (let index = 0; index < 3; index++) {
      const checkbox = document.getForm().createCheckBox(`original-${index}`)
      checkbox.addToPage(pageSource, { x: 30 + index * 40, y: 180, width: 20, height: 20 })
      pageSource.drawText(`Option ${index + 1}`, { x: 30 + index * 40, y: 205, size: 7 })
      checkbox.acroField.setPartialName('shared-choice')
    }
    await writeFile(path, await document.save())

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('treeitem').filter({ hasText: 'PDF form test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: 'reader-form-e2e.pdf' }).click()
    const reader = page.locator('.dsh-pdf-reader')
    const field = reader.getByRole('textbox', { name: 'applicant' })
    await field.waitFor({ state: 'visible' })
    const saveAs = await documentAction(reader, 'Save as')
    const enabledOpacity = await saveAs.evaluate(element => getComputedStyle(element).opacity)
    await saveAs.evaluate(element => { (element as HTMLButtonElement).disabled = true })
    expect(await saveAs.evaluate(element => getComputedStyle(element).opacity)).toBe(enabledOpacity)
    await saveAs.evaluate(element => { (element as HTMLButtonElement).disabled = false })
    if (await reader.locator('.dsh-pdf-tools > summary').getAttribute('aria-expanded') === 'true')
      await reader.locator('.dsh-pdf-tools > summary').click()

    // The model uses the exact same working copy as the already-visible Reader.
    // Draft edits must appear without a reload and support the user's Undo.
    await scaffold.ctx.sessionController.selectModel({ sessionId,
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    const resolved = await scaffold.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    // Selection is pending until a request starts. This keyless tool invocation
    // records that request header without making an external model call.
    resolved.agent.session.append('request/header', { reason: 'change',
      header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' } } })
    const pdf = scaffold.ctx.get('pdf') as unknown as {
      dispatch(sessionId: string, input: Record<string, unknown>, agent: typeof resolved.agent,
        signal: AbortSignal): Promise<{ id: string; revision: number; document: { formFields: Array<{ id: string; name: string }> } }>
    }
    const signal = new AbortController().signal
    const address = `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path.split('/').map(encodeURIComponent).join('/')}`
    const opened = await pdf.dispatch(sessionId, { action: 'open', sessionId, address }, resolved.agent, signal)
    const inspected = await executeScaffoldTool(scaffold.ctx.tools, { signal, callId: ToolCallId('pdf-inspect-form-web-e2e'),
      name: 'pdf_form_inspect', arguments: { documentId: opened.id, page: 1 }, agent: resolved.agent })
    expect(inspected.isError, JSON.stringify(inspected)).toBe(false)
    const inspectText = inspected.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const inspection = JSON.parse(inspectText.slice(inspectText.indexOf('{'))) as { inspectionId: string; revision: number;
      fields: Array<{ type: string; controls: Array<{ label: string }>; value?: string | boolean }> }
    expect(inspectText).not.toContain('fieldId')
    expect(inspected.content.filter(block => block.type === 'image')).toHaveLength(1)
    expect(inspection).not.toHaveProperty('context')
    expect(inspection).not.toHaveProperty('understanding')
    expect(inspection).not.toHaveProperty('semanticQuestions')
    const inspectionId = inspection.inspectionId
    const applicantLabel = inspection.fields.find(field => field.type === 'text')!.controls[0].label
    const checkboxLabel = inspection.fields.filter(field => field.type === 'checkbox')[1]!.controls[0].label
    const failed = await executeScaffoldTool(scaffold.ctx.tools, { signal, callId: ToolCallId('pdf-fill-form-invalid-web-e2e'),
      name: 'pdf_form_fill', arguments: { documentId: opened.id, expectedRevision: opened.revision,
        inspectionId, fields: [{ label: applicantLabel, value: '模型填写' }, { label: checkboxLabel, value: 'Yes' }] },
      agent: resolved.agent })
    expect(failed.isError, JSON.stringify(failed)).toBe(false)
    const text = failed.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const failure = JSON.parse(text.slice(text.indexOf('{'))) as { status: string; appliedCount: number;
      revision: number; page: number; issues: Array<{ code: string; label: string; expected: string }> }
    expect(failure.status).toBe('validation_failed'); expect(failure.appliedCount).toBe(0)
    expect(failure.page).toBe(1)
    expect(failure.issues[0]).toMatchObject({ label: checkboxLabel, code: 'value_type_mismatch', expected: 'boolean' })
    expect(await field.inputValue()).toBe('')
    // Printed dependencies and independent-checkbox groups are supplied explicitly.
    const conditions = [{ fields: [{ label: applicantLabel }],
      when: { label: checkboxLabel, equals: true },
      evidence: { quote: 'If option 2 is checked, provide applicant name' } }]
    const inactive = await executeScaffoldTool(scaffold.ctx.tools, { signal, callId: ToolCallId('pdf-fill-inactive-web-e2e'),
      name: 'pdf_form_fill', arguments: { documentId: opened.id, expectedRevision: failure.revision,
        inspectionId, conditions, fields: [{ label: applicantLabel, value: 'Must not fill' }] }, agent: resolved.agent })
    const inactiveText = inactive.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(inactiveText).toContain('condition_failed'); expect(inactiveText).toContain('condition_not_met')
    expect(await field.inputValue()).toBe('')
    const alternatives = inspection.fields.filter(field => field.type === 'checkbox').map(field => ({ label: field.controls[0].label }))
    const choiceGroups = [{ fields: alternatives, evidence: { quote: 'Select one option' } }]
    const multiple = await executeScaffoldTool(scaffold.ctx.tools, { signal, callId: ToolCallId('pdf-fill-exclusive-invalid-web-e2e'),
      name: 'pdf_form_fill', arguments: { documentId: opened.id, expectedRevision: failure.revision,
        inspectionId, conditions, choiceGroups, fields: [{ label: applicantLabel, value: 'Must not write' },
          ...alternatives.slice(0, 2).map(ref => ({ ...ref, value: true }))] }, agent: resolved.agent })
    const multipleText = multiple.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(multipleText).toContain('choice_failed'); expect(multipleText).toContain('multiple_choices_selected')
    expect(multipleText).not.toContain('fieldId')
    expect(await field.inputValue()).toBe('')
    const filled = await executeScaffoldTool(scaffold.ctx.tools, { signal, callId: ToolCallId('pdf-fill-form-web-e2e'),
      name: 'pdf_form_fill', arguments: { documentId: opened.id, expectedRevision: failure.revision,
        inspectionId, conditions, choiceGroups, fields: [{ label: applicantLabel, value: '模型填写' }, { label: checkboxLabel, value: true }] }, agent: resolved.agent })
    expect(filled.isError, JSON.stringify(filled)).toBe(false)
    const filledText = filled.content.find(block => block.type === 'text')!.text
    const filledData = JSON.parse(filledText.slice(filledText.indexOf('{')))
    expect(filledData.status).toBe('updated')
    expect(filled.content.filter(block => block.type === 'image')).toHaveLength(0)
    expect(filledData).not.toHaveProperty('semanticReview')
    expect(filledData.choiceReview.evaluated).toBe(1)
    await expect.poll(() => field.inputValue()).toBe('模型填写')
    const verified = await executeScaffoldTool(scaffold.ctx.tools, { signal, callId: ToolCallId('pdf-verify-form-web-e2e'),
      name: 'pdf_form_inspect', arguments: { documentId: opened.id, page: 1, includeValues: true }, agent: resolved.agent })
    expect(verified.isError, JSON.stringify(verified)).toBe(false)
    const verifiedText = verified.content.find(block => block.type === 'text')!.text
    const verifiedFields = (JSON.parse(verifiedText.slice(verifiedText.indexOf('{'))) as typeof inspection).fields
    expect(verifiedFields.find(field => field.type === 'text')!.value).toBe('模型填写')
    expect(verifiedFields.filter(field => field.type === 'checkbox').map(field => field.value)).toEqual([false, true, false])
    expect((await PDFDocument.load(await readFile(path))).getForm().getTextField('applicant').getText()).toBeUndefined()
    await reader.locator('.dsh-pdf-tool-history .dsh-pdf-toolbar-undo').click()
    await expect.poll(() => field.inputValue()).toBe('')
    const sameNameBoxes = reader.getByRole('checkbox', { name: 'shared-choice', exact: true })
    expect(await sameNameBoxes.count()).toBe(3)
    expect(await sameNameBoxes.nth(1).isChecked()).toBe(false)
    await sameNameBoxes.nth(1).click()
    await expect.poll(() => sameNameBoxes.nth(1).isChecked()).toBe(true)
    expect(await sameNameBoxes.nth(0).isChecked()).toBe(false)
    expect(await sameNameBoxes.nth(2).isChecked()).toBe(false)
    await field.fill('测试申请人')
    await field.press('Tab')
    const save = reader.locator('.dsh-pdf-toolbar-save')
    await expect.poll(() => save.isEnabled()).toBe(true)
    await save.click()
    await expect.poll(async () => {
      const saved = await PDFDocument.load(await readFile(path))
      return saved.getForm().getTextField('applicant').getText()
    }).toBe('测试申请人')
    const reopened = await PDFDocument.load(await readFile(path))
    expect(reopened.getForm().getFields().filter(field => field.getName() === 'shared-choice')
      .map(field => (field as PDFCheckBox).isChecked())).toEqual([false, true, false])
    await expect.poll(() => save.isDisabled()).toBe(true)
  } finally { await browser?.close(); await scaffold.close() }
})

async function chooseZoom(reader: Locator, label: string) {
  const zoom = reader.locator('.dsh-pdf-toolbar-zoom')
  await zoom.locator('summary').click()
  await reader.locator('.dsh-pdf-zoom-menu').getByRole('button', { name: label, exact: true }).click()
}

const fileActions = (reader: Locator) => reader.locator('.dsh-pdf-tools-menu[aria-label="Document actions"]')

/** Document commands are direct in tall readers and use the menu in short readers. */
async function documentAction(reader: Locator, name: string | RegExp): Promise<Locator> {
  const direct = reader.locator('.dsh-pdf-document-direct').getByRole('button', { name, exact: true })
  if (await direct.isVisible()) return direct
  const trigger = reader.locator('.dsh-pdf-tools > summary')
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  const command = fileActions(reader).getByRole('button', { name, exact: true })
  await command.waitFor({ state: 'visible' })
  return command
}

/** Both floating rails share a full-width canvas; neither creates an inner clipping column. */
async function expectFloatingToolRails(reader: Locator) {
  const geometry = await reader.evaluate(element => {
    const toolbar = element.querySelector<HTMLElement>('[data-pdf-tool-rail]')!
    const body = element.querySelector<HTMLElement>('.dsh-pdf-body')!
    const content = element.querySelector<HTMLElement>('.dsh-pdf-content')!
    const sidebar = element.querySelector<HTMLElement>('.dsh-pdf-sidebar')!
    const glass = toolbar.querySelector<HTMLElement>('.dsh-pdf-tool-rail-shell')!
    return { glass: glass.getBoundingClientRect().toJSON(), rail: toolbar.getBoundingClientRect().toJSON(), body: body.getBoundingClientRect().toJSON(),
      content: content.getBoundingClientRect().toJSON(), sidebar: sidebar.getBoundingClientRect().toJSON(),
      sibling: toolbar.parentElement === body && content.parentElement === body,
      groups: toolbar.querySelectorAll('.dsh-pdf-tool-rail-shell > [data-tool-group]').length }
  })
  expect(geometry.sibling).toBe(true)
  expect(geometry.groups).toBe(3)
  expect(geometry.rail.width).toBe(56)
  for (const edge of ['left', 'right', 'top', 'bottom'] as const)
    expect(Math.abs(geometry.content[edge] - geometry.body[edge]), `canvas ${edge}`).toBeLessThanOrEqual(1)
  expect(geometry.rail.left).toBeGreaterThan(geometry.body.left)
  expect(geometry.glass.top).toBeGreaterThan(geometry.body.top)
  expect(geometry.glass.bottom).toBeLessThan(geometry.body.bottom)
  expect(geometry.rail.right).toBeLessThanOrEqual(geometry.sidebar.left)
  expect(geometry.sidebar.right).toBeLessThan(geometry.body.right)
}

/** A selected tab also closes its panel; tests that need a panel open must say so explicitly. */
async function openSidebarSection(reader: Locator, name: string) {
  const tab = reader.getByRole('tab', { name, exact: true })
  if (await tab.getAttribute('aria-expanded') !== 'true') await tab.click()
}

async function captureToolbarEditsAria(page: BrowserPage, workspaceCwd: string) {
  return [await captureStableAria(page, '.dsh-pdf-tool-history', workspaceCwd),
    await captureStableAria(page, '.dsh-pdf-toolbar-save', workspaceCwd)].map(value => value.trim()).join('\n')
}

/** All persistent actions in the one-piece rail remain icon-only at every width. */
async function expectIconOnlyMainToolbar(toolbar: Locator) {
  const presentation = await toolbar.evaluate(element => {
    const visible = (control: HTMLElement) => control.getClientRects().length > 0
      && getComputedStyle(control).display !== 'none'
      && getComputedStyle(control).visibility !== 'hidden'
    const actions = [...element.querySelectorAll<HTMLElement>(
      '[data-tool-group] > button, [data-tool-group] > .dsh-pdf-toolbar-disclosure > summary, '
      + '.dsh-pdf-toolbar-back-split > button, .dsh-pdf-tool-availability > button, '
      + '.dsh-pdf-tool-middle > button, .dsh-pdf-explanation-area-action > button, .dsh-pdf-save-control > button, '
      + '.dsh-pdf-tool-history > button, .dsh-pdf-activity-trigger, '
      + '.dsh-pdf-document-direct > button',
    )]
      .filter(visible).map(control => {
        const label = control.querySelector<HTMLElement>('.dsh-pdf-toolbar-label')
        const labelBox = label?.getBoundingClientRect()
        return {
          ariaLabel: control.getAttribute('aria-label'),
          tooltip: control.closest('[data-tooltip]')?.getAttribute('data-tooltip') ?? control.getAttribute('title'),
          hasIcon: !!control.querySelector('svg,.dsh-pdf-floating-status-spinner'),
          visibleLabel: !!labelBox && labelBox.width > 4 && labelBox.height > 4,
        }
      })
    return { actions,
      historyCommands: [...element.querySelectorAll<HTMLElement>('.dsh-pdf-tool-history > button')].filter(visible).length,
      directCommands: [...element.querySelectorAll<HTMLElement>('.dsh-pdf-document-direct > button')].filter(visible).length,
      documentMenu: [...element.querySelectorAll<HTMLElement>('.dsh-pdf-document-menu > summary')].filter(visible).length }
  })
  // Nine persistent navigation/interaction/save/task actions; document history
  // and file commands move into the document menu at short container heights.
  expect(presentation.actions).toHaveLength(9 + presentation.historyCommands + presentation.directCommands + presentation.documentMenu)
  expect(presentation.actions.every(action => action.ariaLabel?.trim())).toBe(true)
  expect(presentation.actions.every(action => action.tooltip?.trim())).toBe(true)
  expect(presentation.actions.every(action => action.hasIcon)).toBe(true)
  expect(presentation.actions.every(action => !action.visibleLabel)).toBe(true)
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

/** Sample the raw PDF crop returned by the screenshot action. */
async function screenshotPagePixels(page: BrowserPage) {
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

function expectUnannotatedPage(rows: Awaited<ReturnType<typeof screenshotPagePixels>>) {
  for (const row of rows) for (const sample of [row.left, row.overlap, row.right]) {
    expect(Math.max(...sample.map((channel, index) => Math.abs(channel - row.paper[index]))), JSON.stringify(row))
      .toBeLessThanOrEqual(4)
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

async function mountReaderToolRail(page: BrowserPage, fixture = 'reader-toolbar-layout', root = 'toolbar-root') {
  page.setDefaultTimeout(5_000)
  const bundle = await build({ entryPoints: [join(ROOT, 'tests', 'modules', 'viewer', `${fixture}.web.fixture.tsx`)],
    bundle: true, write: false, format: 'iife', platform: 'browser' })
  await page.setContent(`<div id="${root}" style="height:100%;width:100%"></div>`)
  const css = await Promise.all(['reader.css', 'reading-sidebar.css', 'annotation-comment-card.css', 'glass.css']
    .map(file => readFile(join(ROOT, 'src/client', file), 'utf8')))
  await page.addStyleTag({ content: `:root { --dsw-alias-bg-base:#f5f5f5; --dsw-alias-bg-layer-1:#fff; --dsw-alias-label-primary:#222; --dsw-alias-label-secondary:#666; --dsw-alias-border-l2:#ddd; --dsw-alias-link:#4278ed; --dsw-alias-button-primary-fill:#161718; --dsw-alias-label-primary-foreground:#fff; --dsw-alias-bg-document-preview:#edf0f3; --dsw-alias-interactive-bg-hover:#e7e9ed; } html,body { margin:0; height:100%; } ${css.join('\n')}` })
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
  await page.locator('[data-pdf-tool-rail]').waitFor()
}

type ToolRailInput = Partial<import('./modules/viewer/reader-toolbar-layout.web.fixture.tsx').ReaderToolbarLayoutInput>
type ToolRailFixture = { set(input: ToolRailInput): void; calls(): string[]; resetCalls(): void }
const setToolRail = (page: BrowserPage, input: ToolRailInput) => page.evaluate(value =>
  (window as typeof window & { __pdfToolbarLayoutFixture: ToolRailFixture }).__pdfToolbarLayoutFixture.set(value), input)
const toolRailCalls = (page: BrowserPage) => page.evaluate(() =>
  (window as typeof window & { __pdfToolbarLayoutFixture: ToolRailFixture }).__pdfToolbarLayoutFixture.calls())
async function saveToolRailShot(page: BrowserPage, name: string) {
  const directory = process.env.DSH_PDF_TOOL_RAIL_PREVIEW_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.mouse.move(page.viewportSize()!.width - 1, page.viewportSize()!.height - 1)
  await page.screenshot({ path: join(directory, `${name}.png`) })
  const boxes = await page.locator('.dsh-pdf-reader').evaluate(element => {
    const selectors = ['[data-pdf-tool-rail]', '[data-tool-group]', '.dsh-pdf-sidebar', '.dsh-pdf-sidebar-rail-shell', '.dsh-pdf-sidebar-main', '.dsh-pdf-scroll', '.dsh-pdf-annotation-toolbar',
      '.dsh-pdf-highlight-menu', '.dsh-pdf-page-comment-card', '.dsh-pdf-comment-editor-header',
      '.dsh-pdf-comment-editor-actions', '.dsh-pdf-comment-editor textarea', '.dsh-pdf-comment-editor button']
    return [...element.querySelectorAll<HTMLElement>(selectors.join(', '))]
      .map(control => ({ element: control.getAttribute('data-tool-group') ?? control.getAttribute('aria-label') ?? control.className,
        bounds: control.getBoundingClientRect().toJSON(), scrollWidth: control.scrollWidth, clientWidth: control.clientWidth,
        scrollLeft: control.scrollLeft, scrollTop: control.scrollTop, scrollHeight: control.scrollHeight, clientHeight: control.clientHeight }))
  })
  await writeFile(join(directory, `${name}.json`), JSON.stringify(boxes, null, 2))
}

type ReaderSaveInput = import('./modules/viewer/reader-save.web.fixture.tsx').ReaderSaveFixtureInput
type ReaderSaveFixture = { set(input: ReaderSaveInput): void; calls(): number[]; errors(): string[]; resolve(): void; reject(): void }
const setReaderSave = (page: BrowserPage, input: ReaderSaveInput) => page.evaluate(value =>
  (window as typeof window & { __pdfReaderSaveFixture: ReaderSaveFixture }).__pdfReaderSaveFixture.set(value), input)
const settleReaderSave = (page: BrowserPage, outcome: 'resolve' | 'reject') => page.evaluate(value =>
  (window as typeof window & { __pdfReaderSaveFixture: ReaderSaveFixture }).__pdfReaderSaveFixture[value](), outcome)

it('keeps save feedback in the command through a delayed save, brief success, and new edits', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 700 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-save-lifecycle'))
    await mountReaderToolRail(page, 'reader-save', 'save-root')
    const save = page.getByRole('button', { name: 'Save', exact: true })
    const control = page.locator('.dsh-pdf-save-control')
    const state = () => save.getAttribute('data-save-state')
    await expect.poll(state).toBe('dirty')
    const normal = await save.evaluate(element => ({ color: getComputedStyle(element).color, opacity: getComputedStyle(element).opacity }))
    expect(normal.opacity).toBe('1')
    expect(await control.getAttribute('tabindex')).toBeNull()
    await setReaderSave(page, { mutationBusy: true })
    await expect.poll(() => save.isDisabled()).toBe(true)
    expect(await save.evaluate(element => ({ color: getComputedStyle(element).color, opacity: getComputedStyle(element).opacity }))).toEqual(normal)
    await setReaderSave(page, { mutationBusy: false })
    await expect.poll(() => save.isEnabled()).toBe(true)
    // Two synchronous native activations also exercise the production mutation lock.
    await save.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click() })
    await expect.poll(state).toBe('saving')
    expect(await save.isDisabled()).toBe(true)
    expect(await save.locator('.dsh-pdf-save-spinner').count()).toBe(1)
    await page.waitForTimeout(2800)
    expect(await state()).toBe('saving')
    expect(await page.evaluate(() => (window as typeof window & { __pdfReaderSaveFixture: ReaderSaveFixture }).__pdfReaderSaveFixture.calls())).toEqual([1])
    await page.locator('.dsh-pdf-activity-trigger').click()
    await expect.poll(() => page.locator('[data-status-id="save"] .dsh-pdf-floating-status-content').textContent()).toBe('Saving…')
    await page.keyboard.press('Escape')
    await saveToolRailShot(page, 'save-saving-1180x700')
    await settleReaderSave(page, 'resolve')
    await expect.poll(state).toBe('saved-success')
    expect(await save.isDisabled()).toBe(true)
    expect(await save.locator('[data-icon="check"]').count()).toBe(1)
    await expect.poll(() => save.evaluate(element => ({ color: getComputedStyle(element).color, opacity: getComputedStyle(element).opacity })))
      .toEqual({ color: 'rgb(34, 160, 107)', opacity: '1' })
    await saveToolRailShot(page, 'save-success-1180x700')
    await page.waitForTimeout(900)
    expect(await state()).toBe('saved-success')
    await expect.poll(state, { timeout: 2500 }).toBe('saved')
    expect(await save.locator('[data-icon="save"]').count()).toBe(1)
    expect(await control.getAttribute('data-tooltip')).toBe('All changes saved')
    expect(await page.locator('.dsh-pdf-activity-trigger').getAttribute('data-kind')).toBeNull()
    await setReaderSave(page, { dirty: true })
    await expect.poll(state).toBe('dirty')
    await save.click()
    await expect.poll(state).toBe('saving')
    await settleReaderSave(page, 'resolve')
    await expect.poll(state).toBe('saved-success')
    await setReaderSave(page, { dirty: true })
    await expect.poll(state).toBe('dirty')
    expect(await save.isEnabled()).toBe(true)
    expect(await save.locator('[data-icon="check"]').count()).toBe(0)
    expect(await page.locator('.dsh-pdf-document-state').count()).toBe(0)
  } finally { await browser.close() }
})

it('keeps failed save feedback until a retry replaces it and shares the activity error', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 700 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-save-retry'))
    await mountReaderToolRail(page, 'reader-save', 'save-root')
    const save = page.getByRole('button', { name: 'Save', exact: true })
    await save.click()
    await expect.poll(() => save.getAttribute('data-save-state')).toBe('saving')
    await settleReaderSave(page, 'reject')
    await expect.poll(() => save.getAttribute('data-save-state')).toBe('failed')
    expect(await save.isEnabled()).toBe(true)
    expect(await save.locator('[data-icon="warning"]').count()).toBe(1)
    await save.hover()
    await expect.poll(() => save.evaluate(element => getComputedStyle(element).color)).toBe('rgb(217, 56, 62)')
    expect(await page.locator('.dsh-pdf-save-control').getAttribute('data-tooltip')).toBe('Save failed. Check the error and retry.')
    await page.locator('.dsh-pdf-tool-history .dsh-pdf-toolbar-undo').focus()
    await page.keyboard.press('Tab')
    expect(await save.evaluate(element => document.activeElement === element)).toBe(true)
    await expect.poll(() => page.getByRole('tooltip').textContent()).toBe('Save failed. Check the error and retry.')
    expect(await save.evaluate(element => getComputedStyle(element).color)).toBe('rgb(217, 56, 62)')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(2800)
    expect(await save.getAttribute('data-save-state')).toBe('failed')
    await page.locator('.dsh-pdf-activity-trigger').click()
    await expect.poll(() => page.locator('[data-status-id="save"] .dsh-pdf-floating-status-content').textContent())
      .toBe('Save failed. Check the error and retry.')
    expect(await page.locator('[data-status-id="save"]').getAttribute('data-tone')).toBe('error')
    await saveToolRailShot(page, 'save-failed-1180x700')
    await page.keyboard.press('Escape')
    await save.click()
    await expect.poll(() => save.getAttribute('data-save-state')).toBe('saving')
    expect(await page.locator('.dsh-pdf-activity-trigger').getAttribute('data-kind')).toBe('saving')
    await settleReaderSave(page, 'resolve')
    await expect.poll(() => save.getAttribute('data-save-state')).toBe('saved-success')
    expect(await page.evaluate(() => (window as typeof window & { __pdfReaderSaveFixture: ReaderSaveFixture }).__pdfReaderSaveFixture.calls())).toEqual([1, 1])
    expect(await page.evaluate(() => (window as typeof window & { __pdfReaderSaveFixture: ReaderSaveFixture }).__pdfReaderSaveFixture.errors()))
      .toEqual(['Error: Disk is full'])
  } finally { await browser.close() }
})

it('keeps save geometry fixed in every state with disabled hover and keyboard explanations', async () => {
  const browser = await launchBrowser()
  try {
    for (const viewport of [{ width: 1180, height: 700 }, { width: 360, height: 400 }]) {
      const page = await browser.newPage({ viewport })
      onTestFailed(() => saveFailureShot(page, `pdf-save-geometry-${viewport.height}`))
      await mountReaderToolRail(page, 'reader-save', 'save-root')
      const save = page.getByRole('button', { name: 'Save', exact: true })
      const control = page.locator('.dsh-pdf-save-control')
      const baseline = await save.boundingBox()
      expect(baseline).toMatchObject({ width: 36, height: viewport.height > 440 ? 36 : 30 })
      const check = async (state: string) => {
        await expect.poll(() => save.getAttribute('data-save-state')).toBe(state)
        expect(await save.boundingBox()).toEqual(baseline)
        expect(await control.boundingBox()).toEqual(baseline)
        expect(await save.getAttribute('aria-label')).toBe('Save')
        expect(await page.locator('.dsh-pdf-document-state').count()).toBe(0)
      }
      await check('dirty')
      for (const [input, state, label] of [
        [{ loading: true }, 'loading', 'Opening PDF…'],
        [{ loading: false, readOnly: true }, 'read-only', 'Read only'],
        [{ readOnly: false, conflict: true }, 'conflict', 'Source changed'],
        [{ conflict: false, pending: true }, 'pending', 'Apply the open note or comment before saving the document.'],
        [{ pending: false, dirty: false }, 'saved', 'All changes saved'],
      ] as const) {
        await setReaderSave(page, input)
        await check(state)
        expect(await save.isDisabled()).toBe(true)
        expect(await control.getAttribute('tabindex')).toBe('0')
        expect(await control.getAttribute('role')).toBe('group')
        expect(await control.getAttribute('data-tooltip')).toBe(label)
        const describedBy = (await control.getAttribute('aria-describedby'))!
        expect(await page.locator(`[id="${describedBy}"]`).textContent()).toBe(label)
      }
      await control.hover()
      await expect.poll(() => page.getByRole('tooltip').textContent()).toBe('All changes saved')
      await page.mouse.move(viewport.width - 1, 1)
      await expect.poll(() => page.getByRole('tooltip').count()).toBe(0)
      // Tab from the preceding enabled control reaches the disabled command's wrapper.
      const previous = viewport.height > 480 ? page.locator('.dsh-pdf-tool-history .dsh-pdf-toolbar-undo') : page.locator('.dsh-pdf-tool-ocr')
      await previous.focus()
      await page.keyboard.press('Tab')
      expect(await control.evaluate(element => document.activeElement === element)).toBe(true)
      await expect.poll(() => page.getByRole('tooltip').textContent()).toBe('All changes saved')
      expect(await control.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      await page.keyboard.press('Escape')
      await setReaderSave(page, { dirty: true })
      await check('dirty')
      expect(await control.getAttribute('tabindex')).toBeNull()
      await previous.focus()
      await page.keyboard.press('Tab')
      expect(await save.evaluate(element => document.activeElement === element)).toBe(true)
      await expect.poll(() => page.getByRole('tooltip').textContent()).toBe('Unsaved changes')
      await page.keyboard.press('Escape')
      await save.click()
      await check('saving')
      await settleReaderSave(page, 'reject')
      await check('failed')
      await save.click()
      await check('saving')
      await settleReaderSave(page, 'resolve')
      await check('saved-success')
      await saveToolRailShot(page, `save-geometry-success-${viewport.width}x${viewport.height}`)
      await setReaderSave(page, { readOnly: true, language: 'zh' })
      await expect.poll(() => control.getAttribute('data-tooltip')).toBe('只读')
      expect(await page.getByRole('button', { name: '保存', exact: true }).getAttribute('data-save-state')).toBe('read-only')
      await saveToolRailShot(page, `save-readonly-zh-${viewport.width}x${viewport.height}`)
      await page.close()
    }
  } finally { await browser.close() }
})

it('floats the 56px left tool rail above a full-width canvas with one glass shell and three persistent groups at narrow widths and short heights', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 600 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-left-tool-rail-layout'))
    await mountReaderToolRail(page)
    const rail = page.locator('[data-pdf-tool-rail]')
    expect(await rail.locator('[data-tool-group]').evaluateAll(groups => groups.map(group => group.getAttribute('data-tool-group'))))
      .toEqual(['navigation', 'interaction', 'document'])
    const inspect = () => rail.evaluate(element => {
      const bounds = element.getBoundingClientRect(), body = element.parentElement!.getBoundingClientRect()
      const content = element.parentElement!.querySelector('.dsh-pdf-content')!.getBoundingClientRect()
      const podElements = [...element.querySelectorAll<HTMLElement>('[data-tool-group]')]
      const pods = podElements.map(pod => pod.getBoundingClientRect())
      const shell = element.querySelector<HTMLElement>('.dsh-pdf-tool-rail-shell')!
      const shellStyle = getComputedStyle(shell)
      const back = element.querySelector<HTMLElement>('.dsh-pdf-toolbar-back-split')!
      const history = back.querySelector<HTMLElement>('.dsh-pdf-split-action-trigger')!
      const navigation = element.querySelector<HTMLElement>('[data-tool-group="navigation"]')!.getBoundingClientRect()
      const zoomChevron = element.querySelector<HTMLElement>('.dsh-pdf-toolbar-zoom .dsh-pdf-toolbar-chevron')!.getBoundingClientRect()
      return { width: bounds.width, fullCanvas: Math.abs(content.left - body.left) < 1 && Math.abs(content.right - body.right) < 1,
        railInset: bounds.left > body.left && shell.getBoundingClientRect().top > body.top && shell.getBoundingClientRect().bottom < body.bottom,
        railBottom: bounds.bottom, bodyBottom: body.bottom,
        glassShell: shellStyle.backgroundImage !== 'none' && shellStyle.backdropFilter.includes('blur')
          && element.querySelectorAll('.dsh-pdf-glass').length === 1,
        transparentGroups: podElements.every(pod => getComputedStyle(pod).backgroundImage === 'none'
          && getComputedStyle(pod).backdropFilter === 'none'),
        backFits: back.getBoundingClientRect().width <= 40.5 && history.getBoundingClientRect().width >= 16
          && [...element.querySelectorAll<HTMLElement>('[data-tool-group="navigation"] button, [data-tool-group="navigation"] summary')]
            .every(control => { const box = control.getBoundingClientRect(); return box.left >= navigation.left - .5 && box.right <= navigation.right + .5 }),
        zoomChevronVisible: zoomChevron.width > 0 && zoomChevron.height > 0,
        podsInside: pods.every(pod => pod.left >= bounds.left && pod.right <= bounds.right),
        navigationInside: pods[0]!.top >= bounds.top && pods[0]!.bottom <= bounds.bottom,
        documentInside: pods[2]!.top >= bounds.top && pods[2]!.bottom <= bounds.bottom,
        pageTopReserved: content.top !== body.top,
        horizontalOverflow: element.parentElement!.scrollWidth > element.parentElement!.clientWidth }
    })
    for (const language of ['en', 'zh'] as const) for (const mode of ['text', 'explanation', 'note', 'region'] as const) {
      await setToolRail(page, { language, mode, tasks: 'concurrent' })
      for (const viewport of [{ width: 1180, height: 600 }, { width: 500, height: 600 }, { width: 320, height: 600 },
        { width: 240, height: 600 }, { width: 500, height: 450 }, { width: 1180, height: 320 }, { width: 500, height: 320 },
        { width: 320, height: 320 }, { width: 240, height: 320 }]) {
        await page.setViewportSize(viewport)
        await expect.poll(inspect, { message: `${language} ${mode} at ${viewport.width}×${viewport.height}` })
          .toMatchObject({ width: 56, glassShell: true, transparentGroups: true, backFits: true, zoomChevronVisible: true,
            podsInside: true, navigationInside: true, documentInside: true,
            pageTopReserved: false, horizontalOverflow: false, fullCanvas: true, railInset: true })
        expect(await rail.locator('[data-overflow-hidden]').count()).toBe(0)
        expect(await rail.getByRole('group', { name: language === 'en' ? 'Tools' : '工具', exact: true }).count()).toBe(0)
        // Every primary action remains reachable in the middle group's short-height scroller.
        for (const selector of mode === 'explanation'
          ? ['.dsh-pdf-explanation-select-text', '.dsh-pdf-explanation-status-area', '.dsh-pdf-explanation-materials-trigger']
          : ['.dsh-pdf-tool-explain', '.dsh-pdf-tool-note', '.dsh-pdf-tool-screenshot', '.dsh-pdf-tool-ocr']) {
          const button = rail.locator(selector)
          await button.scrollIntoViewIfNeeded()
          expect(await button.evaluate(element => {
            const bounds = element.getBoundingClientRect(), rail = element.closest('[data-pdf-tool-rail]')!.getBoundingClientRect()
            const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
            return bounds.top >= rail.top && bounds.bottom <= rail.bottom && bounds.left >= rail.left && bounds.right <= rail.right
              && (hit === element || !!hit && element.contains(hit))
          })).toBe(true)
        }
        if (language === 'en' && mode === 'text' || language === 'zh' && mode === 'explanation' && viewport.width === 320)
          await saveToolRailShot(page, `${language}-${mode}-${viewport.width}x${viewport.height}`)
      }
    }
    // Below the normal desktop reading height, the intact rail may scroll as a
    // fallback. It must preserve every command rather than overlap its groups.
    await page.setViewportSize({ width: 320, height: 260 })
    await setToolRail(page, { mode: 'explanation', tasks: 'concurrent' })
    for (const selector of ['.dsh-pdf-toolbar-back-split > button:first-child', '.dsh-pdf-toolbar-zoom > summary',
      '.dsh-pdf-explanation-select-text', '.dsh-pdf-explanation-status-area', '.dsh-pdf-explanation-materials-trigger',
      '.dsh-pdf-explanation-status-send', '.dsh-pdf-explanation-status-exit', '.dsh-pdf-toolbar-save',
      '.dsh-pdf-tools > summary', '.dsh-pdf-activity-trigger']) {
      const control = rail.locator(selector)
      await control.scrollIntoViewIfNeeded()
      expect(await control.evaluate(element => {
        const box = element.getBoundingClientRect(), shell = element.closest('.dsh-pdf-rail-shell')!.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return box.top >= shell.top && box.bottom <= shell.bottom && (hit === element || !!hit && element.contains(hit))
      })).toBe(true)
    }
    await saveToolRailShot(page, 'emergency-scroll-320x260')
    if (process.env.DSH_PDF_TOOL_RAIL_PREVIEW_DIR) {
      await page.setViewportSize({ width: 1180, height: 600 })
      await setToolRail(page, { mode: 'explanation', context: true, tasks: 'concurrent' })
      await page.evaluate(() => {
        document.body.dataset.dsDarkTheme = 'true'
        document.documentElement.style.cssText = '--dsw-alias-bg-base:#1d1f23; --dsw-alias-bg-layer-1:#282b30; --dsw-alias-label-primary:#eceef1; --dsw-alias-label-secondary:#a2a7b0; --dsw-alias-border-l2:#484e57; --dsw-alias-bg-document-preview:#171a1e; --dsw-alias-interactive-bg-hover:#3e444d; --dsw-alias-button-primary-fill:#eceef1; --dsw-alias-label-primary-foreground:#171a1e;'
      })
      await saveToolRailShot(page, 'dark-explanation-context-1180x600')
    }
  } finally { await browser.close() }
}, 60_000)

it('keeps left tool rail document commands expanded when height permits and gives both 56px sidebars matching one-piece interactive glass shells', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 }, reducedMotion: 'reduce' })
    onTestFailed(() => saveFailureShot(page, 'pdf-matching-sidebar-pods'))
    await mountReaderToolRail(page)
    const left = page.locator('[data-pdf-tool-rail]'), right = page.locator('.dsh-pdf-sidebar')
    const direct = left.locator('.dsh-pdf-document-direct')
    const compact = left.locator('.dsh-pdf-document-menu')
    await expect.poll(() => direct.isVisible()).toBe(true)
    expect(await compact.isVisible()).toBe(false)
    for (const [name, action] of [['Save as', 'save-as'], ['Reload source', 'reload'], ['Discard all changes', 'discard']] as const) {
      await direct.getByRole('button', { name, exact: true }).click()
      expect(await toolRailCalls(page)).toContain(action)
    }
    const hoverChanges = async (control: Locator) => {
      await page.mouse.move(600, 300)
      const before = await control.evaluate(element => getComputedStyle(element).backgroundColor)
      await control.hover()
      await expect.poll(() => control.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(before)
      await page.keyboard.press('Tab')
      await control.focus()
      expect(await control.evaluate(element => element.matches(':focus-visible')
        && (getComputedStyle(element).outlineStyle !== 'none' || getComputedStyle(element).boxShadow !== 'none'))).toBe(true)
    }
    await hoverChanges(left.locator('.dsh-pdf-toolbar-zoom > summary'))
    await hoverChanges(direct.getByRole('button', { name: 'Save as', exact: true }))
    await hoverChanges(right.getByRole('tab', { name: 'Search', exact: true }))
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
    expect(await right.locator('.dsh-pdf-sidebar-rail .dsh-pdf-glass').count()).toBe(1)
    expect(await left.locator('.dsh-pdf-tool-rail-shell.dsh-pdf-glass').count()).toBe(1)
    expect(await right.locator('.dsh-pdf-sidebar-sections, .dsh-pdf-sidebar-compact-nav')
      .evaluateAll(groups => groups.every(group => getComputedStyle(group).backgroundImage === 'none'
        && getComputedStyle(group).backdropFilter === 'none'))).toBe(true)
    expect(await left.locator('.dsh-pdf-tool-history').evaluate(element => getComputedStyle(element).flexDirection)).toBe('column')
    const pageInput = right.getByRole('textbox', { name: 'Page', exact: true })
    await pageInput.fill('1146')
    await pageInput.press('Enter')
    expect(await right.locator('.dsh-pdf-page-total').textContent()).toBe('1151')
    expect(await pageInput.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    const material = () => page.locator('.dsh-pdf-reader').evaluate(element => {
      const pods = [...element.querySelectorAll<HTMLElement>('.dsh-pdf-tool-rail-shell, .dsh-pdf-sidebar-rail-shell')]
      const left = getComputedStyle(pods[0]!)
      return pods.every(pod => {
        const style = getComputedStyle(pod)
        return style.borderRadius === left.borderRadius && style.backgroundImage === left.backgroundImage
          && style.backdropFilter === left.backdropFilter && style.backgroundImage !== 'none'
      })
    })
    expect(await material()).toBe(true)
    for (const viewport of [{ width: 1180, height: 800 }, { width: 760, height: 800 },
      { width: 380, height: 600 }, { width: 320, height: 320 }]) {
      await page.setViewportSize(viewport)
      for (const sidebarExpanded of viewport.width >= 760 ? [false, true] : [false]) {
        await setToolRail(page, { sidebarExpanded, sidebarSection: 'bookmarks' })
        await expect.poll(() => right.getByRole('tab', { name: 'Bookmarks', exact: true }).getAttribute('aria-expanded'))
          .toBe(String(sidebarExpanded))
        await expect.poll(() => page.locator('.dsh-pdf-body').evaluate(element => {
          const body = element.getBoundingClientRect(), left = element.querySelector('[data-pdf-tool-rail]')!.getBoundingClientRect()
          const content = element.querySelector('.dsh-pdf-content')!.getBoundingClientRect(), right = element.querySelector('.dsh-pdf-sidebar')!.getBoundingClientRect()
          return { fullCanvas: Math.abs(content.left - body.left) < 1 && Math.abs(content.right - body.right) < 1,
            floatingRails: left.left > body.left && right.right < body.right
              && element.querySelector('.dsh-pdf-tool-rail-shell')!.getBoundingClientRect().top > body.top
              && element.querySelector('.dsh-pdf-sidebar-rail-shell')!.getBoundingClientRect().top > body.top,
            bounded: left.right <= right.left && right.right <= body.right && content.width > 0 && element.scrollWidth <= element.clientWidth,
            railWidth: left.width, rightWidth: right.width }
        }), { message: `floating rails at ${viewport.width}×${viewport.height}, expanded=${sidebarExpanded}` })
          .toMatchObject({ fullCanvas: true, floatingRails: true, bounded: true, railWidth: 56, ...(!sidebarExpanded ? { rightWidth: 56 } : {}) })
        if (sidebarExpanded) {
          await expect.poll(() => right.locator('.dsh-pdf-sidebar-main').evaluate(element => {
            const box = element.getBoundingClientRect(), body = element.closest('.dsh-pdf-body')!
            const left = body.querySelector('[data-pdf-tool-rail]')!.getBoundingClientRect(), rail = body.querySelector('.dsh-pdf-sidebar-rail')!.getBoundingClientRect()
            return box.left > left.right && box.right <= rail.left && box.width > 100 && getComputedStyle(element).borderRadius === '18px'
          })).toBe(true)
          expect(await right.getByRole('heading', { name: 'Bookmarks', exact: true }).isVisible()).toBe(true)
        }
        expect(await right.locator('.dsh-pdf-sidebar-rail').evaluate(element => {
          const rail = element.getBoundingClientRect(), center = (rail.left + rail.right) / 2
          return [...element.querySelectorAll<HTMLElement>('.dsh-pdf-sidebar-tab, .dsh-pdf-page-input, .dsh-pdf-page-step')]
            .every(control => { const box = control.getBoundingClientRect(); return Math.abs((box.left + box.right) / 2 - center) <= .5 })
        })).toBe(true)
        await saveToolRailShot(page, `matching-pods-${sidebarExpanded ? 'expanded' : 'collapsed'}-${viewport.width}x${viewport.height}`)
      }
    }
    await expect.poll(() => direct.isVisible()).toBe(false)
    expect(await compact.isVisible()).toBe(true)
    await compact.locator('summary').click()
    const menu = page.locator('.dsh-pdf-tools-menu').filter({ has: page.getByRole('button', { name: 'Save as', exact: true }) })
    await menu.getByRole('button', { name: 'Save as', exact: true }).click()
    expect(await toolRailCalls(page)).toContain('save-as')
    await page.keyboard.press('Escape')
    for (const tab of await right.getByRole('tab').all()) {
      await tab.scrollIntoViewIfNeeded()
      expect(await tab.evaluate(element => {
        const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return hit === element || !!hit && element.contains(hit)
      })).toBe(true)
    }
    await page.setViewportSize({ width: 1180, height: 600 })
    await compact.locator('summary').click()
    await menu.waitFor({ state: 'visible' })
    await page.setViewportSize({ width: 1180, height: 800 })
    await expect.poll(() => compact.locator('summary').getAttribute('aria-expanded')).toBe('false')
    expect(await menu.isVisible()).toBe(false)
    expect(await direct.isVisible()).toBe(true)
    await setToolRail(page, { sidebarExpanded: true, sidebarSection: 'bookmarks' })
    await page.evaluate(() => {
      document.body.dataset.dsDarkTheme = 'true'
      document.documentElement.style.cssText = '--dsw-alias-bg-base:#1d1f23; --dsw-alias-bg-layer-1:#282b30; --dsw-alias-label-primary:#eceef1; --dsw-alias-label-secondary:#a2a7b0; --dsw-alias-border-l2:#484e57; --dsw-alias-bg-document-preview:#171a1e; --dsw-alias-interactive-bg-hover:#3e444d; --dsw-alias-button-primary-fill:#eceef1; --dsw-alias-label-primary-foreground:#171a1e;'
    })
    expect(await material()).toBe(true)
    await saveToolRailShot(page, 'matching-pods-expanded-dark-1180x800')
  } finally { await browser.close() }
}, 45_000)

it('keeps one persistent page navigation capsule editable through sidebar expansion, collapse and short-height scrolling', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 600 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-persistent-page-navigation'))
    await mountReaderToolRail(page)
    const sidebar = page.locator('.dsh-pdf-sidebar')
    const pagination = sidebar.locator('.dsh-pdf-sidebar-compact-nav')
    const input = pagination.getByRole('textbox', { name: 'Page', exact: true })
    const toggle = sidebar.getByRole('tab', { selected: true })
    expect(await sidebar.locator('.dsh-pdf-sidebar-toggle').count()).toBe(0)
    const initialInput = await input.elementHandle()
    const initialBounds = (await pagination.boundingBox())!
    for (const expanded of [true, false, true]) {
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe(String(expanded))
      await expect.poll(() => pagination.evaluate(element => {
        const bounds = element.getBoundingClientRect(), reader = element.closest('.dsh-pdf-reader')!.getBoundingClientRect()
        return { visible: getComputedStyle(element).visibility, opacity: getComputedStyle(element).opacity,
          inert: (element as HTMLElement).inert, inside: bounds.bottom <= reader.bottom && bounds.top >= reader.top }
      })).toEqual({ visible: 'visible', opacity: '1', inert: false, inside: true })
      expect(await sidebar.getByRole('textbox', { name: 'Page', exact: true }).count()).toBe(1)
      expect(await sidebar.locator('.dsh-pdf-page-input').count()).toBe(1)
      expect(await sidebar.locator('.dsh-pdf-sidebar-footer').count()).toBe(0)
      expect(await input.evaluate((element, original) => element === original, initialInput)).toBe(true)
      const bounds = (await pagination.boundingBox())!
      expect(Math.abs(bounds.x - initialBounds.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(bounds.y - initialBounds.y)).toBeLessThanOrEqual(1)
      await page.evaluate(() => (window as typeof window & { __pdfToolbarLayoutFixture: ToolRailFixture }).__pdfToolbarLayoutFixture.resetCalls())
      await input.fill('6')
      await input.press('Enter')
      await input.blur()
      await expect.poll(() => toolRailCalls(page)).toEqual(['page:6'])
      await pagination.getByRole('button', { name: 'Next page', exact: true }).click()
      await expect.poll(() => input.inputValue()).toBe('7')
      await expect.poll(() => toolRailCalls(page)).toEqual(['page:6', 'page:7'])
      await pagination.getByRole('button', { name: 'Previous page', exact: true }).click()
      await expect.poll(() => input.inputValue()).toBe('6')
      await expect.poll(() => toolRailCalls(page)).toEqual(['page:6', 'page:7', 'page:6'])
    }
    // A short host scrolls section tabs, never the persistent page controls.
    await page.setViewportSize({ width: 1180, height: 320 })
    for (const expanded of [false, true]) {
      await setToolRail(page, { sidebarExpanded: expanded })
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe(String(expanded))
      await expect.poll(() => pagination.evaluate(element => {
        const bounds = element.getBoundingClientRect(), reader = element.closest('.dsh-pdf-reader')!.getBoundingClientRect()
        return bounds.top >= reader.top && bounds.bottom <= reader.bottom && element.getAttribute('aria-hidden') !== 'true'
      })).toBe(true)
      for (const tab of await sidebar.getByRole('tab').all()) {
        await tab.scrollIntoViewIfNeeded()
        expect(await tab.evaluate(element => {
          const bounds = element.getBoundingClientRect(), hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
          return hit === element || !!hit && element.contains(hit)
        })).toBe(true)
      }
      await input.fill('9')
      await input.press('Enter')
      await expect.poll(() => input.inputValue()).toBe('9')
    }
    await saveToolRailShot(page, 'persistent-paging-expanded-1180x320')
  } finally { await browser.close() }
}, 30_000)

it('keeps left tool rail actions direct, file commands complete and menus opening to the right with real concurrent task statuses', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 600 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-left-tool-rail-commands'))
    await mountReaderToolRail(page)
    const rail = page.locator('[data-pdf-tool-rail]')
    for (const [selector, action] of [['.dsh-pdf-tool-ocr', 'ocr'], ['.dsh-pdf-tool-explain', 'explanation'],
      ['.dsh-pdf-tool-screenshot', 'screenshot'], ['.dsh-pdf-tool-note', 'note'], ['.dsh-pdf-toolbar-save', 'save'],
      ['.dsh-pdf-tool-history .dsh-pdf-toolbar-undo', 'undo'], ['.dsh-pdf-tool-history .dsh-pdf-toolbar-redo', 'redo']] as const) {
      await rail.locator(selector).click()
      expect(await toolRailCalls(page)).toContain(action)
    }
    const assertRightPanel = async (trigger: Locator, panel: Locator, name: string) => {
      await trigger.click()
      await panel.waitFor({ state: 'visible' })
      await expect.poll(async () => {
        const anchor = (await trigger.boundingBox())!, menu = (await panel.boundingBox())!
        const reader = (await page.locator('.dsh-pdf-reader').boundingBox())!
        return { right: menu.x >= anchor.x + anchor.width - 1, inReader: menu.x + menu.width <= reader.x + reader.width - 7
          && menu.y >= reader.y + 7 && menu.y + menu.height <= reader.y + reader.height - 7 }
      }, { message: name }).toEqual({ right: true, inReader: true })
      expect(await panel.evaluate(element => element.closest('.dsh-pdf-reader') !== null
        && element.closest('[data-pdf-tool-rail]') === null)).toBe(true)
    }
    for (const viewport of [{ width: 1180, height: 600 }, { width: 500, height: 450 }, { width: 500, height: 320 }, { width: 320, height: 320 }, { width: 240, height: 320 }]) {
      await page.setViewportSize(viewport)
      await setToolRail(page, { tasks: 'concurrent' })
      const file = rail.locator('.dsh-pdf-tools > summary'), fileMenu = page.locator('.dsh-pdf-tools-menu').filter({ has: page.getByRole('button', { name: 'Save as', exact: true }) })
      expect(await file.getAttribute('aria-label')).toBe('Document actions')
      await assertRightPanel(file, fileMenu, `file at ${viewport.width}×${viewport.height}`)
      expect((await fileMenu.getByRole('button').allTextContents()).sort()).toEqual([
        'Reload source', 'Save as', 'Discard all changes',
        ...(viewport.height <= 480 ? ['Undo PDF edit', 'Redo PDF edit'] : []),
      ].sort())
      if (viewport.height <= 480) for (const [name, action] of [['Undo PDF edit', 'undo'], ['Redo PDF edit', 'redo']] as const) {
        await fileMenu.getByRole('button', { name, exact: true }).click()
        expect(await toolRailCalls(page)).toContain(action)
      }
      expect(await fileMenu.getByRole('button', { name: 'Start explanation mode', exact: true }).count()).toBe(0)
      if (viewport.width === 240) await saveToolRailShot(page, 'file-menu-240x320')
      await page.keyboard.press('Escape')
      await expect.poll(() => file.getAttribute('aria-expanded')).toBe('false')
      expect(await file.evaluate(element => document.activeElement === element)).toBe(true)
      if (viewport.width === 1180) for (const [name, action] of [['Reload source', 'reload'],
        ['Save as', 'save-as'], ['Discard all changes', 'discard']] as const) {
        await file.click()
        await fileMenu.getByRole('button', { name, exact: true }).click()
        expect(await toolRailCalls(page)).toContain(action)
        await page.keyboard.press('Escape')
      }
      const zoom = rail.locator('.dsh-pdf-toolbar-zoom > summary')
      await assertRightPanel(zoom, page.locator('.dsh-pdf-zoom-menu'), `zoom at ${viewport.width}×${viewport.height}`)
      await page.locator('.dsh-pdf-zoom-menu').getByRole('button', { name: '100%', exact: true }).click()
      expect(await toolRailCalls(page)).toContain('zoom:1')
      const history = rail.locator('.dsh-pdf-toolbar-back-split .dsh-pdf-split-action-trigger')
      await assertRightPanel(history, page.locator('.dsh-pdf-history-menu'), `history at ${viewport.width}×${viewport.height}`)
      await page.locator('.dsh-pdf-history-item').nth(1).click()
      expect(await toolRailCalls(page)).toContain('back-to:1:7')
      const activity = rail.locator('.dsh-pdf-activity-trigger'), activityPanel = page.locator('.dsh-pdf-activity-popover')
      await assertRightPanel(activity, activityPanel, `tasks at ${viewport.width}×${viewport.height}`)
      expect(await activityPanel.locator('[data-status-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-status-id'))))
        .toEqual(['save', 'screenshot', 'ocr'])
      expect(await activityPanel.textContent()).toContain('Saved')
      expect(await activityPanel.textContent()).toContain('Creating screenshot…')
      expect(await activityPanel.textContent()).toContain('Recognizing text…')
      await saveToolRailShot(page, `concurrent-tasks-${viewport.width}x${viewport.height}`)
      await activityPanel.locator('[data-status-id="ocr"]').getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await toolRailCalls(page)).toContain('cancel-ocr')
      await activityPanel.locator('[data-status-id="screenshot"]').getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await toolRailCalls(page)).toContain('cancel-screenshot')
      await activity.click()
    }
    await setToolRail(page, { tasks: 'cancelling', state: { editable: false, canUndo: false, canRedo: false,
      dirty: false, ocrAvailability: { status: 'unavailable', reason: 'OCR engine unavailable' } } })
    await expect.poll(() => rail.locator('.dsh-pdf-tool-ocr').isDisabled()).toBe(true)
    for (const selector of ['.dsh-pdf-tool-note', '.dsh-pdf-toolbar-save', '.dsh-pdf-tool-history .dsh-pdf-toolbar-undo', '.dsh-pdf-tool-history .dsh-pdf-toolbar-redo'])
      expect(await rail.locator(selector).isDisabled()).toBe(true)
    expect(await rail.locator('.dsh-pdf-tool-ocr').getAttribute('title')).toBe('OCR engine unavailable')
    await rail.locator('.dsh-pdf-tools > summary').click()
    for (const name of ['Undo PDF edit', 'Redo PDF edit'])
      expect(await fileActions(page.locator('.dsh-pdf-reader')).getByRole('button', { name, exact: true }).isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    await rail.locator('.dsh-pdf-activity-trigger').click()
    const tasks = page.locator('.dsh-pdf-activity-popover')
    for (const id of ['ocr', 'screenshot']) expect(await tasks.locator(`[data-status-id="${id}"] button`).isDisabled()).toBe(true)
    expect(await tasks.textContent()).toContain('Stopping OCR…')
    expect(await tasks.textContent()).toContain('Stopping screenshot…')
    await saveToolRailShot(page, 'cancelling-tasks-240x320')
  } finally { await browser.close() }
}, 45_000)

it('keeps explanation Send centered and its empty, selecting, sending, unavailable-image and error states usable in the left tool rail', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 500 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-left-tool-rail-explanation'))
    await mountReaderToolRail(page)
    const send = page.locator('.dsh-pdf-explanation-status-send'), area = page.locator('.dsh-pdf-explanation-status-area')
    const states = [{ count: 0 }, { count: 2 }, { count: 2, sending: true }, { count: 2, selectingArea: true },
      { count: 2, imageAvailable: false, error: 'Explanation request failed' }]
    for (const language of ['en', 'zh'] as const) for (const state of states) {
      await setToolRail(page, { language, mode: 'explanation', tasks: 'concurrent', ...state })
      await send.waitFor()
      await expect.poll(() => send.isDisabled()).toBe(!state.count || !!state.sending || !!state.selectingArea)
      expect(await area.isDisabled()).toBe(state.imageAvailable === false || !!state.sending)
      expect(await page.locator('.dsh-pdf-explanation-status-exit').isDisabled()).toBe(false)
      expect(await page.locator('.dsh-pdf-tool-note, .dsh-pdf-tool-ocr, .dsh-pdf-tool-explain').count()).toBe(0)
      expect(await page.locator('.dsh-pdf-mode-count').count()).toBe(state.count ? 1 : 0)
      if (state.count) expect(await page.locator('.dsh-pdf-mode-count').textContent()).toBe(String(state.count))
      if (state.imageAvailable === false) expect(await area.locator('..').getAttribute('data-tooltip')).toBe('Image engine unavailable')
      for (const viewport of [{ width: 1180, height: 500 }, { width: 500, height: 500 }, { width: 320, height: 500 },
        { width: 500, height: 450 }, { width: 240, height: 320 }]) {
        await page.setViewportSize(viewport)
        if (state.error) await setToolRail(page, { language, mode: 'explanation', tasks: 'concurrent', ...state })
        const fixedActions = page.locator('.dsh-pdf-explanation-status-send, .dsh-pdf-explanation-status-exit')
        const fixedLayout = () => fixedActions.evaluateAll(controls => controls.map(element => {
          const bounds = element.getBoundingClientRect(), shell = element.closest('.dsh-pdf-tool-rail-shell')!.getBoundingClientRect()
          const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
          return bounds.top >= shell.top && bounds.bottom <= shell.bottom && bounds.left >= shell.left && bounds.right <= shell.right
            && (hit === element || !!hit && element.contains(hit))
        }).every(Boolean))
        await expect.poll(fixedLayout, { message: `fixed explanation controls at ${viewport.width}×${viewport.height}` }).toBe(true)
        const sendY = (await send.boundingBox())!.y
        // Scrolling an area tool must not move Send / Exit out of the short rail.
        await area.scrollIntoViewIfNeeded()
        expect(Math.abs((await send.boundingBox())!.y - sendY)).toBeLessThanOrEqual(1)
        expect(await fixedLayout()).toBe(true)
        await send.scrollIntoViewIfNeeded()
        await expect.poll(() => send.evaluate(button => {
          const bounds = button.getBoundingClientRect()
          const children = [...button.querySelectorAll<HTMLElement>(':scope > svg, :scope > .dsh-pdf-floating-status-spinner')].filter(child => child.checkVisibility())
            .map(child => child.getBoundingClientRect())
          const left = Math.min(...children.map(child => child.left)), right = Math.max(...children.map(child => child.right))
          const top = Math.min(...children.map(child => child.top)), bottom = Math.max(...children.map(child => child.bottom))
          return { centeredX: Math.abs((left + right - bounds.left - bounds.right) / 2) <= 1,
            centeredY: Math.abs((top + bottom - bounds.top - bounds.bottom) / 2) <= 1 }
        }), { message: `${language} ${JSON.stringify(state)} at ${viewport.width}×${viewport.height}` })
          .toEqual({ centeredX: true, centeredY: true })
        if (state.error) {
          const indicator = page.locator('.dsh-pdf-activity-trigger')
          await indicator.scrollIntoViewIfNeeded()
          if (await indicator.getAttribute('aria-expanded') !== 'true') await indicator.click()
          const error = page.locator('[data-status-id="explanation"]')
          await error.waitFor({ state: 'visible' })
          expect(await error.textContent()).toContain(state.error)
          expect(await error.evaluate(element => {
            const bounds = element.getBoundingClientRect(), reader = element.closest('.dsh-pdf-reader')!.getBoundingClientRect()
            return !element.closest('[data-pdf-tool-rail]') && bounds.left >= 56 && bounds.right <= reader.right - 7
              && bounds.top >= reader.top + 7 && bounds.bottom <= reader.bottom - 7
          })).toBe(true)
        }
        if (language === 'en' && (viewport.width === 240 || viewport.width === 1180 && state.count === 2 && !state.sending && !state.selectingArea && !state.error))
          await saveToolRailShot(page, `explanation-${state.error ? 'error' : state.sending ? 'sending' : state.selectingArea ? 'selecting' : state.count ? 'ready' : 'empty'}-${viewport.width}x${viewport.height}`)
        if (state.error) {
          await page.locator('[data-status-id="explanation"]').getByRole('button', { name: language === 'en' ? 'Dismiss' : '关闭提示', exact: true }).click()
          await expect.poll(() => page.locator('[data-status-id="explanation"]').count()).toBe(0)
          await page.keyboard.press('Escape')
          expect(await page.locator('.dsh-pdf-activity-trigger').evaluate(element => document.activeElement === element)).toBe(true)
        }
      }
    }
    await setToolRail(page, { mode: 'explanation' })
    const materialTrigger = page.locator('.dsh-pdf-explanation-materials-trigger')
    await materialTrigger.click()
    const materials = page.locator('.dsh-pdf-explanation-materials')
    expect(await materials.locator('.dsh-pdf-explanation-material').count()).toBe(2)
    await materials.locator('.dsh-pdf-explanation-material-edit').first().click()
    expect(await toolRailCalls(page)).toContain('edit-question:material-0')
    await materialTrigger.click()
    await materials.locator('.dsh-pdf-explanation-material-remove').nth(1).click()
    expect(await toolRailCalls(page)).toContain('remove-question:material-1')
    await page.keyboard.press('Escape')
    expect(await materialTrigger.evaluate(element => document.activeElement === element)).toBe(true)
    await send.click()
    await area.click()
    await page.locator('.dsh-pdf-explanation-status-exit').click()
    expect(await toolRailCalls(page)).toEqual(expect.arrayContaining(['send', 'select-area', 'exit-explanation']))
    await setToolRail(page, { mode: 'explanation', selectingArea: true })
    await expect.poll(() => area.getAttribute('aria-pressed')).toBe('true')
    expect(await area.getAttribute('aria-label')).toBe('Cancel region selection')
    await area.click()
    await page.locator('.dsh-pdf-explanation-status-exit').click()
    for (const mode of ['note', 'region'] as const) {
      await setToolRail(page, { mode })
      await page.locator('.dsh-pdf-mode-control').getByRole('button', { name: 'Cancel', exact: true }).click()
      await saveToolRailShot(page, `mode-${mode}-240x320`)
    }
    expect((await toolRailCalls(page)).filter(action => action === 'select-area')).toHaveLength(2)
    expect((await toolRailCalls(page)).filter(action => action === 'cancel-mode')).toHaveLength(2)
  } finally { await browser.close() }
}, 45_000)

it('lets the left tool rail coexist with selection actions, full annotation actions and a real comment editor near the top of the PDF page', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 600 } })
    onTestFailed(() => saveFailureShot(page, 'pdf-left-tool-rail-context'))
    await mountReaderToolRail(page)
    const comment = page.getByRole('dialog', { name: 'Annotation comment', exact: true })
    for (const actualAnnotation of [false, true]) {
      await setToolRail(page, { context: true, actualAnnotation, tasks: 'concurrent' })
      const context = page.getByRole('toolbar', { name: actualAnnotation ? 'Selected annotation' : 'Selection actions', exact: true })
      const prefix = actualAnnotation ? 'annotation' : 'selection'
      for (const viewport of [{ width: 1180, height: 600 }, { width: 500, height: 600 }, { width: 320, height: 600 },
        { width: 240, height: 600 }, { width: 320, height: 320 }, { width: 240, height: 320 }]) {
        await page.setViewportSize(viewport)
        await saveToolRailShot(page, `${prefix}-comment-${viewport.width}x${viewport.height}`)
        await expect.poll(async () => ({ context: await context.getAttribute('data-visible'), comment: await comment.getAttribute('data-visible') }))
          .toEqual({ context: 'true', comment: 'true' })
        await expect.poll(async () => {
          const content = (await page.locator('.dsh-pdf-scroll').boundingBox())!, toolbar = (await context.boundingBox())!, card = (await comment.boundingBox())!
          const inContent = [toolbar, card].every(bounds => bounds.x >= content.x && bounds.x + bounds.width <= content.x + content.width
            && bounds.y >= content.y && bounds.y + bounds.height <= content.y + content.height)
          const overlap = Math.min(toolbar.x + toolbar.width, card.x + card.width) - Math.max(toolbar.x, card.x) > 1
            && Math.min(toolbar.y + toolbar.height, card.y + card.height) - Math.max(toolbar.y, card.y) > 1
          return { inContent, overlap, contextNearTop: toolbar.y < content.y + 120 }
        }, { message: `context at ${viewport.width}×${viewport.height}` }).toEqual({ inContent: true, overlap: false, contextNearTop: true })
        await expect.poll(() => comment.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          { message: `comment content fits ${viewport.width}×${viewport.height} without horizontal scrolling` }).toBe(true)
        if (actualAnnotation) {
          expect(await context.locator('.dsh-pdf-highlight-swatch').count()).toBe(5)
          expect(await context.getByLabel('Selected annotation color', { exact: true }).count()).toBe(1)
          for (const swatch of await context.locator('.dsh-pdf-highlight-swatch').all()) await swatch.click()
          await context.getByRole('button', { name: 'Comment', exact: true }).click()
          await context.getByRole('button', { name: 'Delete annotation', exact: true }).click()
          await context.getByRole('button', { name: 'Deselect', exact: true }).click()
        } else await context.getByRole('button', { name: 'Copy', exact: true }).click()
        await comment.getByRole('textbox', { name: 'Comment', exact: true }).fill('The rail leaves this comment usable')
        const saveComment = comment.getByRole('button', { name: 'Save comment', exact: true })
        await saveComment.scrollIntoViewIfNeeded()
        await expect.poll(() => saveComment.evaluate(async element => {
          // Internal scrolling must remain stable after the card's own positioning observer runs.
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          const bounds = element.getBoundingClientRect(), card = element.closest('.dsh-pdf-page-comment-card')!.getBoundingClientRect()
          const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
          return bounds.top >= card.top && bounds.bottom <= card.bottom && (hit === element || !!hit && element.contains(hit))
        }), { message: `Save comment stays reachable after scrolling at ${viewport.width}×${viewport.height}` }).toBe(true)
        await saveComment.click()
        if (viewport.width <= 320) await saveToolRailShot(page, `${prefix}-comment-actions-${viewport.width}x${viewport.height}`)
        if (actualAnnotation) {
          const swatch = context.locator('.dsh-pdf-highlight-swatch').first()
          await swatch.click({ button: 'right' })
          const palette = page.getByRole('dialog', { name: 'Quick color 1', exact: true })
          await palette.waitFor({ state: 'visible' })
          await saveToolRailShot(page, `annotation-color-menu-${viewport.width}x${viewport.height}`)
          expect(await palette.getByLabel('Edit quick color', { exact: true }).count()).toBe(1)
          expect(await palette.getByRole('button', { name: 'Remove quick color', exact: true }).count()).toBe(1)
          expect(await palette.evaluate(element => {
            const bounds = element.getBoundingClientRect(), reader = element.closest('.dsh-pdf-reader')!.getBoundingClientRect()
            return bounds.left >= reader.left + 8 && bounds.right <= reader.right - 8
              && bounds.top >= reader.top + 8 && bounds.bottom <= reader.bottom - 8
          })).toBe(true)
          await page.keyboard.press('Escape')
          await expect.poll(() => palette.count()).toBe(0)
          expect(await swatch.evaluate(element => document.activeElement === element)).toBe(true)
        }
      }
      // Narrowing both rails restores a useful 128px PDF column even at 240px.
      // Keep the same edit draft when returning to a wider host.
      const draft = await comment.getByRole('textbox', { name: 'Comment', exact: true }).inputValue()
      await page.setViewportSize({ width: 320, height: 320 })
      await expect.poll(() => comment.getAttribute('data-visible')).toBe('true')
      expect(await comment.getByRole('textbox', { name: 'Comment', exact: true }).inputValue()).toBe(draft)
      await comment.getByRole('button', { name: 'Save comment', exact: true }).click()
    }
    expect(await toolRailCalls(page)).toEqual(expect.arrayContaining(['copy', 'apply-comment']))
    expect(await toolRailCalls(page)).toEqual(expect.arrayContaining(['annotation-color:#ffff00', 'annotation-color:#d1a2ff',
      'open-comment', 'delete-annotation', 'clear-annotation']))
  } finally { await browser.close() }
}, 60_000)

it('forwards exact selections through the real translation adapter and renders controlled provider JSON in a narrow sidebar (not online semantics)', async () => {
  const bundle = await build({ entryPoints: [join(ROOT, 'tests', 'modules', 'viewer', 'translation-recovery.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser' })
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 700 } })
    const browserErrors: string[] = []
    page.on('pageerror', error => browserErrors.push(error.message))
    // Engine registration uses the browser's real crypto.randomUUID. An
    // about:blank setContent page is not a trustworthy origin for that API.
    await page.route('http://localhost/translation-recovery', route => route.fulfill({
      contentType: 'text/html',
      body: '<div class="dsh-pdf-reader"><div class="dsh-pdf-body"><aside class="dsh-pdf-sidebar" style="inset:0;width:100%;max-width:100%"><div class="dsh-pdf-sidebar-shell" style="width:100%"><div class="dsh-pdf-sidebar-main"><div class="dsh-pdf-sidebar-panels" id="translation-root"></div></div></div></aside></div></div>',
    }))
    await page.goto('http://localhost/translation-recovery')
    const css = await Promise.all(['reader.css', 'reading-sidebar.css'].map(file => readFile(join(ROOT, 'src/client', file), 'utf8')))
    await page.addStyleTag({ content: `:root { --dsw-alias-bg-base:#f5f5f5; --dsw-alias-bg-layer-1:#fff; --dsw-alias-bg-layer-2:#f6f6f6; --dsw-alias-label-primary:#222; --dsw-alias-label-secondary:#666; --dsw-alias-border-l2:#ddd; --dsw-alias-link:#4278ed; --dsw-alias-bg-document-preview:#edf0f3; } html,body { margin:0; height:100%; } ${css.join('\n')}` })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    expect(browserErrors, 'translation fixture must register its real engine without browser runtime errors').toEqual([])
    await page.getByRole('button', { name: 'Translate selection', exact: true }).waitFor({ state: 'visible' })
    const begin = async (text: string, response: object, nearby?: { before: string; after: string }) => {
      await page.evaluate(input => (window as typeof window & {
        __pdfTranslationRecoveryFixture: { prepare(value: typeof input): void }
      }).__pdfTranslationRecoveryFixture.prepare(input), { text, response: JSON.stringify(response), ...nearby })
      await page.getByRole('button', { name: 'Translate selection', exact: true }).click()
    }
    const captured = () => page.evaluate(() => (window as typeof window & {
      __pdfTranslationRecoveryFixture: { requests(): { text: string; target_language: string; source_language: string;
        nearby_text?: { before: string; after: string } }[] }
    }).__pdfTranslationRecoveryFixture.requests())
    const panel = page.locator('.dsh-pdf-translation-panel'), note = panel.getByRole('note')
    const expectOriginal = async (text: string) => {
      await expect.poll(() => panel.locator('.dsh-pdf-translation-source-text').textContent()).toBe(text)
      expect(await panel.locator('.dsh-pdf-translation-source').isVisible()).toBe(true)
      expect(await panel.getByText(text, { exact: true }).count(), 'selected source is shown once, separately from the result').toBe(1)
      expect(await panel.locator('.dsh-pdf-translation-term').count(), 'lexical results no longer duplicate the original as a title').toBe(0)
    }
    await begin('subtrac', { kind: 'word', interpretation: { text: 'subtract', kind: 'completion', certainty: 'tentative',
      explanation: '选区可能缺少词尾 t；以下释义基于这一推测补全。' },
    meanings: [{ partOfSpeech: '动词', meaning: '减去；扣除', example: 'Subtract two from five.', exampleTranslation: '从五中减去二。' }] },
    { before: 'we ', after: ' two from five' })
    await expect.poll(() => note.textContent()).toContain('推测补全')
    expect(await captured()).toEqual([{ source_language: 'auto', target_language: 'zh', text: 'subtrac',
      nearby_text: { before: 'we ', after: ' two from five' } }])
    await expectOriginal('subtrac')
    expect(await note.locator('.dsh-pdf-translation-interpreted-text').textContent()).toBe('subtract')
    expect(await panel.getByText('subtract', { exact: true }).count()).toBe(1)
    expect(await note.getAttribute('data-certainty')).toBe('tentative')
    expect(await note.evaluate(element => getComputedStyle(element).borderStyle)).toBe('dashed')
    for (const width of [360, 280]) {
      await page.setViewportSize({ width, height: 700 })
      await expect.poll(() => panel.evaluate(element => element.scrollWidth <= element.clientWidth
        && [...element.querySelectorAll<HTMLElement>('.dsh-pdf-translation-interpretation, .dsh-pdf-translation-source')]
          .every(child => child.getBoundingClientRect().right <= element.getBoundingClientRect().right))).toBe(true)
    }
    await page.setViewportSize({ width: 360, height: 700 })
    if (process.env.DSH_PDF_TRANSLATION_PREVIEW_DIR) await page.screenshot({ path: join(process.env.DSH_PDF_TRANSLATION_PREVIEW_DIR, 'translation-tentative-completion.png') })
    await begin('calcuIate', { kind: 'word', pronunciation: '/ˈkælkjəleɪt/',
      interpretation: { text: 'calculate', kind: 'correction', certainty: 'confident',
        explanation: '结合邻近文字，将误识别的大写 I 纠正为小写 l。' },
      meanings: [{ partOfSpeech: '动词', meaning: '计算；核算', example: 'Calculate the sum.', exampleTranslation: '计算总和。' }] })
    await expect.poll(() => note.textContent()).toContain('纠正后')
    await expectOriginal('calcuIate')
    expect(await note.locator('.dsh-pdf-translation-interpreted-text').textContent()).toBe('calculate')
    expect(await panel.getByText('calculate', { exact: true }).count()).toBe(1)
    await begin('on', { kind: 'word', pronunciation: '/ɒn/',
      meanings: [{ partOfSpeech: '介词', meaning: '在……之上', example: 'The book is on the desk.', exampleTranslation: '书在桌上。' }] })
    await expect.poll(() => panel.locator('[data-translation-kind]').getAttribute('data-translation-kind')).toBe('word')
    await expectOriginal('on')
    expect(await note.count()).toBe(0)
    expect(await panel.locator('.dsh-pdf-translation-pronunciation').textContent()).toContain('/ɒn/')
    await begin('we wish to calculate', { kind: 'sentence', translation: '我们希望计算' })
    await expect.poll(() => panel.locator('.dsh-pdf-translation-text').textContent()).toBe('我们希望计算')
    expect(await note.count()).toBe(0)
    await expectOriginal('we wish to calculate')
    if (process.env.DSH_PDF_TRANSLATION_PREVIEW_DIR) await page.screenshot({ path: join(process.env.DSH_PDF_TRANSLATION_PREVIEW_DIR, 'translation-readable-fragment.png') })
    await begin('reduces a tensor', { kind: 'sentence', translation: '对张量进行归约' })
    await expect.poll(() => panel.locator('.dsh-pdf-translation-text').textContent()).toBe('对张量进行归约')
    await expectOriginal('reduces a tensor')
    expect(await panel.locator('.dsh-pdf-translation-details').count()).toBe(0)
    expect(await note.count()).toBe(0)
    await begin('take off', { kind: 'phrase', pronunciation: '/teɪk ɒf/',
      meanings: [{ partOfSpeech: '动词短语', meaning: '起飞', example: 'The plane takes off.', exampleTranslation: '飞机起飞。' }] })
    await expect.poll(() => panel.locator('[data-translation-kind]').getAttribute('data-translation-kind')).toBe('phrase')
    await expectOriginal('take off')
    expect(await note.count()).toBe(0)
    expect(await panel.locator('.dsh-pdf-translation-pronunciation').textContent()).toContain('/teɪk ɒf/')
    const longOriginal = 'gradient of y with respect to x, including all components of the selected expression'
    await begin(longOriginal, { kind: 'phrase', meanings: [{ partOfSpeech: '数学术语', meaning: 'y 关于 x 的梯度，包含所选表达式的所有分量',
      example: 'Calculate the gradient of the function.', exampleTranslation: '计算函数的梯度。' }] })
    await expect.poll(() => panel.locator('.dsh-pdf-translation-meaning').textContent()).toContain('梯度')
    await expectOriginal(longOriginal)
    expect(await note.count()).toBe(0)
    await page.setViewportSize({ width: 280, height: 700 })
    await expect.poll(() => panel.locator('.dsh-pdf-translation-source-text').evaluate(element => {
      const style = getComputedStyle(element), bounds = element.getBoundingClientRect()
      const viewport = element.closest('.dsh-pdf-panel-scroll')!.getBoundingClientRect()
      return element.scrollWidth <= element.clientWidth + 1 && bounds.left >= viewport.left && bounds.right <= viewport.right
        && bounds.height > Number.parseFloat(style.lineHeight)
    }), { message: 'long exact original wraps inside the shared narrow sidebar viewport' }).toBe(true)
    await page.evaluate(() => {
      document.body.dataset.dsDarkTheme = 'true'
      document.documentElement.style.cssText = '--dsw-alias-bg-base:#1d1f23; --dsw-alias-bg-layer-1:#282b30; --dsw-alias-label-primary:#eceef1; --dsw-alias-label-secondary:#a2a7b0; --dsw-alias-border-l2:#484e57; --dsw-alias-bg-document-preview:#171a1e; --dsw-alias-link:#82a7ff;'
    })
    await expectOriginal(longOriginal)
    if (process.env.DSH_PDF_TRANSLATION_PREVIEW_DIR) await page.screenshot({ path: join(process.env.DSH_PDF_TRANSLATION_PREVIEW_DIR, 'translation-persistent-original-dark-280.png') })
    await begin('x??', { kind: 'sentence', translation: '此残片有多种可能含义，无法从当前上下文确定。' })
    await expect.poll(() => panel.locator('.dsh-pdf-translation-text').textContent()).toContain('无法从当前上下文确定')
    await expectOriginal('x??')
    expect(await panel.getByRole('alert').count()).toBe(0)
    expect((await captured()).map(request => request.text)).toEqual([
      'subtrac', 'calcuIate', 'on', 'we wish to calculate', 'reduces a tensor', 'take off', longOriginal, 'x??',
    ])
    expect(browserErrors).toEqual([])
  } finally { await browser.close() }
}, 30_000)

it('keeps all six real sidebar panel headings above scrolling content at narrow widths and low heights (layout regression)', async () => {
  const bundle = await build({ entryPoints: [join(ROOT, 'tests', 'modules', 'viewer', 'sidebar-panel-layout.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser' })
  const css = await Promise.all(['reader.css', 'reading-sidebar.css'].map(file => readFile(join(ROOT, 'src/client', file), 'utf8')))
  const screenshots = join(ROOT, '.test-output', 'sidebar-panel-layout')
  await mkdir(screenshots, { recursive: true })
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 360 }, reducedMotion: 'reduce' })
    const browserErrors: string[] = []
    page.on('pageerror', error => browserErrors.push(error.message))
    // A trusted localhost origin exposes the real crypto/clipboard APIs used by
    // the feature actions, without a running DSH server or scaffold.
    await page.route('http://localhost/sidebar-panel-layout', route => route.fulfill({
      contentType: 'text/html', body: '<div id="sidebar-layout-root" style="height:100%"></div>',
    }))
    await page.goto('http://localhost/sidebar-panel-layout')
    await page.addStyleTag({ content: `:root { --dsw-alias-bg-base:#f5f5f5; --dsw-alias-bg-layer-1:#fff; --dsw-alias-bg-layer-2:#f6f6f6; --dsw-alias-label-primary:#222; --dsw-alias-label-secondary:#666; --dsw-alias-border-l2:#ddd; --dsw-alias-link:#4278ed; --dsw-alias-bg-document-preview:#edf0f3; } html,body { margin:0; height:100%; } ${css.join('\n')}` })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    await page.locator('[data-layout-panel="translation"] .dsh-pdf-translation-text').waitFor()
    const sections = ['pages', 'bookmarks', 'annotations', 'search', 'translation', 'ocr'] as const
    const actions = () => page.evaluate(() => (window as typeof window & {
      __pdfSidebarPanelLayoutFixture: { actions(): string[] }
    }).__pdfSidebarPanelLayoutFixture.actions())
    for (const size of [{ width: 260, height: 260 }, { width: 360, height: 360 }]) {
      await page.setViewportSize(size)
      for (const section of sections) {
        await page.evaluate(next => (window as typeof window & {
          __pdfSidebarPanelLayoutFixture: { show(section: typeof next): void }
        }).__pdfSidebarPanelLayoutFixture.show(next), section)
        const wrapper = page.locator(`[data-layout-panel="${section}"]`)
        const panel = wrapper.locator('.dsh-pdf-panel')
        const heading = panel.locator(':scope > .dsh-pdf-panel-heading')
        const scroll = panel.locator(':scope > .dsh-pdf-panel-scroll')
        // A title inside the scrolling div (the old TranslationPanel layout)
        // fails this shared-sibling contract before any pixel assertions.
        expect(await heading.count(), section).toBe(1)
        expect(await scroll.count(), section).toBe(1)
        expect(await scroll.locator('.dsh-pdf-panel-heading').count(), section).toBe(0)
        if (section === 'translation') {
          await panel.locator('.dsh-pdf-translation-text').waitFor()
          expect(await panel.locator('.dsh-pdf-translation-source-text').evaluate(element => {
            const style = getComputedStyle(element)
            return !['auto', 'scroll'].includes(style.overflowY) && element.scrollHeight <= element.clientHeight + 1
          }), 'long original text belongs to the shared viewport, without nested vertical scrolling').toBe(true)
        }
        await expect.poll(() => scroll.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight > 0),
          { message: `${section} has real scrollable content at ${size.width}×${size.height}` }).toBe(true)
        const fixedHeading = (await heading.boundingBox())!
        expect(fixedHeading.height, section).toBe(48)
        await scroll.evaluate(element => { element.scrollTop = 0 })
        await scroll.hover()
        await page.mouse.wheel(0, 80)
        await expect.poll(() => scroll.evaluate(element => element.scrollTop), { message: `${section} wheel scroll` }).toBeGreaterThan(0)
        for (const [name, fraction] of [['initial', 0], ['middle', .5], ['bottom', 1]] as const) {
          await scroll.evaluate((element, portion) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * portion }, fraction)
          await expect.poll(() => panel.evaluate((element, expected) => {
            const header = element.querySelector<HTMLElement>(':scope > .dsh-pdf-panel-heading')!
            const viewport = element.querySelector<HTMLElement>(':scope > .dsh-pdf-panel-scroll')!
            const headerBox = header.getBoundingClientRect(), scrollBox = viewport.getBoundingClientRect()
            const scrollbar = element.querySelector<HTMLElement>('.dsh-pdf-scrollbar.is-vertical:not([hidden])')
            const barBox = scrollbar?.getBoundingClientRect()
            return { headerFixed: Math.abs(headerBox.top - expected.y) < .5 && Math.abs(headerBox.height - expected.height) < .5,
              viewportBelowHeading: scrollBox.top >= headerBox.bottom - .5,
              scrollbarBelowHeading: !barBox || barBox.top >= headerBox.bottom - .5,
              viewportContained: scrollBox.bottom <= element.getBoundingClientRect().bottom + .5,
              noHorizontalOverflow: viewport.scrollWidth <= viewport.clientWidth + 1 }
          }, fixedHeading), { message: `${section} ${name} at ${size.width}×${size.height}` }).toEqual({
            headerFixed: true, viewportBelowHeading: true, scrollbarBelowHeading: true, viewportContained: true, noHorizontalOverflow: true,
          })
          if (section === 'translation') await page.screenshot({ path: join(screenshots, `translation-${size.width}x${size.height}-${name}.png`) })
        }
        if (section === 'pages') await panel.locator('.dsh-pdf-thumbnail-tile').last().click()
        else if (section === 'bookmarks') {
          await heading.locator('button').click()
          const editor = panel.locator('.dsh-pdf-outline-name-editor input')
          await editor.waitFor(); expect(await editor.evaluate(element => document.activeElement === element)).toBe(true)
          await editor.press('Escape')
          expect(await panel.locator('.dsh-pdf-outline-name-editor').count()).toBe(0)
        } else if (section === 'annotations') {
          await heading.locator('select').selectOption('Text')
          expect(await heading.locator('select').inputValue()).toBe('Text')
        } else if (section === 'search') await panel.locator('form button').click()
        else if (section === 'ocr') await panel.locator('.dsh-pdf-ocr-panel > button').click()
        else {
          await heading.locator('button').click()
          await expect.poll(() => panel.locator('.dsh-pdf-translation-source').count()).toBe(0)
          expect(await panel.locator(':scope > .dsh-pdf-panel-heading').count()).toBe(1)
        }
        if (section !== 'translation') await page.screenshot({ path: join(screenshots, `${section}-${size.width}x${size.height}.png`) })
      }
    }
    const recorded = await actions()
    for (const action of ['page', 'search', 'copy', 'close']) expect(recorded, action).toContain(action)
    expect(browserErrors).toEqual([])
  } finally { await browser.close() }
}, 45_000)

it('keeps concurrent activity ordered, cancelable, timed, and inside a narrow reader', async () => {
  const bundle = await build({ entryPoints: [join(ROOT, 'tests', 'modules', 'viewer', 'floating-status.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser' })
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
    await page.setContent('<div class="dsh-pdf-reader"><div class="dsh-pdf-body"><div class="dsh-pdf-tool-rail" data-pdf-tool-rail="" id="rail-root"></div><div class="dsh-pdf-content"></div></div></div>')
    await page.addStyleTag({ content: `:root { --dsw-alias-bg-base:#f5f5f5; --dsw-alias-bg-layer-1:#fff; --dsw-alias-label-primary:#222; --dsw-alias-border-l2:#ddd; --dsw-alias-link:#4278ed; } html,body { margin:0; height:100%; } #rail-root > .dsh-pdf-main-toolbar { width:100% !important; height:44px !important; } ${await readFile(join(ROOT, 'src/client/reader.css'), 'utf8')}` })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const reader = page.locator('.dsh-pdf-reader')
    const rail = reader.locator('.dsh-pdf-floating-status-rail')
    const tasks = reader.locator('.dsh-pdf-activity-popover')
    await rail.waitFor({ state: 'attached' })
    const set = (items: { id: string; label: string; actionLabel?: string; durationMs?: number; occurrence?: number;
      tone?: 'progress' | 'success' | 'error' | 'neutral' }[]) => page.evaluate(next => {
      const fixture = (window as typeof window & { __pdfFloatingStatusFixture?: { set(items: typeof next): void } }).__pdfFloatingStatusFixture
      fixture!.set(next)
    }, items)
    await set([{ id: 'save', label: 'Saved', occurrence: 1 }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(1)
    await set([{ id: 'ocr', label: 'Recognizing text' }, { id: 'save', label: 'Saved', occurrence: 1 }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(2)
    const activity = rail.locator('.dsh-pdf-activity-trigger')
    expect(await activity.getAttribute('aria-expanded')).toBe('false')
    await activity.click()
    expect(await tasks.locator('.dsh-pdf-floating-status-content').allTextContents()).toEqual(['Saved', 'Recognizing text'])
    const ocrLayout = await tasks.locator('.dsh-pdf-floating-status').nth(1).evaluate(element => {
      const content = element.querySelector('.dsh-pdf-floating-status-content')!.getBoundingClientRect()
      const action = element.querySelector('button')!.getBoundingClientRect()
      const popover = element.parentElement!.getBoundingClientRect()
      return { contentRight: content.right, actionLeft: action.left, actionRight: action.right, popoverRight: popover.right }
    })
    expect(ocrLayout.actionLeft - ocrLayout.contentRight).toBeGreaterThanOrEqual(8)
    expect(ocrLayout.popoverRight - ocrLayout.actionRight).toBeLessThanOrEqual(16)
    const [first, second] = await Promise.all([tasks.locator('.dsh-pdf-floating-status').nth(0).boundingBox(),
      tasks.locator('.dsh-pdf-floating-status').nth(1).boundingBox()])
    expect(first!.y).toBeLessThan(second!.y)
    const assertActivityColumn = async () => {
      // ReaderPopover follows ResizeObserver with a frame. A viewport resize
      // must settle before checking the final popup geometry.
      await expect.poll(async () => {
        const [bar, popover, owner] = await Promise.all([
          reader.locator('[data-pdf-tool-rail]').boundingBox(), tasks.boundingBox(), reader.boundingBox(),
        ])
        return !!bar && !!popover && !!owner
          && popover.x >= bar.x + bar.width + 7
          && popover.x + popover.width <= owner.x + owner.width - 7
          && popover.y >= owner.y + 7
          && popover.y + popover.height <= owner.y + owner.height - 7
      }).toBe(true)
      const [bar, content, trigger, popover, owner] = await Promise.all([
        reader.locator('[data-pdf-tool-rail]').boundingBox(), reader.locator('.dsh-pdf-content').boundingBox(),
        activity.boundingBox(), tasks.boundingBox(), reader.boundingBox(),
      ])
      expect(bar!.width).toBe(56)
      expect(Math.abs(content!.x - owner!.x)).toBeLessThanOrEqual(1)
      expect(trigger!.x).toBeGreaterThanOrEqual(bar!.x)
      expect(trigger!.x + trigger!.width).toBeLessThanOrEqual(bar!.x + bar!.width)
      expect(trigger!.y).toBeGreaterThanOrEqual(bar!.y)
      expect(trigger!.y + trigger!.height).toBeLessThanOrEqual(bar!.y + bar!.height)
      expect(popover!.x).toBeGreaterThanOrEqual(bar!.x + bar!.width + 7)
      expect(popover!.x + popover!.width).toBeLessThanOrEqual(owner!.x + owner!.width - 7)
      expect(popover!.y).toBeGreaterThanOrEqual(owner!.y + 7)
      expect(popover!.y + popover!.height).toBeLessThanOrEqual(owner!.y + owner!.height - 7)
    }
    await page.setViewportSize({ width: 1000, height: 600 })
    await assertActivityColumn()
    if (process.env.DSH_PDF_FLOATING_PREVIEW_PATH)
      await page.screenshot({ path: process.env.DSH_PDF_FLOATING_PREVIEW_PATH.replace(/\.png$/, '-aligned.png') })
    await page.setViewportSize({ width: 700, height: 600 })
    await assertActivityColumn()
    await page.setViewportSize({ width: 1200, height: 600 })
    await tasks.getByRole('button', { name: 'Cancel ocr' }).click()
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(1)
    expect(await page.evaluate(() => (window as typeof window & { __pdfFloatingStatusFixture?: { presses(): number } }).__pdfFloatingStatusFixture!.presses())).toBe(1)
    await set([{ id: 'save', label: 'Saved', occurrence: 1 }, { id: 'timed', label: 'Temporary', durationMs: 400, occurrence: 1 }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(2)
    await page.waitForTimeout(200)
    await set([{ id: 'save', label: 'Saved', occurrence: 1 }, { id: 'timed', label: 'Temporary again', durationMs: 800, occurrence: 2 }])
    await page.waitForTimeout(300)
    expect(await tasks.locator('.dsh-pdf-floating-status').count()).toBe(2)
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count(), { timeout: 3000 }).toBe(1)
    await page.setViewportSize({ width: 380, height: 600 })
    await set([{ id: 'save', label: 'A long status about a PDF region that must stay readable', occurrence: 1 },
      { id: 'screenshot', label: 'Creating screenshot', occurrence: 1 }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(2)
    await assertActivityColumn()
    const bounds = await tasks.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements.map(element => {
      const { left, right, top } = element.getBoundingClientRect()
      return { left, right, top }
    }))
    const ownerRight = await reader.evaluate(element => element.getBoundingClientRect().right)
    expect(bounds.every(item => item.right <= ownerRight - 7)).toBe(true)
    await assertActivityColumn()
    expect(bounds[0]!.top).toBeLessThan(bounds[1]!.top)
    await page.setViewportSize({ width: 200, height: 600 })
    await assertActivityColumn()
    const tinyBounds = await tasks.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements.map(element => {
      const { left, right } = element.getBoundingClientRect()
      return { left, right }
    }))
    const tinyPopover = (await tasks.boundingBox())!
    expect(tinyBounds.every(item => item.left >= tinyPopover.x && item.right <= tinyPopover.x + tinyPopover.width)).toBe(true)
    await page.setViewportSize({ width: 380, height: 600 })
    if (process.env.DSH_PDF_FLOATING_PREVIEW_PATH) await page.screenshot({ path: process.env.DSH_PDF_FLOATING_PREVIEW_PATH })
    await page.setViewportSize({ width: 1000, height: 600 })
    await set([{ id: 'ocr', label: '正在识别文字…', actionLabel: '取消' }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(1)
    const ocrPopover = await tasks.boundingBox()
    expect(ocrPopover!.width).toBeLessThanOrEqual(300)
    await assertActivityColumn()
    if (process.env.DSH_PDF_FLOATING_PREVIEW_PATH) {
      await page.screenshot({ path: process.env.DSH_PDF_FLOATING_PREVIEW_PATH.replace(/\.png$/, '-ocr.png') })
    }
    await set([{ id: 'ocr', label: 'Working', tone: 'progress' },
      { id: 'saved', label: 'Completed', tone: 'success' }, { id: 'failed', label: 'Failed', tone: 'error' }])
    await expect.poll(() => tasks.locator('.dsh-pdf-floating-status').count()).toBe(3)
    const colors = await tasks.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements.map(element => {
      const marker = element.querySelector('.dsh-pdf-floating-status-dot, .dsh-pdf-floating-status-spinner')!
      const style = getComputedStyle(marker)
      return marker.classList.contains('dsh-pdf-floating-status-spinner') ? style.borderTopColor : style.backgroundColor
    }))
    expect(colors).toEqual(['rgb(66, 120, 237)', 'rgb(34, 160, 107)', 'rgb(223, 51, 68)'])
  } finally { await browser.close() }
})

it('remembers the selected translation language for the next selection and after client reload', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.name === '@dylanl1/dsh-plugin-pdf')
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
      // The Reader shell mounts before a cold native open has returned.
      await reader.locator('[data-pdf-page="1"] [data-pdf-text="active"] span[data-pdf-run]').first()
        .waitFor({ state: 'visible', timeout: 20_000 })
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents())
      .toContain('Browser PDF page one')
    const mainToolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const statusRail = reader.locator('.dsh-pdf-main-toolbar')
    await mainToolbar.getByRole('button', { name: 'Note', exact: true }).click()
    await statusRail.locator('[data-status-id="note-mode"]').waitFor({ state: 'visible' })
    expect(await reader.locator('.dsh-pdf-notice').filter({ hasText: 'Click on the page to place a note.' }).count()).toBe(0)
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
      expect(regionStatusBox!.y).toBeGreaterThanOrEqual(regionToolbarBox!.y)
      expect(regionStatusBox!.x).toBeGreaterThanOrEqual(regionToolbarBox!.x)
      expect(regionStatusBox!.x + regionStatusBox!.width)
        .toBeLessThanOrEqual(regionToolbarBox!.x + regionToolbarBox!.width)
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
    const stableBack = await mainToolbar.locator('.dsh-pdf-toolbar-back-split').elementHandle()
    const stableSave = await mainToolbar.locator('.dsh-pdf-save-control').elementHandle()
    if (!stableBack || !stableSave) throw new Error('Fixed reader toolbar controls are unavailable')
    const stableControlY = [(await stableBack.boundingBox())!.y, (await stableSave.boundingBox())!.y]
    await mainToolbar.getByRole('button', { name: 'Start explanation mode' }).focus()
    await page.keyboard.press('Enter')
    const modeControl = mainToolbar.locator('.dsh-pdf-mode-explanation')
    const status = reader.locator('.dsh-pdf-mode-explanation')
    await status.waitFor({ state: 'visible' })
    await expect.poll(() => status.locator('.dsh-pdf-explanation-select-text').evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.press('Tab')
    expect(await status.evaluate(element => element.contains(document.activeElement))).toBe(true)
    expect(await stableBack.evaluate(element => element === document.querySelector('.dsh-pdf-toolbar-back-split'))).toBe(true)
    expect(await stableSave.evaluate(element => element === document.querySelector('.dsh-pdf-save-control'))).toBe(true)
    expect(Math.abs((await stableBack.boundingBox())!.y - stableControlY[0])).toBeLessThanOrEqual(1)
    expect(Math.abs((await stableSave.boundingBox())!.y - stableControlY[1])).toBeLessThanOrEqual(1)
    expect(await statusRail.locator('[data-status-id="region-selection"]').count()).toBe(0)
    expect(await mainToolbar.getByRole('button', { name: 'Note', exact: true }).count()).toBe(0)
    // Explanation replaces the ordinary capture action with its own image
    // question entry. The text-only session keeps that sole action disabled.
    expect(await mainToolbar.getByRole('button', { name: 'Region screenshot' }).count()).toBe(0)
    expect(await mainToolbar.getByRole('button', { name: 'Select image region' }).isDisabled()).toBe(true)
    expect(await status.getByRole('button', { name: 'Select image region' }).count()).toBe(1)
    expect(await status.getByRole('button', { name: 'Send for explanation' }).isDisabled()).toBe(true)
    const [toolbarBox, statusBox, modeBox, contentBox, controlsBox] = await Promise.all([
      mainToolbar.boundingBox(), status.boundingBox(), modeControl.boundingBox(), reader.locator('.dsh-pdf-content').boundingBox(),
      reader.locator('.dsh-pdf-tool-rail').boundingBox(),
    ])
    expect(toolbarBox).not.toBeNull()
    expect(statusBox).not.toBeNull()
    expect(modeBox).not.toBeNull()
    expect(contentBox).not.toBeNull()
    expect(controlsBox).not.toBeNull()
    expect(modeBox!.x).toBeGreaterThanOrEqual(toolbarBox!.x)
    expect(modeBox!.x + modeBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width)
    expect(statusBox!.x).toBeGreaterThanOrEqual(toolbarBox!.x)
    expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width)
    expect(statusBox!.y).toBeGreaterThanOrEqual(toolbarBox!.y)
    expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(toolbarBox!.y + toolbarBox!.height)
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
      expect(wideStatus!.y).toBeGreaterThanOrEqual(wideToolbar!.y)
      expect(wideStatus!.y + wideStatus!.height).toBeLessThanOrEqual(wideToolbar!.y + wideToolbar!.height)
      expect(wideStatus!.x).toBeGreaterThanOrEqual(wideToolbar!.x)
      expect(wideStatus!.x + wideStatus!.width).toBeLessThanOrEqual(wideToolbar!.x + wideToolbar!.width)
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
    const originalReaderStyle = await reader.getAttribute('style')
    try {
      await reader.evaluate(element => { (element as HTMLElement).style.width = '365px' })
      await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(365)
      const [narrowToolbar, narrowMode, narrowSidebar, narrowReader] = await Promise.all([
        mainToolbar.boundingBox(), modeControl.boundingBox(), reader.locator('.dsh-pdf-sidebar').boundingBox(),
        reader.boundingBox(),
      ])
      expect(narrowToolbar).not.toBeNull(); expect(narrowMode).not.toBeNull()
      expect(narrowSidebar).not.toBeNull(); expect(narrowReader).not.toBeNull()
      expect(narrowMode!.x + narrowMode!.width).toBeLessThanOrEqual(narrowToolbar!.x + narrowToolbar!.width)
      expect(narrowToolbar!.x).toBeGreaterThan(narrowReader!.x)
      expect(narrowToolbar!.width).toBe(56)
      expect(narrowToolbar!.x + narrowToolbar!.width).toBeLessThanOrEqual(narrowReader!.x + narrowReader!.width - 11)
      // Floating rails remain independently usable, including at the narrowest width.
      expect(narrowToolbar!.x + narrowToolbar!.width).toBeLessThanOrEqual(narrowSidebar!.x)
    } finally {
      await reader.evaluate((element, style) => {
        if (style === null) element.removeAttribute('style')
        else element.setAttribute('style', style)
      }, originalReaderStyle)
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
    // Pausing an unfinished question must retain its text without creating a
    // counted material. Re-entering after ordinary reading has moved away must
    // reveal the original passage and focus its editor, rather than leaving the
    // whole explanation rail disabled behind an off-screen editor.
    await status.getByRole('button', { name: 'Exit explanation mode' }).click()
    await editor.waitFor({ state: 'hidden' })
    // In this narrow Files column both fit-width test pages can fit at once;
    // use a genuine scrollable scale so the pending anchor really leaves view.
    await chooseZoom(reader, '200%')
    const pendingPage = reader.getByRole('textbox', { name: 'Page', exact: true })
    await pendingPage.fill('2')
    await pendingPage.press('Enter')
    await expect.poll(() => pendingPage.inputValue()).toBe('2')
    await reader.locator('[data-pdf-page="2"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => pendingPage.isEnabled()).toBe(true)
    await expect.poll(() => mainToolbar.getByRole('button', { name: 'Start explanation mode' }).isEnabled()).toBe(true)
    const awayFromPending = await reader.locator('.dsh-pdf-scroll').evaluate(root => root.scrollTop)
    // Page steps remain enabled during navigation. A second real user action
    // can supersede the automatic return to the paused question's page. Keep
    // that race deterministic by activating the step on the navigation state
    // transition, without replacing jump/reveal or changing any timeout.
    await mainToolbar.evaluate(element => {
      const reader = element.closest('.dsh-pdf-reader')!
      const input = reader.querySelector<HTMLInputElement>('.dsh-pdf-page-input')!
      const previous = reader.querySelector<HTMLButtonElement>('.dsh-pdf-page-step')!
      const observer = new MutationObserver(() => {
        if (!input.disabled) return
        observer.disconnect()
        if (previous.disabled) throw new Error('A page step must remain available during navigation')
        previous.click()
      })
      observer.observe(input, { attributes: true, attributeFilter: ['disabled'] })
      element.querySelector<HTMLButtonElement>('.dsh-pdf-tool-explain')!.click()
    })
    await status.waitFor({ state: 'hidden' })
    await editor.waitFor({ state: 'hidden' })
    await reader.getByText('The page is not ready yet. Please retry.', { exact: true }).waitFor({ state: 'visible' })
    // Failure preserves the uncounted question and unlocks ordinary reading.
    // Explicit mode entry can then resume it after the newer navigation ends.
    await expect.poll(() => pendingPage.isEnabled()).toBe(true)
    await expect.poll(() => mainToolbar.getByRole('button', { name: 'Start explanation mode' }).isEnabled()).toBe(true)
    await mainToolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    await editor.waitFor({ state: 'visible' })
    await expect.poll(() => passageQuestion.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await passageQuestion.inputValue()).toBe('Why is this passage important?')
    expect(await status.locator('.dsh-pdf-mode-count').count()).toBe(0)
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(0)
    expect(awayFromPending - await reader.locator('.dsh-pdf-scroll').evaluate(root => root.scrollTop)).toBeGreaterThan(30)
    await chooseZoom(reader, 'Fit width')
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
    // Switching modes preserves both fixed tool groups and the saved material.
    // The list can reopen the question without moving an already visible anchor.
    await mainToolbar.getByRole('button', { name: 'Exit explanation mode' }).focus()
    await page.keyboard.press('Enter')
    await status.waitFor({ state: 'hidden' })
    await expect.poll(() => mainToolbar.getByRole('button', { name: 'Start explanation mode' }).evaluate(element => document.activeElement === element)).toBe(true)
    expect(await marks.count()).toBe(0)
    await page.keyboard.press('Enter')
    await status.waitFor({ state: 'visible' })
    await expect.poll(() => status.locator('.dsh-pdf-mode-count').textContent()).toBe('1')
    await expect.poll(() => marks.count()).toBe(1)
    const beforeListEdit = await reader.locator('.dsh-pdf-scroll').evaluate(root => root.scrollTop)
    await status.locator('.dsh-pdf-explanation-materials-trigger').click()
    const materials = reader.locator('.dsh-pdf-explanation-materials')
    // The popover is portaled outside the rail. Its close/delete artwork must
    // remain painted even though ordinary toolbar icons default to hidden.
    for (const icon of [materials.getByRole('button', { name: 'Close explanation materials', exact: true }).locator('svg'),
      materials.getByRole('button', { name: 'Delete passage question 1', exact: true }).locator('svg')]) {
      expect(await icon.evaluate(element => {
        const box = element.getBoundingClientRect()
        return getComputedStyle(element).display !== 'none' && box.width >= 14 && box.height >= 14
      })).toBe(true)
    }
    await materials.getByRole('button', { name: 'Edit question for passage 1', exact: true }).click()
    await editor.waitFor({ state: 'visible' })
    expect(await passageQuestion.inputValue()).toBe('Why is this passage important?')
    expect(Math.abs(await reader.locator('.dsh-pdf-scroll').evaluate(root => root.scrollTop) - beforeListEdit)).toBeLessThanOrEqual(1)
    await editor.getByRole('button', { name: 'Cancel' }).click()
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
    if (process.env.DSH_PDF_EXPLANATION_SCREENSHOT_DIR) {
      const directory = process.env.DSH_PDF_EXPLANATION_SCREENSHOT_DIR
      await mkdir(directory, { recursive: true })
      const readerStyle = await reader.getAttribute('style')
      const enterFullscreen = page.locator('[data-sidebar-right-mode="fullscreen"]')
      const changeDock = await enterFullscreen.isVisible()
      if (changeDock) await enterFullscreen.click()
      try {
        await reader.evaluate(element => { Object.assign((element as HTMLElement).style, { width: '900px', height: '640px' }) })
        await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(900)
        await reader.screenshot({ path: join(directory, 'explanation-real-wide.png') })
        await status.locator('.dsh-pdf-explanation-materials-trigger').click()
        await reader.locator('.dsh-pdf-explanation-materials').waitFor({ state: 'visible' })
        await reader.screenshot({ path: join(directory, 'explanation-real-materials.png') })
        await page.keyboard.press('Escape')
        await reader.evaluate(element => { Object.assign((element as HTMLElement).style, { width: '350px', height: '320px' }) })
        await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(350)
        await expect.poll(() => reader.evaluate(element => element.clientHeight)).toBe(320)
        await reader.screenshot({ path: join(directory, 'explanation-real-narrow-short.png') })
      } finally {
        await reader.evaluate((element, style) => {
          if (style === null) element.removeAttribute('style')
          else element.setAttribute('style', style)
        }, readerStyle)
        if (changeDock) await page.locator('[data-sidebar-right-mode="push"]').click()
      }
    }
    // A lost connection must keep the question as an editable draft and show
    // why the ordinary Session prompt could not be queued. The user can retry
    // after reconnecting rather than reconstructing the PDF selection.
    await page.context().setOffline(true)
    await status.getByRole('button', { name: 'Send for explanation' }).click()
    await reader.locator('.dsh-pdf-activity-trigger').click()
    const explanationError = reader.locator('[data-status-id="explanation"]')
    await explanationError.waitFor({ state: 'visible', timeout: 10_000 })
    expect((await explanationError.textContent())?.trim()).toBeTruthy()
    expect(await reader.locator('.dsh-pdf-activity-trigger').getAttribute('aria-expanded')).toBe('true')
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(1)
    await expect.poll(() => status.getByRole('button', { name: 'Retry explanation', exact: true }).isEnabled()).toBe(true)
    await page.context().setOffline(false)
    await page.keyboard.press('Escape')
    await status.getByRole('button', { name: 'Retry explanation', exact: true }).click()
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    const status = reader.locator('.dsh-pdf-mode-explanation')
    const imageRegion = toolbar.getByRole('button', { name: 'Select image region' })
    await status.waitFor({ state: 'visible' })
    expect(await imageRegion.count()).toBe(1)
    expect(await status.getByRole('button', { name: 'Select image region' }).count()).toBe(1)
    // The seeded text-only model must not offer a screenshot it cannot read.
    await expect.poll(() => imageRegion.isDisabled()).toBe(true)
    await status.getByRole('button', { name: 'Exit explanation mode' }).click()
    await status.waitFor({ state: 'hidden' })
    const selection = await scaffold.ctx.sessionController.selectModel({ sessionId,
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    expect(selection).toMatchObject({ selected: { model: 'deepseek-v4-flash-vision-exp' } })
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    await status.waitFor({ state: 'visible' })
    await expect.poll(() => imageRegion.isEnabled()).toBe(true)

    // Area selection is a reversible mode; cancelling it must leave the
    // explanation draft available for the next actual region selection.
    await imageRegion.click()
    await expect.poll(() => toolbar.getByRole('button', { name: 'Cancel region selection' }).getAttribute('aria-pressed')).toBe('true')
    await toolbar.getByRole('button', { name: 'Cancel region selection' }).click()
    await expect.poll(() => imageRegion.getAttribute('aria-pressed')).toBe('false')

    const secondPage = reader.locator('[data-pdf-page="2"]')
    await secondPage.scrollIntoViewIfNeeded()
    await secondPage.locator('canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await chooseZoom(reader, '200%')
    const scroll = reader.locator('.dsh-pdf-scroll')
    await scroll.evaluate(root => {
      const wrap = root.querySelector<HTMLElement>('[data-page-number="2"]')!
      const stage = wrap.querySelector<HTMLElement>('.dsh-pdf-page-stage')!
      root.scrollTop = wrap.offsetTop + stage.offsetHeight - root.clientHeight + 24
    })
    await imageRegion.click()
    await reader.locator('.dsh-pdf-mode-region[data-pdf-page="2"]').waitFor({ state: 'visible' })
    const box = await secondPage.boundingBox()
    const bar = await toolbar.boundingBox()
    if (!box || !bar) throw new Error('The second PDF page is not available for region selection')
    const scrollBox = (await reader.locator('.dsh-pdf-scroll').boundingBox())!
    const padding = await scroll.evaluate(root => ({ left: parseFloat(getComputedStyle(root).paddingLeft), right: parseFloat(getComputedStyle(root).paddingRight) }))
    const start = { x: Math.max(box.x + 52, scrollBox.x + padding.left + 20), y: Math.max(box.y + box.height - 150, scrollBox.y + 18) }
    const end = { x: Math.min(box.x + box.width - 20, scrollBox.x + scrollBox.width - padding.right - 12, start.x + 180),
      y: Math.min(box.y + box.height - 20, start.y + 75) }
    expect(end.x - start.x).toBeGreaterThan(20)
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
    const pageField = reader.getByRole('textbox', { name: 'Page', exact: true })
    const editFromList = async () => {
      await status.locator('.dsh-pdf-explanation-materials-trigger').click()
      await reader.locator('.dsh-pdf-explanation-materials').getByRole('button', { name: 'Edit question for passage 1', exact: true }).click()
      await editor.waitFor({ state: 'visible' })
      expect(await editor.getByRole('textbox').inputValue()).toBe('What does this part of the second page show?')
      expect(await pageField.inputValue()).toBe('2')
    }
    // The material is near the bottom of a tall page. Jumping only to the page
    // start would leave its question anchor offscreen and the editor hidden.
    await scroll.evaluate(async root => {
      const wrap = root.querySelector<HTMLElement>('[data-page-number="2"]')!
      root.scrollTop = wrap.offsetTop - 20
      root.dispatchEvent(new Event('scroll', { bubbles: true }))
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    })
    expect(await regionMark.evaluate(element => {
      const bounds = element.getBoundingClientRect(), viewport = element.closest('.dsh-pdf-scroll')!.getBoundingClientRect()
      return bounds.top >= viewport.bottom || bounds.bottom <= viewport.top
    })).toBe(true)
    const samePageTop = await scroll.evaluate(root => root.scrollTop)
    await editFromList()
    expect(await scroll.evaluate(root => root.scrollTop)).toBeGreaterThan(samePageTop + 100)
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await pageField.fill('1'); await pageField.press('Enter')
    await expect.poll(() => pageField.isEnabled()).toBe(true)
    await editFromList()
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    // Reloading the source creates a new document content version. Its saved
    // explanation question must not be offered against the replacement view.
    await (await documentAction(reader, 'Reload source')).click()
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    const modeControl = toolbar.locator('.dsh-pdf-mode-explanation')
    const status = reader.locator('.dsh-pdf-mode-explanation')
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
      await expect.poll(() => modeControl.locator('.dsh-pdf-mode-count').textContent()).toBe(String(index))
    }
    const imageRegion = toolbar.getByRole('button', { name: 'Select image region' })
    await expect.poll(() => imageRegion.isDisabled()).toBe(true)
    await selectPassage()
    await reader.locator('.dsh-pdf-activity-trigger').click()
    const explanationError = reader.locator('[data-status-id="explanation"]')
    await explanationError.waitFor({ state: 'visible' })
    await expect.poll(() => explanationError.textContent())
      .toContain('Up to 20 passages or regions can be explained together.')
    expect(await editor.count()).toBe(0)
    expect(await imageRegion.isDisabled()).toBe(true)
    await expect.poll(() => reader.locator('.dsh-pdf-mode-region').count()).toBe(0)
    expect(await modeControl.locator('.dsh-pdf-mode-count').textContent()).toBe('20')
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(20)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 90_000)

it('recognizes the current PDF page through Host OCR and searches its page-level transcript', async () => {
  const recognizedText = ['Quartz OCR proof on page one.', ...Array(80).fill('Additional recognized line.')].join('\n')
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
      yield { type: 'text-delta', index: 0, text: recognizedText }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    browser = await launchBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-ocr-transcript-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
      const frame = getComputedStyle(element.querySelector('.dsh-pdf-sidebar-main')!)
      const heading = element.querySelector('.dsh-pdf-panel-heading')!
      return { backgroundImage: frame.backgroundImage, backgroundColor: frame.backgroundColor,
        backdropFilter: frame.backdropFilter, shellBackground: style.backgroundImage, shellBackdrop: style.backdropFilter,
        containerBackground: position.backgroundImage, containerBackdrop: position.backdropFilter, position: position.position,
        top: position.top, right: position.right, bottom: position.bottom,
        borderRadius: frame.borderRadius, shellBorder: style.borderTopWidth, shellShadow: style.boxShadow,
        frameBorder: frame.borderTopWidth, frameDivider: frame.borderLeftWidth, frameShadow: frame.boxShadow,
        heading: getComputedStyle(heading).backgroundColor }
    })
    expect(sidebarMaterial.backgroundImage).toContain('linear-gradient')
    expect(sidebarMaterial.backdropFilter).toContain('blur(24px)')
    expect(sidebarMaterial.shellBackground).toBe('none')
    expect(sidebarMaterial.shellBackdrop).toBe('none')
    expect(sidebarMaterial.containerBackground).toBe('none')
    expect(sidebarMaterial.containerBackdrop).toBe('none')
    expect(sidebarMaterial.position).toBe('absolute')
    expect(parseFloat(sidebarMaterial.top)).toBeGreaterThanOrEqual(0)
    expect(parseFloat(sidebarMaterial.right)).toBeGreaterThan(0)
    expect(parseFloat(sidebarMaterial.bottom)).toBeGreaterThan(0)
    expect(sidebarMaterial.borderRadius).toBe('18px')
    expect(sidebarMaterial.shellBorder).toBe('0px')
    expect(sidebarMaterial.shellShadow).toBe('none')
    expect(sidebarMaterial.frameBorder).toBe('1px')
    expect(sidebarMaterial.frameDivider).toBe('1px')
    expect(sidebarMaterial.frameShadow).not.toBe('none')
    expect(sidebarMaterial.frameShadow).toContain('inset')
    expect(sidebarMaterial.heading).toBe('rgba(0, 0, 0, 0)')
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
    const assertBackdropTint = async () => {
      const toolbar = (await reader.locator('[data-tool-group="navigation"]').boundingBox())!
      const sidebarBox = (await sidebar.locator('.dsh-pdf-sidebar-rail-shell').boundingBox())!
      const [toolbarTint, sidebarTint] = await Promise.all([
        sampleMaterial(toolbar.x + 5, toolbar.y + toolbar.height - 12),
        sampleMaterial(sidebarBox.x + 5, sidebarBox.y + sidebarBox.height - 12),
      ])
      // Chrome remains visibly the same family over the dark preview well and
      // white paper. Retain a little backdrop variation, not an exact pixel match.
      expect(Math.max(...toolbarTint.map((channel, index) => Math.abs(channel - sidebarTint[index]))),
        JSON.stringify({ toolbarTint, sidebarTint })).toBeLessThanOrEqual(18)
    }
    const assertSharedGlass = async (dark: boolean) => {
      // Compare the shared shell material independently of control feedback;
      // button hover is covered separately by interaction tests.
      await page.mouse.move(0, 0)
      const surfaces = await reader.evaluate(element => {
        const describe = (selector: string, pseudo: string) => {
          const surface = element.querySelector(selector)!
          const style = getComputedStyle(surface, pseudo)
          const variables = getComputedStyle(surface)
          return { background: style.backgroundImage, filter: style.backdropFilter,
            border: variables.borderColor, rim: variables.getPropertyValue('--pdf-glass-rim-shadow').trim(),
            tint: variables.getPropertyValue('--pdf-glass-shell-tint').trim(),
            top: variables.getPropertyValue('--pdf-glass-shell-top').trim(),
            fill: variables.getPropertyValue('--pdf-glass-shell-fill').trim() }
        }
        return { toolbar: describe('.dsh-pdf-tool-rail-shell', ''),
          sidebar: describe('.dsh-pdf-sidebar-rail-shell', ''), panel: describe('.dsh-pdf-sidebar-main', '') }
      })
      // Test the material, not identical pixels over different backdrops:
      // white paper under a sidebar can naturally differ from the preview well.
      expect(surfaces.sidebar).toEqual(surfaces.toolbar)
      expect(surfaces.panel).toEqual(surfaces.toolbar)
      expect(surfaces.sidebar.background).toContain(dark ? '22px' : '32px')
      expect(surfaces.sidebar.background).toContain('44px')
      expect(surfaces.sidebar.filter).toBe('blur(24px) saturate(1.8)')
    }
    await assertSharedGlass(false)
    await page.emulateMedia({ contrast: 'more' })
    const opaqueSurfaces = await reader.evaluate(element =>
      [['.dsh-pdf-tool-rail-shell', ''], ['.dsh-pdf-sidebar-rail-shell', '']].map(([selector, pseudo]) => {
        const surface = element.querySelector(selector)!
        const style = getComputedStyle(surface, pseudo)
        return { filter: style.backdropFilter, image: style.backgroundImage, color: style.backgroundColor,
          container: getComputedStyle(surface).backgroundColor }
      }))
    expect(opaqueSurfaces[0].filter).toBe(opaqueSurfaces[1].filter)
    expect(opaqueSurfaces[0].image).toBe(opaqueSurfaces[1].image)
    expect(opaqueSurfaces[0].color).toBe(opaqueSurfaces[1].color)
    expect(opaqueSurfaces[0].filter).toBe('none')
    expect(opaqueSurfaces[0].image).toBe('none')
    expect(opaqueSurfaces[0].color).not.toBe('rgba(0, 0, 0, 0)')
    expect(opaqueSurfaces[1].container).toBe(opaqueSurfaces[0].container)
    expect(await sidebar.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await page.emulateMedia({ contrast: 'no-preference' })
    const sections = ['Pages', 'Bookmarks', 'Annotations', 'Search', 'Translation', 'OCR'] as const
    let baseline: { top: number; left: number; height: number; fontSize: string; paginationTop: number } | undefined
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
          paginationTop: element.closest('.dsh-pdf-sidebar')!.querySelector('.dsh-pdf-sidebar-compact-nav')!.getBoundingClientRect().top }
      })
      if (baseline) {
        expect(Math.abs(geometry.top - baseline.top), `${name} heading top`).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.left - baseline.left), `${name} heading inset`).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.height - baseline.height), `${name} heading height`).toBeLessThanOrEqual(1)
        expect(geometry.fontSize, `${name} heading font`).toBe(baseline.fontSize)
        expect(Math.abs(geometry.paginationTop - baseline.paginationTop), `${name} pagination position`).toBeLessThanOrEqual(1)
      } else baseline = geometry
      if (name === 'OCR') {
        const scroll = panel.locator('.dsh-pdf-ocr-scroll > .dsh-pdf-panel-scroll')
        const [headerBounds, scrollBounds] = await Promise.all([heading.boundingBox(), scroll.boundingBox()])
        const scrollTop = await scroll.evaluate(element => getComputedStyle(element).top)
        expect(scrollBounds!.y, `OCR scroll top: ${scrollTop}`).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height - 1)
        expect(await scroll.locator('.dsh-pdf-panel-heading').count()).toBe(0)
      }
      if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
        await sidebar.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, `${name.toLowerCase()}.png`) })
      }
    }

    await openSidebarSection(reader, 'Bookmarks')
    const heading = sidebar.locator('.dsh-pdf-bookmark-heading')
    expect(await sidebar.locator('.dsh-pdf-bookmark-panel h3, .dsh-pdf-bookmark-panel h4').count()).toBe(1)
    expect(await heading.locator('h3').textContent()).toBe('Bookmarks')
    for (const size of ['Home', 'End']) {
      await sidebar.locator('.dsh-pdf-sidebar-divider').press(size)
      await expect.poll(() => sidebar.evaluate(element => Math.abs(element.getBoundingClientRect().width
        - parseFloat((element as HTMLElement).style.getPropertyValue('--pdf-sidebar-width'))))).toBeLessThanOrEqual(1)
      await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
      const fit = await heading.evaluate(element => element.scrollWidth <= element.clientWidth)
      expect(fit).toBe(true)
    }
    if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
      await reader.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'reader-bookmarks.png') })
    }
    await assertSharedGlass(false)
    await assertBackdropTint()
    const originalTheme = await page.locator('body').getAttribute('data-ds-dark-theme')
    await page.locator('body').evaluate(element => element.setAttribute('data-ds-dark-theme', ''))
    await assertSharedGlass(true)
    await assertBackdropTint()
    if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
      await reader.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'reader-bookmarks-dark.png') })
    }
    await page.locator('body').evaluate((element, value) => {
      if (value === null) element.removeAttribute('data-ds-dark-theme'); else element.setAttribute('data-ds-dark-theme', value)
    }, originalTheme)
    expect(await reader.getByRole('button', { name: 'Add PDF bookmark' })
      .evaluate(element => getComputedStyle(element).borderRadius)).toBe('6px')
    await openSidebarSection(reader, 'Annotations')
    const filter = reader.getByRole('combobox', { name: 'Filter annotations' })
    expect(await filter.evaluate(element => getComputedStyle(element).borderRadius)).toBe('6px')
    // Resize through the real divider so the revealed panel shell and reserved
    // column use the same width; overriding the outer column alone clips it.
    await sidebar.locator('.dsh-pdf-sidebar-divider').press('Home')
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    const annotationBounds = await reader.locator('.dsh-pdf-annotations-heading').evaluate(element => {
      const title = element.querySelector('h3')!.getBoundingClientRect()
      const control = element.querySelector('select')!.getBoundingClientRect()
      const heading = element.getBoundingClientRect()
      return { titleRight: title.right, controlLeft: control.left, controlRight: control.right, headingRight: heading.right }
    })
    expect(annotationBounds.titleRight).toBeLessThanOrEqual(annotationBounds.controlLeft)
    expect(annotationBounds.controlRight).toBeLessThanOrEqual(annotationBounds.headingRight - 11)
    await sidebar.locator('.dsh-pdf-sidebar-divider').press('End')
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))

    await openSidebarSection(reader, 'Search')
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
    await sidebar.locator('.dsh-pdf-sidebar-divider').press('Home')
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
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
    // Constrain the shared panel, whose flex scrollport otherwise consumes all
    // remaining height regardless of a height written on that flex child.
    await searchPanel.evaluate(element => { (element as HTMLElement).style.height = '218px' })
    await searchScroll.evaluate(element => {
      const scroll = element as HTMLElement
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
    await searchPanel.evaluate(element => { (element as HTMLElement).style.height = '' })
    await sidebar.locator('.dsh-pdf-sidebar-divider').press('End')
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))

    const toggle = sidebar.getByRole('tab', { selected: true })
    const main = sidebar.locator('.dsh-pdf-sidebar-main')
    const motion = await sidebar.evaluate(element => ({
      sidebar: getComputedStyle(element).transitionProperty,
      shell: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-shell')!).transitionProperty,
      content: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-main')!).transitionProperty,
      panels: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-panels')!).transitionProperty,
      pagination: getComputedStyle(element.querySelector('.dsh-pdf-sidebar-compact-nav')!).transitionDuration,
    }))
    expect(motion.sidebar).toContain('width')
    expect(motion.shell).toContain('clip-path')
    expect(motion.content).toContain('opacity')
    expect(motion.panels).toContain('transform')
    expect(motion.pagination).toBe('0s')
    expect(await sidebar.locator('.dsh-pdf-sidebar-toggle').count()).toBe(0)
    await toggle.click()
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await main.getAttribute('aria-hidden')).toBe('true')
    expect(await main.evaluate(element => (element as HTMLElement).inert)).toBe(true)
    await expect.poll(() => sidebar.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(56)
    await expect.poll(() => sidebar.evaluate(element => {
      const clip = getComputedStyle(element.querySelector('.dsh-pdf-sidebar-shell')!).clipPath
      const shadowBleed = -parseFloat(clip.slice('inset('.length))
      const rail = element.querySelector('.dsh-pdf-sidebar-rail')!.getBoundingClientRect().width
      return shadowBleed > 0 && clip.includes(`calc(100% - ${rail + shadowBleed}px)`)
    }), { message: 'the collapsed clip retains the rail and its outer glass shadow' }).toBe(true)
    expect(await sidebar.locator('.dsh-pdf-sidebar-rail').evaluate(element => element.getBoundingClientRect().width)).toBe(56)
    await assertSharedGlass(false)
    const theme = await page.locator('body').getAttribute('data-ds-dark-theme')
    await page.locator('body').evaluate(element => element.setAttribute('data-ds-dark-theme', ''))
    await assertSharedGlass(true)
    if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
      await sidebar.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'sidebar-collapsed-dark.png') })
      await reader.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'reader-collapsed-dark.png') })
    }
    await page.locator('body').evaluate((element, value) => {
      if (value === null) element.removeAttribute('data-ds-dark-theme'); else element.setAttribute('data-ds-dark-theme', value)
    }, theme)
    if (process.env.PDF_SIDEBAR_SCREENSHOT_DIR) {
      await sidebar.screenshot({ path: join(process.env.PDF_SIDEBAR_SCREENSHOT_DIR, 'sidebar-collapsed.png') })
    }
    const compact = sidebar.locator('.dsh-pdf-sidebar-compact-nav')
    expect(await compact.getAttribute('aria-hidden')).not.toBe('true')
    expect(await compact.evaluate(element => (element as HTMLElement).inert)).toBe(false)
    await toggle.click()
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await main.evaluate(element => (element as HTMLElement).inert)).toBe(false)
    expect(await compact.evaluate(element => (element as HTMLElement).inert)).toBe(false)
    await expect.poll(() => main.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await sidebar.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    expect(await sidebar.locator('.dsh-pdf-sidebar-shell').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    expect(await main.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    expect(await sidebar.locator('.dsh-pdf-sidebar-panels').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    const setReaderWidth = async (width: number) => {
      await reader.evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px` }, width)
      await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(width)
      await reader.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    }
    await setReaderWidth(960)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await setReaderWidth(700)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    const readingContent = reader.locator('.dsh-pdf-content')
    expect(await readingContent.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const toolbarResize = await reader.evaluate(async element => {
      const controls = element.querySelector<HTMLElement>('.dsh-pdf-scroll')!
      const toolbar = element.querySelector<HTMLElement>('.dsh-pdf-main-toolbar')!
      const toggle = element.querySelector<HTMLButtonElement>('.dsh-pdf-sidebar-tab[aria-selected="true"]')!
      const width = () => { const style = getComputedStyle(controls); return controls.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) }
      const before = width()
      const toolbarBefore = toolbar.getBoundingClientRect().width
      toggle.click()
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      await new Promise<void>(resolve => setTimeout(resolve, 90))
      const during = width()
      const toolbarDuring = toolbar.getBoundingClientRect().width
      const property = getComputedStyle(controls).transitionProperty
      await new Promise<void>(resolve => setTimeout(resolve, 260))
      return { before, during, after: width(), toolbarBefore, toolbarDuring,
        toolbarAfter: toolbar.getBoundingClientRect().width, property }
    })
    expect(toolbarResize.property).not.toContain('right')
    expect(toolbarResize.during, JSON.stringify(toolbarResize)).toBeLessThan(toolbarResize.before - 1)
    expect(toolbarResize.during, JSON.stringify(toolbarResize)).toBeGreaterThan(toolbarResize.after + 1)
    expect([toolbarResize.toolbarBefore, toolbarResize.toolbarDuring, toolbarResize.toolbarAfter]).toEqual([56, 56, 56])
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    const toolbarRestore = await reader.evaluate(async element => {
      const controls = element.querySelector<HTMLElement>('.dsh-pdf-scroll')!
      const toolbar = element.querySelector<HTMLElement>('.dsh-pdf-main-toolbar')!
      const toggle = element.querySelector<HTMLButtonElement>('.dsh-pdf-sidebar-tab[aria-selected="true"]')!
      const width = () => { const style = getComputedStyle(controls); return controls.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) }
      const before = width()
      const toolbarBefore = toolbar.getBoundingClientRect().width
      toggle.click()
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      await new Promise<void>(resolve => setTimeout(resolve, 90))
      const during = width()
      const toolbarDuring = toolbar.getBoundingClientRect().width
      await new Promise<void>(resolve => setTimeout(resolve, 260))
      return { before, during, after: width(), toolbarBefore, toolbarDuring, toolbarAfter: toolbar.getBoundingClientRect().width }
    })
    expect(toolbarRestore.during, JSON.stringify(toolbarRestore)).toBeGreaterThan(toolbarRestore.before + 1)
    expect(toolbarRestore.during, JSON.stringify(toolbarRestore)).toBeLessThan(toolbarRestore.after - 1)
    expect([toolbarRestore.toolbarBefore, toolbarRestore.toolbarDuring, toolbarRestore.toolbarAfter]).toEqual([56, 56, 56])
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await sidebar.locator('.dsh-pdf-sidebar-shell').evaluate(element =>
      Promise.all(element.getAnimations().map(animation => animation.finished)))
    const dividerBounds = await sidebar.locator('.dsh-pdf-sidebar-divider').boundingBox()
    expect(dividerBounds).not.toBeNull()
    const dividerPoint = { x: dividerBounds!.x + dividerBounds!.width - 0.5, y: dividerBounds!.y + dividerBounds!.height / 2 }
    expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.className, dividerPoint))
      .toContain('dsh-pdf-sidebar-divider')
    await page.mouse.move(dividerPoint.x, dividerPoint.y)
    await page.mouse.down()
    await expect.poll(() => sidebar.getAttribute('data-resizing')).toBe('')
    expect(await sidebar.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    expect(await readingContent.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
    await page.mouse.up()
    await expect.poll(() => sidebar.getAttribute('data-resizing')).toBeNull()
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
    await reader.locator('.dsh-pdf-activity-trigger.dsh-pdf-save-feedback[data-kind="saved"]')
      .waitFor({ state: 'visible' })
    await expect.poll(() => save.isDisabled()).toBe(true)

    const savedDocument = await loadPdfDocument(await readFile(join(scaffold.workspaceCwd, filename)))
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
    await openSidebarSection(reader, 'Pages')
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
          name: 'pdf_page_read', arguments: JSON.stringify({ documentId: opened.id, page: 2 }) })),
        source: { provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    for (const entry of entries) {
      const args = JSON.stringify({ documentId: opened.id, page: 2 })
      const call = session.append('tool/call', { turn: 2, step: 1, callId: entry.id,
        name: 'pdf_page_read', arguments: args })
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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

    const related = await executeScaffoldTool(scaffold.ctx.tools, {
      signal: new AbortController().signal,
      callId: ToolCallId('pdf-keyword-web-e2e'),
      name: 'pdf_keyword_search',
      arguments: { documentId: opened.id, query: 'Browser PDF page two', page: 2 },
      agent: resolved.agent,
    })
    expect(related.isError).toBe(false)
    expect(related.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain('Browser PDF page two')
    const matchedText = related.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const matched = JSON.parse(matchedText.slice(matchedText.indexOf('{'))) as { matches: { evidence: { refId: string } }[] }
    const annotation = await executeScaffoldTool(scaffold.ctx.tools, {
      signal: new AbortController().signal,
      callId: ToolCallId('pdf-mark-related-web-e2e'),
      name: 'pdf_annotation_create',
      arguments: { documentId: opened.id, expectedRevision: opened.revision,
        subtype: 'Highlight', target: { kind: 'reference', refId: matched.matches[0]!.evidence.refId } },
      agent: resolved.agent,
    })
    expect(annotation.isError).toBe(false)
    await expect.poll(() => reader.locator('[data-pdf-page="2"] .dsh-pdf-annotation-overlay path').count())
      .toBeGreaterThan(0)

    // An annotation changes the working-copy revision. Navigation must still
    // accept the unchanged page-content version and preserve Reader history.
    const navigation = await executeScaffoldTool(scaffold.ctx.tools, {
      signal: new AbortController().signal,
      callId: ToolCallId('pdf-agent-navigate-web-e2e'),
      name: 'pdf_page_jump',
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

it('reuses evidence references for exact repeated-text jumps, annotation and multi-level Reader history', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-exact-evidence-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'PDF exact evidence test' })
    const filename = 'reader-exact-evidence-e2e.pdf', path = join(scaffold.workspaceCwd, filename)
    const source = await PDFDocument.create(), font = await source.embedFont(StandardFonts.Helvetica)
    source.addPage([400, 1400]).drawText('Origin reading position', { x: 50, y: 1300, size: 15, font })
    const evidencePage = source.addPage([400, 1400])
    evidencePage.drawText('Repeated evidence', { x: 50, y: 1100, size: 15, font })
    evidencePage.drawText('Different surrounding context', { x: 50, y: 800, size: 15, font })
    evidencePage.drawText('Repeated evidence', { x: 50, y: 500, size: 15, font })
    // A following page keeps both targets away from the document-end scroll clamp.
    source.addPage([400, 1400]).drawText('Following page', { x: 50, y: 1300, size: 15, font })
    await writeFile(path, await source.save({ useObjectStreams: false }))
    const resolved = await scaffold.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    let call = 0
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await executeScaffoldTool(scaffold.ctx.tools, { signal: new AbortController().signal,
        callId: ToolCallId(`pdf-exact-evidence-${++call}`), name, arguments: args, agent: resolved.agent })
      expect(result.isError, result.content.filter(part => part.type === 'text').map(part => part.text).join('')).toBe(false)
      const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('')
      return JSON.parse(text.slice(text.indexOf('{')))
    }
    const opened = await tool('pdf_open', { path }) as { documentId: string; revision: number }
    const located = await tool('pdf_keyword_search', { documentId: opened.documentId, page: 2, query: 'Repeated evidence' }) as {
      matches: Array<{ offset: number; evidence: { refId: string } }>
    }
    expect(located.matches).toHaveLength(2)
    const [first, second] = [...located.matches].sort((a, b) => a.offset - b.offset)
    browser = await launchBrowser()
    const page = await newEnglishPage(browser), tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'pdf-exact-evidence-browser'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('treeitem').filter({ hasText: 'PDF exact evidence test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: filename, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader'), scroll = reader.locator('.dsh-pdf-scroll')
    await reader.locator('[data-pdf-page="1"] [data-pdf-text="active"]').waitFor({ state: 'attached', timeout: 20_000 })
    await chooseZoom(reader, '100%')
    const position = () => scroll.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))
    const origin = await position()
    await tool('pdf_page_jump', { documentId: opened.documentId, refId: first!.evidence.refId })
    await expect.poll(() => reader.locator('.dsh-pdf-page-input:visible').first().inputValue()).toBe('2')
    const firstPosition = await position()
    await tool('pdf_page_jump', { documentId: opened.documentId, refId: second!.evidence.refId })
    const secondPosition = await position()
    expect(secondPosition.top - firstPosition.top).toBeGreaterThan(500)
    const targetInViewport = await reader.locator('[data-pdf-page="2"]').evaluate(element => {
      const bounds = element.getBoundingClientRect(), viewport = element.closest('.dsh-pdf-scroll')!.getBoundingClientRect()
      return bounds.top + bounds.height * (1400 - 500) / 1400 - viewport.top
    })
    expect(targetInViewport).toBeGreaterThan(65)
    expect(targetInViewport).toBeLessThan(180)
    // The very same exact reference can be written without re-quoting or guessing geometry.
    await tool('pdf_annotation_create', { documentId: opened.documentId, expectedRevision: opened.revision,
      subtype: 'Highlight', target: { kind: 'reference', refId: second!.evidence.refId } })
    await expect.poll(() => reader.locator('[data-pdf-page="2"] .dsh-pdf-annotation-overlay path').count()).toBeGreaterThan(0)
    const back = reader.getByRole('button', { name: 'Back', exact: true })
    await expect.poll(() => back.isEnabled()).toBe(true)
    await back.click()
    await expect.poll(async () => Math.abs((await position()).top - firstPosition.top)).toBeLessThan(2)
    await expect.poll(() => back.isEnabled()).toBe(true)
    await back.click()
    await expect.poll(async () => Math.abs((await position()).top - origin.top)).toBeLessThan(2)
    expect(tripwire.pageErrors).toEqual([])
  } finally { await browser?.close(); await scaffold.close() }
}, 120_000)

it('loads the installed PDF plugin and saves a browser-created note into the real PDF file', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.name === '@dylanl1/dsh-plugin-pdf')
    expect(entry?.fiber?.state).toBe(2)
    const profileRequire = createRequire(join(scaffold.harnessHome, 'profiles', 'scaffold', 'package.json'))
    expect(realpathSync(profileRequire.resolve('@dylanl1/dsh-plugin-pdf'))).toBe(realpathSync(join(ROOT, 'dist', 'index.js')))

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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    const ocrSwitch = settings.getByRole('switch', { name: 'OCR' })
    // OCR availability is now determined by the Host for the active session,
    // rather than a user-facing toggle in PDF settings.
    expect(await ocrSwitch.count()).toBe(0)
    expect(await settings.getByRole('combobox', { name: 'OCR engine' }).count()).toBe(1)
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
    await historyCapacity.blur()
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'pdf-reader')?.value).toMatchObject({ historyCapacity: 101 })
    await expect.poll(() => settings.locator('.dsh-pdf-settings-save-status').textContent()).toMatch(/^Settings are up to date/)
    await page.keyboard.press('Escape')
    await openSettings(page, 'en')
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    await expect.poll(() => historyCapacity.inputValue()).toBe('101')
    await settings.getByRole('button', { name: 'Restore defaults' }).click()
    await expect.poll(() => historyCapacity.inputValue()).toBe('100')
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'pdf-reader')?.value).toMatchObject({ historyCapacity: 100 })
    await expect.poll(() => settings.locator('.dsh-pdf-settings-save-status').textContent()).toMatch(/^Settings are up to date/)
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
    await openSidebarSection(reader, 'Pages')
    const pagesHeading = reader.locator('.dsh-pdf-thumbnail-panel > .dsh-pdf-panel-heading h3')
    await pagesHeading.waitFor({ state: 'visible' })
    await expect.poll(() => pagesHeading.evaluate(element =>
      new DOMMatrix(getComputedStyle(element.parentElement!).transform).m41)).toBe(0)
    const pagesInset = await pagesHeading.evaluate(element => element.getBoundingClientRect().left
      - element.closest('.dsh-pdf-thumbnail-panel')!.getBoundingClientRect().left)
    await reader.getByRole('button', { name: 'Page 1 / 2' }).waitFor({ state: 'visible' })
    await reader.getByRole('button', { name: 'Page 2 / 2' }).waitFor({ state: 'visible' })
    await openSidebarSection(reader, 'Bookmarks')
    const bookmarksHeading = reader.locator('.dsh-pdf-bookmark-panel > .dsh-pdf-panel-heading h3')
    await bookmarksHeading.waitFor({ state: 'visible' })
    const bookmarksInset = await bookmarksHeading.evaluate(element => element.getBoundingClientRect().left
      - element.closest('.dsh-pdf-bookmark-panel')!.getBoundingClientRect().left)
    expect(pagesInset).toBeGreaterThanOrEqual(9)
    expect(bookmarksInset).toBeGreaterThanOrEqual(9)
    expect(Math.abs(pagesInset - bookmarksInset)).toBeLessThanOrEqual(1)
    await openSidebarSection(reader, 'Annotations')
    expect(await reader.getByRole('tab', { name: 'Notes', exact: true }).count()).toBe(0)
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const save = toolbar.getByRole('button', { name: 'Save', exact: true })
    const content = reader.locator('.dsh-pdf-content')
    await expectFloatingToolRails(reader)
    const [toolbarBox, contentBox] = await Promise.all([toolbar.boundingBox(), content.boundingBox()])
    expect(toolbarBox).not.toBeNull()
    expect(contentBox).not.toBeNull()
    const firstPageBox = await reader.locator('[data-pdf-page="1"]').boundingBox()
    expect(firstPageBox).not.toBeNull()
    // The tool column and scrolling document occupy independent layout columns.
    expect(firstPageBox!.y + firstPageBox!.height).toBeGreaterThan(contentBox!.y)
    expect(firstPageBox!.y).toBeLessThan(contentBox!.y + contentBox!.height)
    const material = await toolbar.evaluate(element => {
      const surface = getComputedStyle(element.querySelector('.dsh-pdf-tool-rail-shell')!)
      return { backgroundImage: surface.backgroundImage, backdropFilter: surface.backdropFilter,
        containerBackdropFilter: getComputedStyle(element).backdropFilter,
        stackingIsolation: getComputedStyle(element).isolation }
    })
    expect(material.backgroundImage).toContain('linear-gradient')
    expect(material.backdropFilter).toContain('blur(24px)')
    expect(material.containerBackdropFilter).toBe('none')
    expect(await toolbar.locator(':scope > .dsh-pdf-tool-rail-shell.dsh-pdf-glass').count()).toBe(1)
    await page.emulateMedia({ contrast: 'more' })
    expect(await toolbar.evaluate(element => getComputedStyle(element.querySelector('.dsh-pdf-tool-rail-shell')!).backdropFilter)).toBe('none')
    await page.emulateMedia({ contrast: 'no-preference' })
    expect(await toolbar.locator('.dsh-pdf-tools > summary').evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap')
    const zoomTrigger = toolbar.locator('.dsh-pdf-toolbar-zoom')
    const zoomControl = zoomTrigger.locator('summary')
    expect(await zoomControl.locator('svg').count()).toBe(1)
    expect(await zoomControl.getAttribute('aria-label')).toBe('Zoom: Fit width')
    const zoomIdleBackground = await zoomControl.evaluate(element => getComputedStyle(element).backgroundColor)
    await zoomControl.hover()
    await expect.poll(() => zoomControl.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(zoomIdleBackground)
    await zoomControl.evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)))
    const zoomHoverBackground = await zoomControl.evaluate(element => getComputedStyle(element).backgroundColor)
    expect(await zoomControl.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    await zoomControl.click()
    const zoomMenu = reader.locator('.dsh-pdf-zoom-menu')
    expect(await zoomMenu.getByRole('button', { name: 'Fit width' }).getAttribute('aria-pressed')).toBe('true')
    expect(await zoomMenu.getByRole('button', { name: 'Fit page' }).count()).toBe(1)
    await page.mouse.move(0, 0)
    await expect.poll(() => zoomControl.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(zoomHoverBackground)
    const [zoomMenuBox, zoomToolbarBox] = await Promise.all([zoomMenu.boundingBox(), toolbar.boundingBox()])
    expect(zoomMenuBox).not.toBeNull()
    expect(zoomToolbarBox).not.toBeNull()
    expect(zoomMenuBox!.x).toBeGreaterThanOrEqual(zoomToolbarBox!.x + zoomToolbarBox!.width)
    const zoomReaderBox = (await reader.boundingBox())!
    expect(zoomMenuBox!.x + zoomMenuBox!.width).toBeLessThanOrEqual(zoomReaderBox.x + zoomReaderBox.width - 7)
    expect(await zoomMenu.getByRole('button', { name: '100%' }).evaluate(element => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
    })).toBe(true)
    await zoomMenu.getByRole('button', { name: '100%' }).click()
    await zoomMenu.waitFor({ state: 'hidden' })
    expect(await zoomControl.getAttribute('aria-label')).toBe('Zoom: 100%')
    // Both dropdowns use the same decorative arrow inside one click target.
    const zoomArrow = zoomControl.locator('.dsh-pdf-toolbar-chevron')
    expect(await zoomArrow.count()).toBe(1)
    expect(await zoomArrow.evaluate(element => element.parentElement?.tagName)).toBe('SUMMARY')
    expect(await toolbar.locator('.dsh-pdf-toolbar-zoom button.dsh-pdf-toolbar-chevron').count()).toBe(0)
    expect((await zoomArrow.boundingBox())!.width).toBeGreaterThan(2)
    await zoomArrow.click()
    await zoomMenu.waitFor({ state: 'visible' })
    await zoomControl.click()
    await zoomMenu.waitFor({ state: 'hidden' })
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
    const saveDescription = reader.locator('.dsh-pdf-save-control [role="status"]')
    expect(await reader.locator('.dsh-pdf-save-feedback').count()).toBe(0)
    expect(await save.getAttribute('data-save-state')).toBe('saved')
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
    // Earlier bookmark/zoom actions can leave the first line outside the
    // reading viewport. Return to the page start before a real pointer drag.
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
    await expect.poll(async () => (await textLineBox()).y).toBeGreaterThanOrEqual(contentBox!.y)
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
    expect(selectionToolbarBox!.x).toBeGreaterThanOrEqual(contentBox!.x)
    expect(selectionToolbarBox!.x + selectionToolbarBox!.width).toBeLessThanOrEqual(contentBox!.x + contentBox!.width + 1)
    expect(selectionToolbarBox!.y).toBeGreaterThanOrEqual(contentBox!.y)
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
    await toolbar.getByRole('button', { name: 'Start explanation mode' }).click()
    const modeControl = toolbar.locator('.dsh-pdf-mode-explanation')
    const explanationStatus = reader.locator('.dsh-pdf-mode-explanation')
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
    await expect.poll(() => modeControl.locator('.dsh-pdf-mode-count').textContent()).toBe('1')
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
    await modeControl.locator('.dsh-pdf-explanation-materials-trigger').click()
    await reader.locator('.dsh-pdf-explanation-materials').getByRole('button', { name: 'Delete passage question 1', exact: true }).click()
    await page.keyboard.press('Escape')
    expect(await reader.locator('.dsh-pdf-explanation-index').allTextContents()).toEqual(['1'])
    await reader.getByRole('button', { name: 'Edit question for passage 1' }).click()
    expect(await explanationEditor.getByRole('textbox').inputValue())
      .toBe('How does the second passage differ?')
    await explanationEditor.getByRole('button', { name: 'Cancel' }).click()
    await explanationStatus.getByRole('button', { name: 'Exit explanation mode' }).click()
    expect(await reader.locator('[data-pdf-explanation-mark]').count()).toBe(0)
    await reader.locator('[data-pdf-page="1"]').click({ position: { x: 8, y: 8 } })
    await selectionToolbar.waitFor({ state: 'hidden' })

    // The compact menu is the short-reader presentation; tall readers expose these commands directly.
    const menuViewport = page.viewportSize()!
    await page.setViewportSize({ ...menuViewport, height: 600 })
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    const toolsMenu = fileActions(reader)
    const fileItem = toolsMenu.getByRole('button', { name: 'Save as', exact: true })
    const noteTool = toolbar.getByRole('button', { name: 'Note', exact: true })
    const menuMaterial = await toolsMenu.evaluate(element => {
      const pod = element.closest('.dsh-pdf-reader')!.querySelector('.dsh-pdf-tool-rail-shell')!
      const menu = getComputedStyle(element), surface = getComputedStyle(pod)
      return { backgroundImage: menu.backgroundImage, backdropFilter: menu.backdropFilter,
        toolbarBackgroundImage: surface.backgroundImage, toolbarBackdropFilter: surface.backdropFilter }
    })
    expect(menuMaterial.backgroundImage).toBe(menuMaterial.toolbarBackgroundImage)
    expect(menuMaterial.backdropFilter).toBe(menuMaterial.toolbarBackdropFilter)
    expect(await toolsMenu.evaluate(element => getComputedStyle(element).borderRadius)).toBe('12px')
    expect(await fileItem.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('0px')
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    await page.setViewportSize(menuViewport)
    const noteIdleBackground = await noteTool.evaluate(element => getComputedStyle(element).backgroundColor)
    await noteTool.hover()
    await expect.poll(() => noteTool.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(noteIdleBackground)
    await noteTool.click()
    await expect.poll(() => noteTool.getAttribute('aria-pressed')).toBe('true')
    await reader.locator('[data-pdf-page="1"].dsh-pdf-mode-note').click({ position: { x: 120, y: 140 } })
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
    await expect.poll(() => save.getAttribute('data-save-state')).toBe('dirty')
    expect(await saveDescription.textContent()).toBe('Unsaved changes')
    const [feedbackBox, feedbackContentBox, feedbackToolbarBox, feedbackControlsBox] = await Promise.all([
      save.boundingBox(), content.boundingBox(), toolbar.boundingBox(), reader.locator('.dsh-pdf-tool-rail').boundingBox(),
    ])
    expect(feedbackBox).not.toBeNull()
    expect(feedbackContentBox).not.toBeNull()
    expect(feedbackToolbarBox).not.toBeNull()
    // Save feedback stays in the command's fixed footprint, including while
    // the right sidebar changes width; it never adds a separate status bar.
    expect(feedbackControlsBox).not.toBeNull()
    expect(feedbackBox!.x).toBeGreaterThanOrEqual(feedbackToolbarBox!.x)
    expect(feedbackBox!.x + feedbackBox!.width).toBeLessThanOrEqual(feedbackToolbarBox!.x + feedbackToolbarBox!.width)
    expect(feedbackToolbarBox!.x + feedbackToolbarBox!.width)
      .toBeLessThanOrEqual(feedbackControlsBox!.x + feedbackControlsBox!.width)
    expect(feedbackBox!.y).toBeGreaterThanOrEqual(feedbackToolbarBox!.y)
    expect(feedbackBox!.y + feedbackBox!.height).toBeLessThanOrEqual(feedbackToolbarBox!.y + feedbackToolbarBox!.height)
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
    await openSidebarSection(reader, 'Annotations')
    await notePanel.locator('.dsh-pdf-comment-item').filter({ hasText: NOTE }).waitFor({ state: 'visible' })
    await expect.poll(() => notePanel.locator('.dsh-pdf-comment-item').getByText(NOTE, { exact: true }).count()).toBe(1)
    await expectIconOnlyMainToolbar(toolbar)

    // Sidebar width changes never remove the independent tool column's primary actions.
    const originalReaderWidth = await reader.evaluate(element => (element as HTMLElement).style.width)
    const originalContentSizing = await content.evaluate(element => {
      const style = (element as HTMLElement).style
      return { flex: style.flex, width: style.width }
    })
    const narrowMenuViewport = page.viewportSize()!
    await page.setViewportSize({ ...narrowMenuViewport, height: 600 })
    for (const paneWidth of [700, 400]) {
      await reader.evaluate((element, width) => { (element as HTMLElement).style.width = `${width}px` }, paneWidth)
      await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(paneWidth)
      await expectFloatingToolRails(reader)
      await expectIconOnlyMainToolbar(toolbar)
      const [zoomWidth, fileWidth] = await Promise.all([
        zoomControl.evaluate(element => element.getBoundingClientRect().width),
        toolbar.locator('.dsh-pdf-tools > summary').evaluate(element => element.getBoundingClientRect().width),
      ])
      expect(zoomWidth).toBeGreaterThanOrEqual(40)
      expect(Math.abs(zoomWidth - fileWidth)).toBeLessThanOrEqual(1)
      for (const name of ['Back', 'Undo PDF edit', 'Redo PDF edit', 'Save', 'Note', 'OCR page', 'Start explanation mode', 'Region screenshot'])
        expect(await toolbar.getByRole('button', { name, exact: true }).isVisible(), `${name} at ${paneWidth}px`).toBe(true)
      if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR)
        await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, `pdf-toolbar-${paneWidth}.png`) })
      await zoomControl.click()
      await zoomMenu.waitFor({ state: 'visible' })
      const popup = (await reader.locator('.dsh-pdf-zoom-menu').boundingBox())!
      const readerBox = (await reader.boundingBox())!, railBox = (await toolbar.boundingBox())!
      expect(popup.x).toBeGreaterThanOrEqual(railBox.x + railBox.width)
      expect(popup.x + popup.width).toBeLessThanOrEqual(readerBox.x + readerBox.width - 7)
      await zoomControl.click()
      await zoomMenu.waitFor({ state: 'hidden' })
      if (paneWidth === 400) {
        await toolbar.locator('.dsh-pdf-tools > summary').click()
        const menu = fileActions(reader)
        expect(await menu.getByRole('button', { name: 'Save as', exact: true }).isEnabled()).toBe(true)
        expect(await menu.getByRole('button', { name: 'Discard all changes', exact: true }).isEnabled()).toBe(true)
        for (const name of ['Back', 'Save', 'Note', 'OCR page', 'Start explanation mode', 'Region screenshot'])
          expect(await menu.getByRole('button', { name, exact: true }).count()).toBe(0)
        await menu.getByRole('button', { name: 'Save as', exact: true }).click()
        const saveAsDialog = reader.locator('.dsh-pdf-dialog')
        await saveAsDialog.getByRole('textbox', { name: 'PDF path' }).waitFor({ state: 'visible' })
        await saveAsDialog.getByRole('button', { name: 'Cancel' }).click()
        await saveAsDialog.waitFor({ state: 'hidden' })
        expect(await toolbar.locator('.dsh-pdf-toolbar-save').isEnabled()).toBe(true)
      }
    }
    await reader.evaluate((element, width) => { (element as HTMLElement).style.width = width }, originalReaderWidth)
    await page.setViewportSize(narrowMenuViewport)

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
    await save.evaluate(element => {
      const owner = window as typeof window & {
        __pdfSaveFeedbackStates?: { state: string | null; at: number }[]
        __pdfSaveFeedbackObserver?: MutationObserver
      }
      owner.__pdfSaveFeedbackStates = []
      const record = () => {
        owner.__pdfSaveFeedbackStates!.push({
          state: element.getAttribute('data-save-state'), at: performance.now(),
        })
      }
      owner.__pdfSaveFeedbackObserver = new MutationObserver(record)
      owner.__pdfSaveFeedbackObserver.observe(element, { attributes: true, attributeFilter: ['data-save-state'] })
    })
    await save.click()
    await expect.poll(() => page.evaluate(() => {
      const owner = window as typeof window & { __pdfSaveFeedbackStates?: { state: string | null }[] }
      return owner.__pdfSaveFeedbackStates?.some(value => value.state === 'saved-success') ?? false
    }), { timeout: 5000 }).toBe(true).catch(async failure => {
      const states = await page.evaluate(() => {
        const owner = window as typeof window & { __pdfSaveFeedbackStates?: { state: string | null }[] }
        return owner.__pdfSaveFeedbackStates
      })
      throw new Error(`${String(failure)}\nFeedback states: ${JSON.stringify(states)}\nReader ARIA:\n${await reader.ariaSnapshot()}\nPage errors:\n${tripwire.pageErrors.join('\n')}`)
    })
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(() => save.getAttribute('data-save-state'), { timeout: 5000 }).toBe('saved')
    expect(await saveDescription.textContent()).toBe('All changes saved')
    expect(await reader.locator('.dsh-pdf-save-feedback').count()).toBe(0)
    const feedbackStates = await page.evaluate(() => {
      const owner = window as typeof window & {
        __pdfSaveFeedbackStates?: { state: string | null; at: number }[]
        __pdfSaveFeedbackObserver?: MutationObserver
      }
      owner.__pdfSaveFeedbackObserver?.disconnect()
      const states = owner.__pdfSaveFeedbackStates ?? []
      delete owner.__pdfSaveFeedbackStates
      delete owner.__pdfSaveFeedbackObserver
      return states
    })
    const savedAt = feedbackStates.find(value => value.state === 'saved-success')?.at
    const hiddenAt = feedbackStates.find(value => savedAt !== undefined && value.at > savedAt && value.state === 'saved')?.at
    expect(savedAt).toBeDefined()
    expect(hiddenAt).toBeDefined()
    expect(hiddenAt! - savedAt!).toBeGreaterThanOrEqual(1900)
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
    const editedNoteFrame = await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().elementHandle()
    expect(editedNoteFrame).not.toBeNull()
    // Hold the same-resource refresh caused by Save. The old complete frame
    // and toolbar remain visible, so a single user click must wait for the
    // replacement display owner rather than disappear in the ownership gap.
    let releaseResourceOpen!: () => void
    const pendingResourceOpen = new Promise<void>(resolve => { releaseResourceOpen = resolve })
    let holdResourceOpen = true, heldResourceOpens = 0
    await page.route('**/api/pdf.dispatch.v2', async route => {
      if (holdResourceOpen && route.request().method() === 'POST' && route.request().postDataJSON()?.payload?.action === 'open') {
        heldResourceOpens++
        await pendingResourceOpen
      }
      try { await route.continue() } catch { /* A superseded resource open is cancelled. */ }
    })
    try {
      await save.click()
      await expect.poll(() => heldResourceOpens).toBeGreaterThan(0)
      const screenshotCommand = toolbar.getByRole('button', { name: 'Region screenshot', exact: true })
      expect(await screenshotCommand.isEnabled()).toBe(true)
      expect(await reader.locator('canvas[data-pdf-raster-ready="true"]').count()).toBeGreaterThan(0)
      await screenshotCommand.click()
      expect(await reader.locator('.dsh-pdf-mode-region').count()).toBe(0)
    } finally {
      holdResourceOpen = false
      releaseResourceOpen()
    }
    await expect.poll(() => save.isDisabled()).toBe(true)
    await expect.poll(() => savedNoteContents(path)).toEqual(['Edited standalone note'])
    // The disk write can precede Client acceptance and native replacement.
    // Entering a mode before that handoff would let the saved revision reset it.
    await expect.poll(() => save.getAttribute('data-save-state')).toMatch(/^saved(?:-success)?$/)
    await expect.poll(() => editedNoteFrame!.evaluate(canvas => canvas.isConnected)).toBe(false)
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible' })

    // Exercise the same cropped native render path used to prepare OCR images.
    const cropRequests: unknown[] = []
    page.on('request', request => {
      if (!request.url().endsWith('/api/pdf.native') || request.method() !== 'POST') return
      const body = request.postDataJSON()
      if (body.payload?.action === 'tile') cropRequests.push(body.payload.tile)
    })
    // The action stays discoverable, but this keyless fixture has no OCR-capable
    // session model, so the Host reports it unavailable.
    expect(await toolbar.getByRole('button', { name: 'OCR page' }).isDisabled()).toBe(true)
    // The click above completes after the replacement is published, without
    // requiring a second click. Keep exercising capture and all later actions.
    await reader.locator('.dsh-pdf-mode-region').first().waitFor({ state: 'visible' })
    await expect.poll(() => reader.locator('.dsh-pdf-mode-inline').getAttribute('aria-label')).toBe('Drag to capture an area')
    expect(await reader.locator('.dsh-pdf-notice').filter({ hasText: 'Drag to capture an area' }).count()).toBe(0)
    // Mode changes stay inside the tool column; allow page geometry to settle
    // before calculating where to begin the drag.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await textSpan.scrollIntoViewIfNeeded()
    // A line must be inside the reading viewport before a real pointer drag.
    const obscuredText = await textLineBox()
    const floatingBoxes = await reader.locator('.dsh-pdf-floating-status').evaluateAll(elements => elements
      .map(element => element.getBoundingClientRect()).map(box => ({ y: box.y, bottom: box.bottom })))
    const interactionSafeBottom = Math.max((await reader.locator('.dsh-pdf-scroll').boundingBox())!.y,
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
    await screenshotStatus.waitFor({ state: 'attached', timeout: 5_000 }).catch(async failure => {
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
    const widthBeforePinch = await firstPage.evaluate(element => element.offsetWidth)
    await firstPage.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      for (let index = 0; index < 24; index++) element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -7,
        clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
      }))
    })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    const firstPreview = await firstPage.boundingBox(), secondPreview = await secondPage.boundingBox()
    // Numeric stage previews may use separate transforms for mixed page sizes.
    // Assert the user-visible enlargement and deferred layout, rather than
    // requiring the superseded whole-track CSS transform implementation.
    expect(firstPreview!.width).toBeGreaterThan(widthBeforePinch)
    expect(await firstPage.evaluate(element => element.offsetWidth)).toBe(widthBeforePinch)
    expect(firstPreview && secondPreview && secondPreview.y - firstPreview.y - firstPreview.height).toBeGreaterThanOrEqual(0)
    await expect.poll(() => firstPage.evaluate(element => element.offsetWidth)).toBeGreaterThan(widthBeforePinch)
    await expect.poll(() => firstPage.evaluate(element => Math.abs(element.getBoundingClientRect().width - element.offsetWidth))).toBeLessThanOrEqual(1)
    const firstCommitted = await firstPage.boundingBox(), secondCommitted = await secondPage.boundingBox()
    expect(firstCommitted && secondCommitted && secondCommitted.y - firstCommitted.y - firstCommitted.height).toBeGreaterThanOrEqual(0)

    // The keyboard commands operate on the PDF draft, not an input. Deleting a
    // saved note can be undone, redone, and finally reverted by a confirmed
    // source reload without changing the on-disk PDF.
    await openSidebarSection(reader, 'Annotations')
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
    await (await documentAction(reader, 'Reload source')).click()
    const reloadDialog = reader.locator('.dsh-pdf-dialog').filter({ hasText: 'Reload the source PDF and discard' })
    await reloadDialog.waitFor({ state: 'visible' })
    await reloadDialog.getByRole('button', { name: 'Cancel' }).click()
    expect(await savedRow.count()).toBe(0)
    await (await documentAction(reader, 'Reload source')).click()
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
    await (await documentAction(reader, 'Discard all changes')).click()
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

it('auto-collapses the reading sidebar below 760px without reopening it when space returns', async () => {
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    const toggle = sidebar.getByRole('tab', { selected: true })
    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    const setReaderWidth = async (width: number) => {
      await reader.evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px` }, width)
      await expect.poll(() => reader.evaluate(element => element.clientWidth)).toBe(width)
      await reader.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    }
    const assertToolbarBesideSidebar = async () => {
      await expectFloatingToolRails(reader)
      await expectIconOnlyMainToolbar(toolbar)
    }
    const assertFeedbackInsideReadingColumn = async () => {
      const feedback = reader.locator('.dsh-pdf-activity-trigger')
      if (await feedback.getAttribute('aria-expanded') === 'false') await feedback.click()
      const [bar, notice, readerBox, popover] = await Promise.all([
        toolbar.boundingBox(), feedback.boundingBox(), reader.boundingBox(),
        reader.locator('.dsh-pdf-activity-popover').boundingBox(),
      ])
      expect(bar).not.toBeNull(); expect(notice).not.toBeNull(); expect(readerBox).not.toBeNull(); expect(popover).not.toBeNull()
      expect(notice!.x).toBeGreaterThanOrEqual(bar!.x)
      expect(notice!.x + notice!.width).toBeLessThanOrEqual(bar!.x + bar!.width)
      expect(notice!.y).toBeGreaterThanOrEqual(bar!.y)
      expect(notice!.y + notice!.height).toBeLessThanOrEqual(bar!.y + bar!.height)
      expect(popover!.x).toBeGreaterThanOrEqual(bar!.x + bar!.width)
      expect(popover!.x + popover!.width).toBeLessThanOrEqual(readerBox!.x + readerBox!.width - 7)
      expect(popover!.y).toBeGreaterThanOrEqual(readerBox!.y + 7)
      expect(popover!.y + popover!.height).toBeLessThanOrEqual(readerBox!.y + readerBox!.height - 7)
      await feedback.click()
    }

    // The host may initially mount a narrower tab; explicitly start this
    // scenario in a wide, expanded reader before crossing the threshold.
    await setReaderWidth(960)
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await assertToolbarBesideSidebar()
    await assertFeedbackInsideReadingColumn()
    await expectIconOnlyMainToolbar(toolbar)
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-main-toolbar-wide.png') })
    }
    await compareOrRefreshGolden(
      join(EXPECTED, 'opened-toolbar.expected.md'),
      await captureToolbarEditsAria(page, scaffold.workspaceCwd),
      webSnapshotMode(),
    )
    // Stepping a page locks navigation for a few hundred milliseconds. The
    // zoom must keep its appearance across that lock; the arrows legitimately
    // change state when moving from the first to the last page.
    {
      await openSidebarSection(reader, 'Pages')
      const nextPage = reader.locator('.dsh-pdf-sidebar-compact-nav button[aria-label="Next page"]')
      await nextPage.waitFor({ state: 'visible' })
      const sampled = await page.evaluate(async () => {
        const read = () => ({
          zoom: getComputedStyle(document.querySelector('.dsh-pdf-toolbar-zoom > summary')!).opacity,
          zoomTrigger: getComputedStyle(document.querySelector('.dsh-pdf-toolbar-zoom')!).opacity,
          next: getComputedStyle(document.querySelector('.dsh-pdf-sidebar-compact-nav button[aria-label="Next page"]')!).opacity,
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
          document.querySelector<HTMLButtonElement>('.dsh-pdf-sidebar-compact-nav button[aria-label="Next page"]')!.click()
          requestAnimationFrame(tick)
        })
      })
      expect(sampled).toEqual(['1|1|1', '1|1|0.35'])
      await openSidebarSection(reader, 'Pages')
    }
    // Exercise the dropdown/tooltip presentation in a genuinely short viewport.
    await page.setViewportSize({ ...page.viewportSize()!, height: 600 })
    const toolsControl = toolbar.locator('.dsh-pdf-tools > summary')
    const tooltip = page.getByRole('tooltip')
    expect(await toolbar.locator('.dsh-pdf-toolbar-disclosure').count()).toBe(2)
    expect(await toolsControl.locator('.dsh-pdf-toolbar-chevron').count()).toBe(1)
    expect(await toolbar.locator('.dsh-pdf-toolbar-zoom > summary .dsh-pdf-toolbar-chevron').count()).toBe(1)
    await page.mouse.move(0, 0)
    await toolsControl.hover()
    await tooltip.waitFor({ state: 'visible' })
    expect(await tooltip.innerText()).toBe('Document actions')
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: 'hidden' })
    const zoomControl = toolbar.locator('.dsh-pdf-toolbar-zoom > summary')
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
    expect(await disabledSave.getAttribute('data-save-state')).toBe('saved')
    await disabledSave.hover()
    await tooltip.waitFor({ state: 'visible' })
    expect(await tooltip.innerText()).toBe('All changes saved')
    expect(await toolbar.locator('.dsh-pdf-save-control [role="status"]').textContent()).toBe('All changes saved')
    await page.mouse.move(0, 0)
    await tooltip.waitFor({ state: 'hidden' })
    await toolsControl.locator('.dsh-pdf-toolbar-chevron').click()
    await fileActions(reader).first().waitFor({ state: 'visible' })
    await zoomControl.click()
    await fileActions(reader).waitFor({ state: 'hidden' })
    await reader.locator('.dsh-pdf-zoom-menu').waitFor({ state: 'visible' })
    await zoomControl.click()

    const pageField = sidebar.getByRole('textbox', { name: 'Page' })
    await pageField.focus()
    await setReaderWidth(700)
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    await pageField.evaluate(input => input.blur())
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await sidebar.getAttribute('class')).toContain('is-collapsed')
    await assertToolbarBesideSidebar()
    await expectIconOnlyMainToolbar(toolbar)
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-main-toolbar-narrow.png') })
    }
    await assertFeedbackInsideReadingColumn()

    // Growing the outer DSH pane must not turn a layout collapse into an
    // unsolicited sidebar opening, even when repeatedly crossing the threshold.
    for (const width of [960, 759, 760, 700, 960]) {
      await setReaderWidth(width)
      expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    }
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')

    await setReaderWidth(700)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await openSidebarSection(reader, 'Pages')
    await reader.getByRole('button', { name: 'Page 1 / 2' }).waitFor({ state: 'visible' })
    await assertToolbarBesideSidebar()

    // Even the narrowest reader keeps Save and the other primary actions in their own column.
    await setReaderWidth(280)
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    await assertToolbarBesideSidebar()
    await expectIconOnlyMainToolbar(toolbar)
    if (process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR) {
      await toolbar.screenshot({ path: join(process.env.DSH_PDF_TOOLBAR_PREVIEW_DIR, 'pdf-main-toolbar-cramped.png') })
    }
    await assertFeedbackInsideReadingColumn()
    expect(await toolbar.locator('.dsh-pdf-toolbar-save').isVisible()).toBe(true)
    await toolbar.locator('.dsh-pdf-tools > summary').click()
    expect(await fileActions(reader).getByRole('button', { name: 'Save', exact: true }).count()).toBe(0)
    await fileActions(reader).getByRole('button', { name: 'Save as', exact: true }).waitFor({ state: 'visible' })
    await toolbar.locator('.dsh-pdf-tools > summary').click()

    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    for (const width of [960, 700, 960]) {
      await setReaderWidth(width)
      expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    }
    await assertToolbarBesideSidebar()
    await assertFeedbackInsideReadingColumn()
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    expect(await reader.locator('.dsh-pdf-dialog').count()).toBe(0)
    expect(await save.isEnabled()).toBe(true)
    await page.evaluate(path => {
      (window as typeof window & { __pdfPickerNextPath?: string | null }).__pdfPickerNextPath = path
    }, copyPath)
    const sourceFrame = await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().elementHandle()
    expect(sourceFrame).not.toBeNull()
    await clickToolbarAction('Save as')
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
    const pickerDefaults = await page.evaluate(() =>
      (window as typeof window & { __pdfPickerDefaults?: string[] }).__pdfPickerDefaults)
    expect(pickerDefaults).toEqual([sourcePath.replace(/\.pdf$/i, '-annotated.pdf'), sourcePath.replace(/\.pdf$/i, '-annotated.pdf')])

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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await openSidebarSection(reader, 'Bookmarks')
    const pageInput = reader.locator('.dsh-pdf-sidebar').getByRole('textbox', { name: 'Page' })
    const scroll = reader.locator('.dsh-pdf-scroll')
    const zoom = reader.locator('.dsh-pdf-toolbar-zoom > summary')
    const vertical = reader.getByRole('button', { name: 'Fit vertical', exact: true })
    await expect.poll(() => vertical.isEnabled()).toBe(true)
    await vertical.click()
    await expect.poll(() => pageInput.inputValue()).toBe('2')
    await reader.locator('[data-pdf-page="2"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    // A retained raster can already be ready at the old fit-width scale.
    // Wait for the requested geometry and navigation lock, not that old frame.
    const expectedVerticalScale = await scroll.evaluate(element => Math.max(0.1, (element.clientHeight - 32) / 560))
    await expect.poll(async () => ({ idle: await pageInput.isEnabled(), scaleMatches:
      Math.abs(await reader.locator('[data-pdf-page="2"]').evaluate(element => element.getBoundingClientRect().height / 560)
        - expectedVerticalScale) < 0.03 })).toEqual({ idle: true, scaleMatches: true })
    expect(await zoom.getAttribute('aria-label')).toBe(`Zoom: ${Math.round(expectedVerticalScale * 100)}%`)

    const rectangle = reader.getByRole('button', { name: 'Fit rectangle', exact: true })
    await expect.poll(() => rectangle.isEnabled()).toBe(true)
    await rectangle.click()
    await expect.poll(() => pageInput.inputValue()).toBe('3')
    await reader.locator('[data-pdf-page="3"] canvas[data-pdf-raster-ready="true"]').first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    const expectedRectangleScale = await scroll.evaluate(element => {
      const style = getComputedStyle(element)
      return Math.max(0.1, Math.min((element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / 300,
        (element.clientHeight - 32) / 310))
    })
    await expect.poll(async () => ({ idle: await pageInput.isEnabled(), scaleMatches:
      Math.abs(await reader.locator('[data-pdf-page="3"]').evaluate(element => element.getBoundingClientRect().height / 560)
        - expectedRectangleScale) < 0.03 })).toEqual({ idle: true, scaleMatches: true })
    expect(await zoom.getAttribute('aria-label')).toBe(`Zoom: ${Math.round(expectedRectangleScale * 100)}%`)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('navigates from the whole built-in bookmark item without hijacking item actions', async () => {
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await openSidebarSection(reader, 'Bookmarks')
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
      const style = getComputedStyle(root)
      const width = root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      return page ? Math.abs(page.getBoundingClientRect().height - width * 560 / 400) : Infinity
    })).toBeLessThan(2)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    // Establish the document start through the same page field a user uses;
    // opening the sidebar may otherwise leave a preserved, nonzero anchor.
    await sidebarPage.fill('1')
    await sidebarPage.press('Enter')
    await expect.poll(() => sidebarPage.isEnabled()).toBe(true)
    await expect.poll(scrollTop).toBeLessThan(2)
    const originScrollTop = await scrollTop()
    const atOrigin = async () => Math.abs(await scrollTop() - originScrollTop)

    const chapter = reader.locator('.dsh-pdf-bookmark-row').filter({ hasText: 'Chapter 1' }).first()
    await expect.poll(() => chapter.getByRole('button', { name: 'Chapter 1', exact: true }).isEnabled()).toBe(true)
    await expect.poll(() => chapter.evaluate(row => {
      const bounds = row.getBoundingClientRect()
      return row.contains(document.elementFromPoint(bounds.x + 8, bounds.y + bounds.height / 2))
    })).toBe(true)
    const chapterBox = await chapter.boundingBox()
    expect(chapterBox).not.toBeNull()
    // Click the row's own padding, not its independent reorder/expand controls.
    await page.mouse.click(chapterBox!.x + 8, chapterBox!.y + 2)
    // The rail and sidebar determine the fit-width scale. Validate the actual
    // PDF destination, including the browser's document-end clamp, rather than
    // assuming its scroll distance is always more than 200 CSS pixels.
    await expect.poll(() => scroll.evaluate(root => {
      const target = root.querySelector<HTMLElement>('[data-page-number="2"]')!
      const page = target.querySelector<HTMLElement>('[data-pdf-page="2"]')!
      const destination = target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
        + 70 * page.getBoundingClientRect().height / 560 - 16
      const expected = Math.max(0, Math.min(root.scrollHeight - root.clientHeight, destination))
      return Math.abs(root.scrollTop - expected)
    }), { timeout: 20_000 }).toBeLessThan(2)
    await expect.poll(() => sidebarPage.inputValue()).toBe('2')
    await reader.getByRole('button', { name: 'Back', exact: true }).click()
    await expect.poll(atOrigin).toBeLessThan(2)
    await expect.poll(() => sidebarPage.inputValue()).toBe('1')
    await chapter.getByRole('button', { name: 'Expand bookmark section' }).click()
    await reader.getByRole('treeitem', { name: 'Section 1' }).waitFor({ state: 'visible' })
    expect(await atOrigin()).toBeLessThan(2)

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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await openSidebarSection(reader, 'Annotations')
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await openSidebarSection(reader, 'Annotations')
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await openSidebarSection(reader, 'Annotations')
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF scrolled annotation test' }).click()
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: LONG_ANNOTATION_FILE_NAME, exact: true }).click()

    const reader = page.locator('.dsh-pdf-reader')
    await reader.waitFor({ state: 'visible', timeout: 20_000 })
    await openSidebarSection(reader, 'Annotations')
    const scroll = reader.locator('.dsh-pdf-scroll')
    const input = reader.locator('.dsh-pdf-sidebar').getByRole('textbox', { name: 'Page' })
    await reader.locator('.dsh-pdf-windowed-pages').waitFor({ state: 'attached', timeout: 20_000 })
    // A mounted virtual-page container may still use Reader's initial 600px
    // estimate. Scroll only after ResizeObserver has committed Fit width for
    // the actual viewport; otherwise its total height can change mid-scroll
    // and the requested distant page never enters the rendered window.
    await expect.poll(() => scroll.evaluate(root => {
      const stage = root.querySelector<HTMLElement>('[data-page-number="1"] .dsh-pdf-page-stage')
      const style = getComputedStyle(root)
      return stage ? Math.abs(stage.getBoundingClientRect().width
        - (root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))) : Infinity
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
  let browser: Browser | undefined
  try {
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.name === '@dylanl1/dsh-plugin-pdf')
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    await openSidebarSection(reader, 'Pages')
    await expect.poll(() => sidebar.getByRole('tab', { selected: true }).getAttribute('aria-expanded')).toBe('true')
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
    const historyMenu = reader.getByTestId('pdf-back-history')
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
    const originalSizing = await reader.getAttribute('style')
    try {
      await reader.evaluate(element => { (element as HTMLElement).style.width = '320px' })
      await expectFloatingToolRails(reader)
      const directBack = toolbar.locator('.dsh-pdf-toolbar-back-split').getByRole('button', { name: 'Back', exact: true })
      expect(await directBack.isVisible()).toBe(true)
      await directBack.click()
    } finally {
      await reader.evaluate((element, style) => {
        if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style)
      }, originalSizing)
    }
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
    await sidebar.getByRole('tab', { selected: true }).click()
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
    await sidebar.getByRole('tab', { selected: true }).click()
    await openSidebarSection(reader, 'Search')
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
    await openSidebarSection(reader, 'Pages')
    await pageInput.fill('81')
    await pageInput.press('Enter')
    await reader.locator('.dsh-pdf-windowed-pages > [data-page-number="81"]').waitFor({ state: 'attached', timeout: 20_000 })
    await expect.poll(() => pageInput.getAttribute('title')).toBe(`81 / ${LARGE_PAGE_COUNT}`)
    // The title updates as soon as page 81 becomes current, while the jump
    // still disables the input until navigation has fully settled.
    await expect.poll(() => pageInput.isEnabled()).toBe(true)
    await pageInput.focus()
    expect(await pageInput.evaluate(input => input === document.activeElement)).toBe(true)
    await reader.locator('.dsh-pdf-scroll').evaluate(scroll => {
      const source = scroll.querySelector<HTMLElement>('.dsh-pdf-windowed-pages > [data-page-number="81"]')
      if (!source) throw new Error('Page 81 is not mounted')
      // offsetHeight rounds each page to integer CSS pixels. Multiplying that
      // rounded value by 57 pages can land on the preceding page; DOMRects
      // retain the same fractional geometry used by the windowed layout.
      const bounds = source.getBoundingClientRect()
      scroll.scrollTop = bounds.top - scroll.getBoundingClientRect().top + scroll.scrollTop
        - (81 - 24) * bounds.height
      scroll.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => pageInput.getAttribute('title'), { timeout: 20_000 }).toBe(`24 / ${LARGE_PAGE_COUNT}`)
    await expect.poll(() => pageInput.inputValue()).toBe('24')
    await expect.poll(() => reader.getByRole('button', { name: `Page 24 / ${LARGE_PAGE_COUNT}` }).getAttribute('aria-current'))
      .toBe('page')

    // A real wheel event must also release a prior explicit destination while
    // leaving the committed page-number field focused and synchronized.
    const pageStride = await reader.locator('.dsh-pdf-windowed-pages > [data-page-number="24"]')
      .evaluate(element => element.getBoundingClientRect().height)
    await reader.locator('.dsh-pdf-scroll').hover()
    await page.mouse.wheel(0, pageStride * 2)
    await expect.poll(() => pageInput.inputValue()).toBe('26')
    await page.mouse.wheel(0, -pageStride * 2)
    await expect.poll(() => pageInput.inputValue()).toBe('24')

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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    expectUnannotatedPage(await screenshotPagePixels(page))
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
    const note = toolbar.getByRole('button', { name: 'Note', exact: true })
    await note.click()
    await expect.poll(() => note.getAttribute('aria-pressed')).toBe('true')
    await reader.locator('[data-pdf-page="1"].dsh-pdf-mode-note').click({ position: { x: 185, y: 90 } })
    const commentCard = reader.locator('.dsh-pdf-page-comment-card')
    await commentCard.getByRole('textbox', { name: 'Note' }).fill('Point-anchored note')
    await commentCard.getByRole('button', { name: 'Save note', exact: true }).click()
    // Applying the note crosses an RPC and a subsequent Client render. Give
    // the observable list the same bounded budget as other PDF mutations.
    await expect.poll(() => annotations.locator('.dsh-pdf-comment-item').count(), { timeout: 20_000 }).toBe(2)
    const noteToolbar = reader.getByRole('toolbar', { name: 'Selected annotation' })
    await expect.poll(() => noteToolbar.count()).toBe(0)
    const noteCard = reader.locator('.dsh-pdf-page-comment-card[data-card-kind="note"]')
    await noteCard.getByRole('button', { name: 'Change note color' }).click()
    // The color menu shares the Reader's overlay portal with other tool menus.
    const noteColors = reader.getByTestId('pdf-note-colors')
    await noteColors.waitFor({ state: 'visible' })
    expect(await noteColors.locator('.dsh-pdf-highlight-swatch').count()).toBe(5)
    await noteColors.locator('[data-testid="pdf-highlight-swatch-1"]').click()
    await expect.poll(() => noteCard.evaluate(element => (element as HTMLElement).style.getPropertyValue('--pdf-note-tint')))
      .toBe('#ff9f0a')
    const closeNote = noteCard.getByRole('button', { name: 'Close note', exact: true })
    await closeNote.click()
    const noteMarker = reader.locator('[data-pdf-note-id]')
    await expect.poll(() => noteMarker.count()).toBe(1)
    const markerBefore = await noteMarker.boundingBox()
    expect(markerBefore).not.toBeNull()
    // A region containing the visible note marker must contain only the PDF
    // page pixels, not the Reader marker or the native note appearance.
    await toolbar.getByRole('button', { name: 'Region screenshot', exact: true }).click()
    const noteCenter = { x: markerBefore!.x + markerBefore!.width / 2,
      y: markerBefore!.y + markerBefore!.height / 2 }
    await page.mouse.move(noteCenter.x - 28, noteCenter.y - 28)
    await page.mouse.down()
    await page.mouse.move(noteCenter.x + 28, noteCenter.y + 28, { steps: 8 })
    await page.mouse.up()
    const barePreview = reader.getByRole('dialog', { name: 'Screenshot preview' })
    await barePreview.waitFor({ state: 'visible' })
    const yellowPixels = await barePreview.getByRole('img').evaluate(async element => {
      const image = element as HTMLImageElement
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let yellow = 0
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > 225 && pixels[index + 1] > 185 && pixels[index + 2] < 155) yellow++
      }
      canvas.width = 0; canvas.height = 0
      return yellow
    })
    expect(yellowPixels).toBe(0)
    await barePreview.getByRole('button', { name: 'Close', exact: true }).click()
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
    for (const [index, corner] of [{ x: right, y: bottom }, { x: pageBox!.x + 13, y: top }].entries()) {
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
      if (index === 1) {
        const resize = noteCard.getByRole('button', { name: /Resize note/ })
        const grip = await resize.boundingBox()
        expect(grip).not.toBeNull()
        await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2)
        await page.mouse.down()
        await page.mouse.move(grip!.x + grip!.width / 2 + 48, grip!.y + grip!.height / 2 + 32, { steps: 6 })
        await page.mouse.up()
        await expect.poll(async () => (await noteCard.boundingBox())?.width ?? 0).toBeGreaterThan(cardBox!.width + 20)
        const enlarged = await noteCard.boundingBox()
        expect(enlarged!.height).toBeGreaterThan(cardBox!.height + 12)
        await noteCard.getByRole('button', { name: 'Close note', exact: true }).click()
        await noteMarker.click()
        const reopened = await noteCard.boundingBox()
        expect(reopened!.width).toBeCloseTo(enlarged!.width, 0)
        expect(reopened!.height).toBeCloseTo(enlarged!.height, 0)
      }
      await noteCard.getByRole('button', { name: 'Close note', exact: true }).click()
      await expect.poll(() => noteMarker.count()).toBe(1)
    }
    await openSidebarSection(reader, 'Annotations')
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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
    // Menus live in the Reader overlay layer, outside the text-action toolbar.
    const selectionColors = reader.getByTestId('pdf-selection-highlight-colors')
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
      await captureToolbarEditsAria(page, scaffold.workspaceCwd),
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
    const sidebarToggle = reader.getByRole('tab', { selected: true })
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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

    // A disk write precedes the Client accepting its saved revision. Wait for
    // that handoff before entering Note mode: accepting a revision resets modes.
    await expect.poll(() => save.getAttribute('data-save-state')).toMatch(/^saved(?:-success)?$/)
    const mainToolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    await expect.poll(() => mainToolbar.getAttribute('aria-busy')).not.toBe('true')
    // Placing a free note should open the annotation editor ready for typing.
    const note = mainToolbar.getByRole('button', { name: 'Note', exact: true })
    await note.click()
    await expect.poll(() => note.getAttribute('aria-pressed')).toBe('true')
    const notePage = reader.locator('[data-pdf-page="1"].dsh-pdf-mode-note')
    await notePage.waitFor({ state: 'visible' })
    await notePage.scrollIntoViewIfNeeded()
    const placement = { x: 180, y: 90 }
    expect(await notePage.evaluate((element, point) => {
      const box = element.getBoundingClientRect()
      return document.elementFromPoint(box.left + point.x, box.top + point.y)?.closest('[data-pdf-page]') === element
    }, placement), 'the placement point must hit the visible PDF page, not a toolbar or sidebar').toBe(true)
    await notePage.click({ position: placement })
    const noteEditor = reader.locator('.dsh-pdf-page-comment-card').getByRole('textbox', { name: 'Note' })
    await expect.poll(() => noteEditor.evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.type('Free note starts here')
    await expect.poll(() => noteEditor.inputValue()).toBe('Free note starts here')
    await reader.locator('.dsh-pdf-page-comment-card').getByRole('button', { name: 'Save note', exact: true }).click()
    await expect.poll(() => save.getAttribute('data-save-state')).toBe('dirty')
    await reader.locator('.dsh-pdf-page-comment-card').getByRole('button', { name: 'Close note', exact: true }).click()
    await expect.poll(() => reader.locator('[data-pdf-page="1"] [data-pdf-note-id]').count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 180_000)

it('gives underline and strike-out the same color bar as a highlight', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
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

it('keeps the same PDF point and painted pixels through wheel zoom commits, centering clamps and mixed page sizes', async () => {
  const bundle = await build({ entryPoints: [join(ROOT, 'tests/modules/viewer/wheel-zoom-handoff.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') } })
  const css = (await Promise.all(['reader.css', 'windowed-pages.css'].map(file => readFile(join(ROOT, 'src/client', file), 'utf8')))).join('\n')
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    onTestFailed(() => saveFailureShot(page, 'pdf-wheel-zoom-handoff'))
    await page.setContent(`<style>html,body{margin:0}#zoom-handoff-root{width:900px;height:600px}${css}</style><div id="zoom-handoff-root"></div>`)
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    for (const scenario of zoomHandoffScenarios) {
      const result = await page.evaluate(recordWheelZoomHandoff, scenario)
      if (process.env.DSH_PDF_ZOOM_TRACE_DIR) {
        await mkdir(process.env.DSH_PDF_ZOOM_TRACE_DIR, { recursive: true })
        await writeFile(join(process.env.DSH_PDF_ZOOM_TRACE_DIR, `${scenario.name.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`), JSON.stringify(result, null, 2))
      }
      console.info(`PDF wheel handoff: ${JSON.stringify({ name: result.name, maxHandoffX: result.maxHandoffX,
        maxHandoffY: result.maxHandoffY, missingFrames: result.missingFrames, missingPageFrames: result.missingPageFrames })}`)
      expect(result.errors, scenario.name).toEqual([])
      expect(result.missingPageFrames, scenario.name).toBe(0)
      expect(result.samples.every(sample => sample.sameElement), `${scenario.name}: keep the page and its painted fallback mounted`).toBe(true)
      expect(result.maxHandoffX, `${scenario.name}: no horizontal snap after the last gesture frame`).toBeLessThanOrEqual(1)
      expect(result.maxHandoffY, `${scenario.name}: no vertical snap after the last gesture frame`).toBeLessThanOrEqual(1)
      expect(result.missingFrames, `${scenario.name}: previously painted pixels remain covered, not merely a canvas element`).toBe(0)
      expect(result.samples.some(sample => sample.testedPixels > 1), `${scenario.name}: sample more than one real raster pixel`).toBe(true)
    }
    expect(errors).toEqual([])
  } finally { await browser.close() }
}, 40_000)

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
    await page.locator('style[data-dsh-plugin="@dylanl1/dsh-plugin-pdf"]').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByRole('treeitem').filter({ hasText: 'PDF zoom frame test' }).click()
    const column = page.locator('[data-rightbar-col]')
    if (await page.locator('[data-sidebar-right-expand]').isVisible()) await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: FILE_NAME, exact: true }).click()
    const reader = page.locator('.dsh-pdf-reader')
    const surface = reader.locator('[data-pdf-page="1"] .dsh-pdf-tile-surface')
    // Establish a fixed-scale frame before taking the baseline: the initial
    // Fit-width frame can still be replaced as the Files column opens.
    await chooseZoom(reader, '100%')
    await surface.locator('canvas[data-pdf-raster-ready="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch'), { timeout: 20_000 }).not.toBeNull()
    await expect.poll(() => reader.locator('[data-pdf-page="1"] .dsh-pdf-text-layer span').count()).toBeGreaterThan(0)
    await expect.poll(() => surface.evaluate(host => {
      const ready = (host as HTMLElement).dataset.pdfReadyEpoch
      const canvases = [...host.querySelectorAll<HTMLCanvasElement>('canvas[data-pdf-raster-ready="true"]')]
      return host.getBoundingClientRect().width === 400 && canvases.length > 0 && canvases.every(canvas =>
        canvas.dataset.tileEpoch === ready && Number(canvas.dataset.pdfRasterScale) === window.devicePixelRatio
          && canvas.width > 0 && canvas.height > 0)
    }), { timeout: 20_000 }).toBe(true)
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

    // Fixed zoom keeps its logical page size. Fit-width follows the safe reading
    // gutters while the full-width canvas remains underneath the floating panel.
    await chooseZoom(reader, '100%')
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch')).not.toBe(finalEpoch)
    const sidebar = reader.locator('.dsh-pdf-sidebar')
    const sidebarToggle = sidebar.getByRole('tab', { selected: true })
    const fixedWidth = (await surface.boundingBox())!.width
    await sidebarToggle.click()
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    expect(Math.abs((await surface.boundingBox())!.width - fixedWidth)).toBeLessThanOrEqual(1)
    const fixedEpoch = await surface.getAttribute('data-pdf-ready-epoch')
    await chooseZoom(reader, 'Fit width')
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch'), { timeout: 20_000 }).not.toBe(fixedEpoch)
    await expect.poll(async () => Math.abs((await surface.boundingBox())!.width - fixedWidth)).toBeGreaterThan(1)
    const fitWidth = (await surface.boundingBox())!.width
    const fitEpoch = await surface.getAttribute('data-pdf-ready-epoch')
    const pageBeforeToggle = await reader.getByRole('textbox', { name: 'Page', exact: true }).inputValue()
    await sidebarToggle.click()
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    await expect.poll(async () => Math.abs((await surface.boundingBox())!.width - fitWidth)).toBeGreaterThan(10)
    expect(await reader.getByRole('textbox', { name: 'Page', exact: true }).inputValue()).toBe(pageBeforeToggle)
    await expect.poll(() => surface.getAttribute('data-pdf-ready-epoch'), { timeout: 20_000 }).not.toBe(fitEpoch)
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
