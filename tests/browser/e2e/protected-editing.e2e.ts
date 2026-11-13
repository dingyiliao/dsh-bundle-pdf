import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFailed } from 'vitest'
import { type Browser, type Locator } from 'playwright'
import { launchPdfBrowser } from '../launch.ts'
import { FILE_NAME, openReader } from '../support/panels.ts'
import { launchWebScaffold, newEnglishPage, ROOT, saveFailureShot, seedSession, SESSION, watchConsole } from '../support/scaffold.ts'
import { documentAction } from '../support/toolbar.ts'

async function withProtectedReader(fixture: string, testName: string, verify: (reader: Locator, cwd: string, source: Buffer) => Promise<void>) {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] } })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), testName)
    await workspace.attachSession(sessionId)
    const title = 'Encrypted annotation test'
    await scaffold.ctx.sessionController.rename({ sessionId, title })
    const source = await readFile(new URL(`../../fixtures/${fixture}.pdf`, import.meta.url))
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), source)
    browser = await launchPdfBrowser()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, testName))
    const reader = await openReader(page, scaffold.authenticatedUrl, title)
    await verify(reader, scaffold.workspaceCwd, source)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}

const tool = (reader: Locator, name: string) => reader.getByRole('toolbar', { name: 'PDF reading and editing' })
  .getByRole('button', { name, exact: true })

async function writeNote(reader: Locator, value: string) {
  const note = tool(reader, 'Note')
  await note.click()
  await expect.poll(() => note.getAttribute('aria-pressed')).toBe('true')
  await reader.locator('[data-pdf-page="1"].dsh-pdf-mode-note').click({ position: { x: 120, y: 140 } })
  const card = reader.locator('.dsh-pdf-page-comment-card')
  await card.getByRole('textbox', { name: 'Note' }).fill(value)
  await card.getByRole('button', { name: 'Save note', exact: true }).click()
  await card.getByText(value, { exact: true }).waitFor()
}

it('directly edits an encrypted PDF with annotation permission and saves an encrypted copy', async () => {
  await withProtectedReader('encrypted-object-stream', 'pdf-encrypted-save-as', async (reader, cwd, source) => {
    const noteText = 'Encrypted note — 浏览器验证'
    const commentText = 'Updated encrypted highlight comment'
    expect(await tool(reader, 'Note').isEnabled()).toBe(true)
    expect(await tool(reader, 'OCR page').isDisabled()).toBe(true)
    expect(await tool(reader, 'Region screenshot').isDisabled()).toBe(true)
    expect(await reader.getByRole('form', { name: 'Unlock PDF' }).count()).toBe(0)
    expect(await reader.getByRole('button', { name: 'Unlock annotation editing' }).count()).toBe(0)
    const commentMarker = reader.locator('[data-pdf-page="1"] .dsh-pdf-comment-marker')
    const card = reader.locator('.dsh-pdf-page-comment-card')
    await commentMarker.click()
    await card.getByText('Fixture annotation', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: 'Add comment', exact: true }).count()).toBe(0)
    await card.getByRole('button', { name: /^Edit comment:/ }).click()
    await card.getByRole('textbox', { name: 'Comment' }).fill(commentText)
    await card.getByRole('button', { name: 'Save comment', exact: true }).click()
    await card.getByText(commentText, { exact: true }).waitFor()
    await writeNote(reader, noteText)
    expect(await tool(reader, 'Save').isDisabled()).toBe(true)
    await (await documentAction(reader, 'Save as')).click()
    const dialog = reader.getByRole('dialog', { name: 'Save a PDF copy', exact: true })
    const name = dialog.getByRole('textbox', { name: 'File name', exact: true })
    const submit = dialog.getByRole('button', { name: 'Save copy', exact: true })
    await name.fill(FILE_NAME)
    await dialog.getByText('Use Save as to keep the original PDF and save an encrypted copy.', { exact: true }).waitFor()
    expect(await submit.isDisabled()).toBe(true)
    const target = 'protected-browser-copy.pdf'
    await name.fill(target)
    await dialog.getByText('A new PDF file will be created.', { exact: true }).waitFor()
    await submit.click()
    await reader.page().getByRole('tab', { selected: true }).filter({ hasText: target }).waitFor()
    await reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first().waitFor()
    const saved = await readFile(join(cwd, target))
    expect(saved.includes(Buffer.from('/Encrypt'))).toBe(true)
    expect(saved.includes(Buffer.from(noteText))).toBe(false)
    expect(await readFile(join(cwd, FILE_NAME))).toEqual(source)
    const marker = reader.locator('.dsh-pdf-note-marker')
    await marker.click()
    await card.getByText(noteText, { exact: true }).waitFor()
    await card.getByRole('button', { name: 'Close note', exact: true }).click()
    await commentMarker.click()
    await card.getByText(commentText, { exact: true }).waitFor()
    expect(await tool(reader, 'Note').isEnabled()).toBe(true)
  })
}, 120_000)

it('keeps a restricted encrypted PDF visible through failed and successful owner-password entry', async () => {
  await withProtectedReader('encrypted-annotation-restricted', 'pdf-encrypted-owner-password', async reader => {
    const note = tool(reader, 'Note')
    const unlock = reader.getByRole('button', { name: 'Unlock annotation editing', exact: true })
    const canvas = reader.locator('[data-pdf-page="1"] canvas[data-pdf-raster-ready="true"]').first()
    expect(await note.isDisabled()).toBe(true)
    await unlock.click()
    const prompt = reader.getByRole('form', { name: 'Unlock annotation editing' })
    const password = prompt.getByLabel('Owner password')
    await password.fill('incorrect-fixture-password')
    await prompt.getByRole('button', { name: 'Unlock annotation editing', exact: true }).click()
    await prompt.getByRole('alert').getByText('This password did not unlock annotation editing.', { exact: false }).waitFor()
    expect(await password.inputValue()).toBe('')
    expect(await canvas.isVisible()).toBe(true)
    expect(await note.isDisabled()).toBe(true)
    await prompt.getByRole('button', { name: 'Cancel', exact: true }).click()
    await prompt.waitFor({ state: 'detached' })
    await unlock.click()
    await password.fill('fixture-owner')
    await prompt.getByRole('button', { name: 'Unlock annotation editing', exact: true }).click()
    await prompt.waitFor({ state: 'detached' })
    expect(await canvas.isVisible()).toBe(true)
    expect(await note.isEnabled()).toBe(true)
    await writeNote(reader, 'Owner-authorized note')
  })
}, 120_000)
