import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, expandOwningTurnProcess, newEnglishPage, saveFailureShot, ROOT, SESSION, executeScaffoldTool } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { joinPageText } from '../../../src/shared/page-text.ts'
import { readPagePresentationMeta } from '../../../src/adapters/host/dsh/pdf-evidence-meta.ts'
import { evidenceSha256 } from '../../../src/modules/evidence/index.ts'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { plainPdf } from '../../fixtures/plain-pdf.ts'
import { sourcePdf } from '../support/documents.ts'
import { chooseZoom } from '../support/toolbar.ts'

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
    const line = (text: string, y: number) => ({ text, x: 50, y, size: 15 })
    // A following page keeps both targets away from the document-end scroll clamp.
    await writeFile(path, plainPdf([
      { size: [400, 1400], lines: [line('Origin reading position', 1300)] },
      { size: [400, 1400], lines: [line('Repeated evidence', 1100), line('Different surrounding context', 800), line('Repeated evidence', 500)] },
      { size: [400, 1400], lines: [line('Following page', 1300)] },
    ]))
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
