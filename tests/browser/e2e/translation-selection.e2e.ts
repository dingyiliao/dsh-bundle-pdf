import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, newEnglishPage, openSettings, MODEL_FIXTURE, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type DshTranslationLlm } from '../../../src/adapters/host/dsh/translation-model.ts'
import { launchPdfBrowser as browser } from '../launch.ts'
import { FILE_NAME, documentBytes, openReader } from '../support/panels.ts'

it('shows a real selected-word translation and handles screenshot preview copy and cancellation', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: ROOT, enabled: true }] },
    replayFixture: MODEL_FIXTURE, replayProvidersOnly: true })
  let opened: Browser | undefined
  let response: string = JSON.stringify({ kind: 'word', pronunciation: '/ˈkʌvərɪdʒ/', meanings: [
    { partOfSpeech: 'noun', meaning: 'scope', example: 'Coverage is broad.', exampleTranslation: '覆盖范围很广。' },
  ] })
  let responseGate: Promise<void> | undefined
  let releaseResponse = () => {}
  let pendingResponseSignal: AbortSignal | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION, 'utf8'), 'pdf-panel-translation-e2e')
    await workspace.attachSession(sessionId)
    const title = 'PDF panel translation test'
    await scaffold.ctx.sessionController.rename({ sessionId, title })
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), await documentBytes())
    await scaffold.ctx.sessionController.selectModel({ sessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    const llm = scaffold.ctx.get('llm') as DshTranslationLlm | undefined
    if (!llm) throw new Error('The Web profile has no model runtime')
    llm.stream = async function* (options) {
      if (responseGate) {
        pendingResponseSignal = options.signal
        await responseGate
        options.signal.throwIfAborted()
      }
      yield { type: 'text-delta', index: 0, text: response }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    opened = await browser()
    const page = await newEnglishPage(opened)
    const tripwire = watchConsole(page)
    const reader = await openReader(page, scaffold.authenticatedUrl, title)
    // This workflow controls llm.stream for both translation and region OCR.
    // Explicitly choose that backend; the shipped default is local Tesseract.
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'PDF', exact: true }).click()
    await settings.getByRole('combobox', { name: 'OCR engine', exact: true }).selectOption('session-llm')
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'pdf-reader')?.value)
      .toMatchObject({ ocrEngine: 'session-llm' })
    await page.keyboard.press('Escape')
    await expect.poll(() => reader.locator('[data-pdf-text="active"]').allTextContents()).toContain('Coverage page 1')
    await reader.evaluate(element => {
      const glyphs = [...element.querySelectorAll<HTMLElement>('[data-pdf-page="1"] span[data-pdf-run]')]
      const word = glyphs.slice(0, 8)
      if (word.map(item => item.textContent).join('') !== 'Coverage') throw new Error('Unexpected PDF text layer')
      const range = document.createRange()
      range.setStart(word[0]!.firstChild!, 0)
      range.setEnd(word.at(-1)!.firstChild!, 1)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      element.querySelector<HTMLElement>('.dsh-pdf-scroll')!.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
    })
    const selected = reader.getByRole('toolbar', { name: 'Selected text actions' })
    await selected.waitFor({ state: 'visible' })
    await selected.getByRole('button', { name: 'Translate', exact: true }).click()
    const panel = reader.locator('.dsh-pdf-translation-panel')
    await panel.waitFor({ state: 'visible' })
    await expect.poll(() => panel.locator('.dsh-pdf-translation-details').count()).toBe(1)
    expect(await panel.innerText()).toContain('Coverage is broad.')
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => { (window as typeof window & { __copiedTranslation?: string }).__copiedTranslation = text },
      } })
    })
    await panel.locator('.dsh-pdf-translation-result-header > button').first().click()
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __copiedTranslation?: string }).__copiedTranslation))
      .toContain('Coverage is broad.')
    await expect.poll(() => panel.locator('.dsh-pdf-translation-status').innerText()).toContain('copied')
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('clipboard denied') } },
    }))
    const resultHeader = panel.locator('.dsh-pdf-translation-result-header')
    const assertHeaderLayout = async () => {
      await expect.poll(() => resultHeader.evaluate(root => {
        const language = root.querySelector<HTMLElement>('.dsh-pdf-translation-language-trigger')!
        const button = root.querySelector<HTMLElement>(':scope > button')!
        return language.getBoundingClientRect().right <= button.getBoundingClientRect().left
          || language.getBoundingClientRect().bottom <= button.getBoundingClientRect().top
      })).toBe(true)
      expect(await resultHeader.evaluate(root => {
        const bounds = root.getBoundingClientRect()
        const copy = root.querySelector<HTMLElement>(':scope > button')!.getBoundingClientRect()
        if (Math.abs(copy.right - bounds.right) > 1) return false
        return [...root.querySelectorAll<HTMLElement>('h4, summary, :scope > button')].every(control => {
          const box = control.getBoundingClientRect()
          return box.left >= bounds.left && box.right <= bounds.right
        })
      })).toBe(true)
    }
    await assertHeaderLayout()
    // The longer copied label must coexist with a readable language selector
    // at narrow widths, independently of the platform's default font metrics.
    const headerStyle = await resultHeader.getAttribute('style')
    try {
      for (const fontFamily of ['Arial', 'monospace']) for (const width of [180, 210]) {
        await resultHeader.evaluate((element, style) => {
          element.style.width = `${style.width}px`
          element.style.maxWidth = '100%'
          element.style.fontFamily = style.fontFamily
        }, { width, fontFamily })
        await assertHeaderLayout()
        expect(await resultHeader.locator('.dsh-pdf-translation-language-trigger > span')
          .evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true)
      }
    } finally {
      await resultHeader.evaluate((element, style) => {
        if (style === null) element.removeAttribute('style')
        else element.setAttribute('style', style)
      }, headerStyle)
    }
    await panel.locator('.dsh-pdf-translation-result-header > button').first().click()
    await panel.locator('.dsh-pdf-translation-copy-error').waitFor({ state: 'visible' })
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} }))
    await panel.locator('.dsh-pdf-translation-result-header > button').first().click()
    await expect.poll(() => panel.locator('.dsh-pdf-translation-copy-error').innerText()).toContain('unavailable')
    response = JSON.stringify({ kind: 'sentence', translation: 'The model cannot determine a unique meaning from this fragment.' })
    // Keep the request pending until Cancel is clicked, including under V8
    // coverage where browser actionability checks can exceed a short timer.
    responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    const language = panel.locator('.dsh-pdf-translation-language-trigger')
    await language.click()
    await panel.locator('.dsh-pdf-translation-language-menu').getByRole('button', { name: 'French' }).click()
    await expect.poll(() => pendingResponseSignal !== undefined).toBe(true)
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => panel.locator('.dsh-pdf-translation-status').innerText()).toContain('cancelled')
    await expect.poll(() => pendingResponseSignal?.aborted).toBe(true)
    releaseResponse()
    responseGate = undefined
    await panel.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => panel.locator('.dsh-pdf-translation-text').innerText())
      .toBe('The model cannot determine a unique meaning from this fragment.')
    expect(await panel.getByRole('alert').count()).toBe(0)
    await panel.locator('.dsh-pdf-translation-language-trigger').focus()
    await page.keyboard.press('Escape')
    await panel.locator('.dsh-pdf-translation-content').waitFor({ state: 'detached' })

    const toolbar = reader.getByRole('toolbar', { name: 'PDF reading and editing' })
    await toolbar.getByRole('button', { name: 'Region screenshot', exact: true }).click()
    await reader.locator('.dsh-pdf-mode-region').first().waitFor({ state: 'visible' })
    const box = (await reader.locator('[data-pdf-page="1"]').boundingBox())!
    await page.mouse.move(box.x + 120, box.y + 120)
    await page.mouse.down()
    await page.mouse.move(box.x + 320, box.y + 250, { steps: 8 })
    await page.mouse.up()
    const dialog = reader.getByRole('dialog', { name: 'Screenshot preview' })
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })
    await dialog.getByRole('img').waitFor({ state: 'visible' })
    const close = dialog.getByRole('button', { name: 'Close', exact: true })
    await close.focus()
    await close.press('Shift+Tab')
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement)
      && document.activeElement !== element.querySelector('button'))).toBe(true)
    await page.keyboard.press('Tab')
    await expect.poll(() => close.evaluate(element => element === document.activeElement)).toBe(true)
    const copy = dialog.locator('.dsh-pdf-screenshot-actions button').first()
    await copy.click()
    await expect.poll(async () => (await dialog.getByRole('alert').count())
      + (await dialog.locator('.dsh-pdf-screenshot-status').allTextContents()).filter(text => text.trim()).length)
      .toBeGreaterThan(0)
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async (_items: ClipboardItem[]) => { (window as typeof window & { __copiedImage?: boolean }).__copiedImage = true },
    } }))
    await copy.click()
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __copiedImage?: boolean }).__copiedImage)).toBe(true)
    await expect.poll(() => dialog.locator('.dsh-pdf-screenshot-status').innerText()).toContain('Image copied')
    const recognize = dialog.getByRole('button', { name: 'Recognize region' })
    await recognize.waitFor({ state: 'visible' })
    response = 'Panel OCR completed.'
    await recognize.click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => reader.locator('.dsh-pdf-ocr-transcript').textContent()).toContain('Panel OCR completed.')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    releaseResponse()
    await opened?.close()
    await scaffold.close()
  }
}, 90_000)
