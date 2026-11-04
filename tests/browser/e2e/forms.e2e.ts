import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession, newEnglishPage, DSH_ROOT, ROOT, SESSION, executeScaffoldTool } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brokenTextMappingFixture } from '../../fixtures/broken-text-mapping.ts'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { PDFCheckBox, PDFDocument } from 'pdf-lib'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { documentAction } from '../support/toolbar.ts'

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
