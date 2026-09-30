/** Keyless browser proof through the shipped Web profile, Loader and PDF workspace file. */
import { existsSync, realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib'
import { chromium } from 'playwright'
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
const NOTE = 'Saved through the PDF reader browser UI'

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

    browser = await chromium.launch(
      process.platform === 'win32' && !existsSync(chromium.executablePath()) ? { channel: 'msedge' } : {},
    )
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
    await reader.locator('[data-pdf-page="1"] canvas').waitFor({ state: 'visible', timeout: 10_000 }).catch(async failure => {
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
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(EXPECTED, [
      'opened-toolbar.expected.md', 'dirty-toolbar.expected.md', 'saved-note.expected.md',
    ])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
