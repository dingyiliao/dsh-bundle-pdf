import { expect, it, onTestFailed } from 'vitest'
import { build } from 'esbuild'
import { join } from 'node:path'
import { launchPdfBrowser as launchBrowser } from '../launch.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { translationContextLimit } from '../../../src/translation/types.ts'
import { launchWebScaffold, seedSession, watchConsole, newEnglishPage, saveFailureShot, ROOT, SESSION } from '../support/scaffold.ts'
import { type Browser } from 'playwright'
import { FILE_NAME, sourcePdf } from '../support/documents.ts'

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
    expect(await note.locator('details').getAttribute('open')).toBe(null)
    expect(await note.locator('.dsh-pdf-translation-interpreted-text').isVisible()).toBe(false)
    expect(await panel.locator('.dsh-pdf-translation-details').isVisible()).toBe(true)
    await note.locator('summary').click()
    expect(await note.locator('.dsh-pdf-translation-interpreted-text').isVisible()).toBe(true)
    await note.locator('summary').click()
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
    const longOriginal = 'gradient of y with respect to x, including all components of the selected expression '.repeat(8)
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
        && Math.abs(bounds.height - 4 * Number.parseFloat(style.lineHeight)) <= 1
    }), { message: 'long original is clamped to four lines inside the narrow sidebar' }).toBe(true)
    await panel.getByRole('button', { name: '展开原文', exact: true }).click()
    expect(await panel.locator('.dsh-pdf-translation-source-text').evaluate(element =>
      element.scrollHeight <= element.clientHeight + 1)).toBe(true)
    await panel.getByRole('button', { name: '收起原文', exact: true }).click()
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

it('connects region capture, controlled OCR and full or selected transcript translation through production browser boundaries', async () => {
  const bundle = await build({ entryPoints: [join(ROOT, 'tests/modules/viewer/ocr-translation.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser' })
  const css = await Promise.all(['reader.css', 'reading-sidebar.css'].map(file => readFile(join(ROOT, 'src/client', file), 'utf8')))
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 720 } }), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('http://localhost/ocr-translation', route => route.fulfill({ contentType: 'text/html', body: '<div id="ocr-translation-root"></div>' }))
    await page.goto('http://localhost/ocr-translation')
    await page.addStyleTag({ content: `:root { --dsw-alias-bg-base:#f5f5f5; --dsw-alias-bg-layer-1:#fff; --dsw-alias-bg-layer-2:#f6f6f6; --dsw-alias-label-primary:#222; --dsw-alias-label-secondary:#666; --dsw-alias-border-l2:#ddd; --dsw-alias-link:#4278ed; } html,body,#ocr-translation-root { margin:0; height:100%; } ${css.join('\n')}
      .ocr-fixture-actions{display:flex;gap:8px;padding:8px;flex:none;flex-wrap:wrap}.ocr-fixture-body{display:flex;min-height:0;flex:1;gap:16px;padding:8px}
      .ocr-fixture-page{width:400px;height:600px;flex:none;background:white;white-space:pre-wrap;user-select:none;padding:20px}.ocr-fixture-page[data-mode=region]{cursor:crosshair}
      .ocr-fixture-sidebar{min-height:0;min-width:0;width:330px;background:white}.ocr-fixture-sidebar>.dsh-pdf-panel{height:100%}
      @media(max-width:500px){.ocr-fixture-page{display:none}.ocr-fixture-sidebar{width:100%}}
    ` })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    interface FixtureState { text: string; revision: number; ocr: Array<{ page: number; region: number[] }>; translations: Array<{
      text: string; targetLanguage: string; context: { sessionId: string; documentId: string; contentVersion: string;
        pages: number[]; selectionBefore?: string; selectionAfter?: string } }>; renders: Array<{ annotations: boolean; width: number; height: number }>; aborted: number }
    const state = () => page.evaluate(() => (window as typeof window & { __pdfOcrTranslationFixture: { state(): FixtureState } }).__pdfOcrTranslationFixture.state())
    const control = (action: 'fail' | 'defer' | 'release' | 'changeRevision') => page.evaluate(action => {
      const fixture = (window as typeof window & { __pdfOcrTranslationFixture: {
        next(value: 'fail' | 'defer'): void; release(): void; changeRevision(): void } }).__pdfOcrTranslationFixture
      if (action === 'fail' || action === 'defer') fixture.next(action)
      else fixture[action]()
    }, action)
    await page.getByRole('button', { name: 'Capture region', exact: true }).click()
    const scan = page.getByTestId('scanned-page'), bounds = (await scan.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width * .1, bounds.y + bounds.height * .2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width * .85, bounds.y + bounds.height * .55, { steps: 8 })
    await page.mouse.up()
    const preview = page.getByRole('dialog', { name: 'Screenshot preview', exact: true })
    await preview.waitFor()
    await expect.poll(() => preview.locator('img').evaluate(image => image.naturalWidth > 0 && image.naturalHeight > 0)).toBe(true)
    expect((await state()).renders).toHaveLength(1)
    expect((await state()).renders[0]!.annotations).toBe(false)
    await preview.getByRole('button', { name: 'Recognize region', exact: true }).click()
    const transcript = page.locator('.dsh-pdf-ocr-transcript')
    await transcript.waitFor()
    const recognized = await state()
    expect(recognized.ocr).toHaveLength(1)
    expect(recognized.ocr[0]!.page).toBe(2)
    expect(recognized.ocr[0]!.region).toHaveLength(4)
    expect(await transcript.textContent()).toBe(recognized.text)
    expect(await preview.count()).toBe(0)
    await page.getByRole('button', { name: 'Translate all', exact: true }).click()
    const translation = page.locator('.dsh-pdf-translation-panel')
    await expect.poll(() => translation.locator('.dsh-pdf-translation-text').textContent()).toBe(`Translated (zh): ${recognized.text}`)
    expect((await state()).translations[0]).toEqual({ text: recognized.text, targetLanguage: 'zh', context: {
      sessionId: 'scan-session', documentId: 'scanned-document', contentVersion: 'scan-v1', pages: [2] } })
    await page.setViewportSize({ width: 280, height: 540 })
    await expect.poll(() => translation.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await translation.locator('.dsh-pdf-translation-language > summary').click()
    await translation.getByRole('button', { name: 'French', exact: true }).click()
    await expect.poll(() => translation.locator('.dsh-pdf-translation-text').textContent()).toBe(`Translated (fr): ${recognized.text}`)
    expect((await state()).ocr).toHaveLength(1)

    const selected = page.getByRole('button', { name: 'Translate selected text', exact: true })
    const selectWithMouse = async () => {
      await translation.getByRole('button', { name: 'Back to recognized text', exact: true }).click()
      const word = await transcript.evaluate(element => {
        const range = document.createRange(); range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, 5)
        const bounds = range.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      })
      await page.mouse.move(word.x + .1, word.y + word.height / 2)
      await page.mouse.down(); await page.mouse.move(word.x + word.width - .1, word.y + word.height / 2, { steps: 8 }); await page.mouse.up()
      await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('First')
      await expect.poll(() => selected.isEnabled()).toBe(true)
    }
    await selectWithMouse()
    // Read-only text has no editable caret. Keyboard users can activate the
    // action without a pointer click clearing their existing transcript range.
    for (let index = 0; index < 8 && !await selected.evaluate(element => element === document.activeElement); index++) {
      await page.keyboard.press('Tab')
    }
    expect(await selected.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('First')
    await control('fail')
    await page.keyboard.press('Enter')
    await translation.getByRole('button', { name: 'Retry', exact: true }).waitFor()
    expect((await state()).translations[2]).toEqual({ text: 'First', targetLanguage: 'fr', context: {
      sessionId: 'scan-session', documentId: 'scanned-document', contentVersion: 'scan-v1', pages: [2],
      selectionBefore: '', selectionAfter: recognized.text.slice(5, 5 + translationContextLimit) } })
    await translation.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => translation.locator('.dsh-pdf-translation-text').textContent()).toBe('Translated (fr): First')
    expect((await state()).ocr).toHaveLength(1)
    expect((await state()).translations).toHaveLength(4)

    await selectWithMouse()
    await control('defer'); await selected.click()
    await translation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => (state()).then(value => value.aborted)).toBeGreaterThan(0)
    await control('release')
    await expect.poll(() => translation.locator('[role="status"]').first().textContent()).toBe('Translation cancelled.')
    expect(await translation.locator('.dsh-pdf-translation-text').count()).toBe(0)
    await selectWithMouse()
    await control('defer'); await selected.click()
    await expect.poll(() => (state()).then(value => value.translations.length)).toBe(6)
    const abortedBeforeRevision = (await state()).aborted
    await control('changeRevision')
    await expect.poll(() => state().then(value => value.revision)).toBe(8)
    await expect.poll(() => state().then(value => value.aborted)).toBeGreaterThan(abortedBeforeRevision)
    await expect.poll(() => translation.locator('.dsh-pdf-translation-source-text').count()).toBe(0)
    await control('release')
    expect(await translation.locator('.dsh-pdf-translation-text').count()).toBe(0)
    await page.getByRole('button', { name: 'Show OCR', exact: true }).click()
    expect(await page.getByRole('button', { name: 'Translate all', exact: true }).count()).toBe(0)
    expect((await state()).ocr).toHaveLength(1)
    expect(errors).toEqual([])
  } finally { await browser.close() }
}, 45_000)

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
