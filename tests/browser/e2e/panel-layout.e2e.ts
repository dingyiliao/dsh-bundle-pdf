import { expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { launchPdfBrowser as browser } from '../launch.ts'
import { DSH_ROOT, ROOT } from '../support/scaffold.ts'

it('keeps OCR translation labels and copy aligned at actual 234px and 260px sidebar widths in Chinese and English', async () => {
  const { build } = await import('esbuild')
  const bundle = await build({ entryPoints: [join(ROOT, 'tests/modules/viewer/ocr-toolbar-layout.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser' })
  const css = await Promise.all(['reader.css', 'reading-sidebar.css', 'glass.css'].map(file => readFile(join(ROOT, 'src/client', file), 'utf8')))
  const opened = await browser()
  try {
    const page = await opened.newPage({ viewport: { width: 900, height: 620 }, reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<div id="ocr-toolbar-layout-root" style="height:100%;width:100%"></div>')
    await page.addStyleTag({ content: `:root { --dsw-alias-bg-base:#f4f5f7; --dsw-alias-bg-layer-1:#fff; --dsw-alias-label-primary:#202124; --dsw-alias-label-secondary:#70747c; --dsw-alias-border-l2:#d8dbe1; --dsw-alias-link:#4278ed; --dsw-alias-interactive-bg-hover:#e8eaf0; } html,body { margin:0;height:100%; } ${css.join('\n')}` })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const sidebar = page.locator('.dsh-pdf-sidebar')
    const divider = sidebar.getByRole('separator')
    const actions = sidebar.locator('.dsh-pdf-ocr-actions')
    const main = actions.locator('.dsh-pdf-split-action-main')
    const copy = actions.locator('.dsh-pdf-ocr-copy')
    await expect.poll(() => divider.getAttribute('aria-valuenow')).toBe('296')
    for (const width of [234, 260]) {
      const currentWidth = Number(await divider.getAttribute('aria-valuenow'))
      const bounds = (await divider.boundingBox())!
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 40)
      await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width / 2 + currentWidth - width, bounds.y + 40, { steps: 4 })
      await page.mouse.up()
      await expect.poll(() => divider.getAttribute('aria-valuenow')).toBe(String(width))
      await expect.poll(() => sidebar.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(width)
      for (const locale of ['en', 'zh'] as const) {
        await page.evaluate(value => (window as typeof window & {
          __pdfOcrToolbarLayout: { locale(value: 'en' | 'zh'): void }
        }).__pdfOcrToolbarLayout.locale(value), locale)
        for (const selected of [false, true]) {
          await page.evaluate(partial => {
            const text = document.querySelector('.dsh-pdf-ocr-transcript')!.firstChild!
            const selection = document.getSelection()!
            selection.removeAllRanges()
            if (partial) { const range = document.createRange(); range.setStart(text, 21); range.setEnd(text, 39); selection.addRange(range) }
            document.dispatchEvent(new Event('selectionchange'))
          }, selected)
          const expected = locale === 'en' ? selected ? 'Translate selected text' : 'Translate all'
            : selected ? '翻译选中文字' : '翻译全部'
          await expect.poll(() => main.getAttribute('aria-label')).toBe(expected)
          const geometry = await actions.evaluate(element => {
            const row = element.getBoundingClientRect()
            const main = element.querySelector<HTMLElement>('.dsh-pdf-split-action-main')!
            const copy = element.querySelector<HTMLElement>('.dsh-pdf-ocr-copy')!
            const visibleLabels = [...main.querySelectorAll<HTMLElement>('span')]
              .filter(label => getComputedStyle(label).display !== 'none')
            return { rowWidth: row.width, rowHeight: row.height,
              mainDisplay: getComputedStyle(main).display,
              labels: visibleLabels.map(label => ({ text: label.textContent, width: label.clientWidth, scrollWidth: label.scrollWidth })),
              aligned: Math.abs(main.getBoundingClientRect().top - copy.getBoundingClientRect().top) <= 1,
              fits: [...element.querySelectorAll<HTMLElement>('.dsh-pdf-split-action-main, .dsh-pdf-split-action-trigger, .dsh-pdf-ocr-copy')]
                .every(control => control.getBoundingClientRect().left >= row.left - 1 && control.getBoundingClientRect().right <= row.right + 1) }
          })
          expect(geometry.rowWidth, 'the measured content excludes the real 56px side rail and both gutters').toBeLessThan(width - 80)
          expect(geometry.mainDisplay).toBe('flex')
          expect(geometry.labels).toHaveLength(1)
          expect(geometry.labels[0]!.text).toBe(locale === 'zh' ? '翻译' : 'Translate')
          expect(geometry.labels[0]!.scrollWidth).toBeLessThanOrEqual(geometry.labels[0]!.width + 1)
          expect(geometry.rowHeight).toBeLessThanOrEqual(33)
          expect(geometry.aligned).toBe(true)
          expect(geometry.fits).toBe(true)
          expect(await copy.getAttribute('aria-label')).toBe(locale === 'zh' ? '复制转写' : 'Copy transcript')
        }
      }
    }
    expect(errors).toEqual([])
  } finally { await opened.close() }
})

it('keeps sidebar glass sampling the PDF backdrop while width clipping and collapsed controls remain safe', async () => {
  const { build } = await import('esbuild')
  const bundle = await build({ entryPoints: [join(ROOT, 'tests/modules/viewer/sidebar-glass.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.css': 'text' } })
  const theme = await readFile(join(DSH_ROOT, 'packages/client/ui-theme/src/styles/design-platform.css'), 'utf8')
  const opened = await browser()
  try {
    const page = await opened.newPage({ viewport: { width: 900, height: 620 }, deviceScaleFactor: 1 })
    await page.setContent('<div id="sidebar-glass-root" style="height:100%;width:100%"></div>')
    await page.addStyleTag({ content: `${theme} html,body { margin:0;height:100%; }
      .sidebar-glass-document { position:absolute;inset:0;padding:240px 32px 0;color:#111;
        background:repeating-linear-gradient(0deg,#000 0 2px,#fff 2px 12px); }
      .sidebar-glass-document p { background:white;max-width:600px; }` })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const sidebar = page.locator('.dsh-pdf-sidebar')
    const main = sidebar.locator('.dsh-pdf-sidebar-main')
    const sample = main.getByTestId('glass-sample')
    const panelAction = main.getByTestId('glass-panel-action')
    await sample.waitFor()
    const oldSample = (await sample.boundingBox())!
    for (const mode of ['light', 'dark'] as const) {
      await page.evaluate(mode => {
        if (mode === 'dark') document.body.setAttribute('data-ds-dark-theme', 'true')
        else document.body.removeAttribute('data-ds-dark-theme')
      }, mode)
      expect(await sidebar.evaluate(element => ({ overflow: getComputedStyle(element).overflowX,
        clipMargin: getComputedStyle(element).overflowClipMargin,
        widthAnimation: getComputedStyle(element).transitionProperty.includes('width') })))
        .toEqual({ overflow: 'clip', clipMargin: '24px', widthAnimation: true })
      expect(await sidebar.locator('.dsh-pdf-sidebar-shell').evaluate(element => getComputedStyle(element).clipPath)).toBe('none')
      expect(await main.evaluate(element => ({ blur: getComputedStyle(element).backdropFilter.includes('blur(24px)'),
        shadow: getComputedStyle(element).boxShadow !== 'none' }))).toEqual({ blur: true, shadow: true })
      const bounds = (await sample.boundingBox())!
      const png = await page.screenshot({ clip: { x: Math.floor(bounds.x + bounds.width / 2), y: Math.ceil(bounds.y + 8), width: 1, height: 96 } })
      const contrast = await page.evaluate(async src => {
        const image = new Image(); image.src = src; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        const red = Array.from({ length: pixels.length / 4 }, (_, index) => pixels[index * 4]!)
        return Math.max(...red) - Math.min(...red)
      }, `data:image/png;base64,${png.toString('base64')}`)
      // A clip-path ancestor leaves the black/white lines sharp (14 levels
      // even under the 95% fill). Real backdrop blur reduces that contrast.
      expect(contrast, `${mode} glass must diffuse the external PDF pixels`).toBeLessThanOrEqual(3)
      if (process.env.DSH_PDF_GLASS_SCREENSHOT_DIR) {
        await mkdir(process.env.DSH_PDF_GLASS_SCREENSHOT_DIR, { recursive: true })
        await page.screenshot({ path: join(process.env.DSH_PDF_GLASS_SCREENSHOT_DIR, `sidebar-glass-${mode}.png`) })
      }
    }
    const toggle = sidebar.getByRole('tab', { name: 'OCR', exact: true })
    await toggle.click()
    await expect.poll(() => main.evaluate(element => ({ inert: (element as HTMLElement).inert,
      hidden: element.getAttribute('aria-hidden'), pointerEvents: getComputedStyle(element).pointerEvents })))
      .toEqual({ inert: true, hidden: 'true', pointerEvents: 'none' })
    await panelAction.evaluate(element => (element as HTMLElement).focus())
    expect(await main.evaluate(element => element.contains(document.activeElement))).toBe(false)
    await sidebar.evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
    await expect.poll(() => sidebar.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(56)
    await page.mouse.click(oldSample.x + oldSample.width / 2, oldSample.y + oldSample.height / 2)
    await expect.poll(() => page.getByTestId('document-clicks').textContent()).toBe('1')
    expect(await page.getByTestId('panel-clicks').textContent()).toBe('0')
    await toggle.click()
    await expect.poll(() => main.evaluate(element => (element as HTMLElement).inert)).toBe(false)
    await panelAction.click()
    await expect.poll(() => page.getByTestId('panel-clicks').textContent()).toBe('1')
  } finally { await opened.close() }
}, 30_000)

it('keeps the Save As sheet focused and usable in a narrow short reader', async () => {
  const { build } = await import('esbuild')
  const bundle = await build({ entryPoints: [join(ROOT, 'tests/modules/viewer/save-as-dialog.web.fixture.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser' })
  const css = await Promise.all(['reader.css', 'glass.css'].map(file => readFile(join(ROOT, 'src/client', file), 'utf8')))
  const opened = await browser()
  try {
    const page = await opened.newPage({ viewport: { width: 760, height: 600 }, reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<div id="save-as-root" style="height:100%;width:100%"></div>')
    await page.addStyleTag({ content: `:root { --dsw-alias-bg-base:#f4f5f7; --dsw-alias-bg-layer-1:#fff; --dsw-alias-label-primary:#202124; --dsw-alias-label-secondary:#70747c; --dsw-alias-border-l2:#d8dbe1; --dsw-alias-link:#4278ed; --dsw-alias-button-primary-fill:#17191d; --dsw-alias-label-primary-foreground:#fff; --dsw-alias-interactive-bg-hover:#e8eaf0; --dsw-alias-interactive-bg-active:#dfe2e9; --dsw-alias-interactive-bg-hover-danger:#fff0f1; } html,body { margin:0;height:100%; } ${css.join('\n')}` })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const trigger = page.getByRole('button', { name: '另存为', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '另存 PDF 副本', exact: true })
    const name = dialog.getByRole('textbox', { name: '文件名', exact: true })
    const save = dialog.getByRole('button', { name: '保存副本', exact: true })
    await expect.poll(() => name.evaluate(element => ({ focused: element === document.activeElement,
      start: (element as HTMLInputElement).selectionStart, end: (element as HTMLInputElement).selectionEnd,
      stemEnd: (element as HTMLInputElement).value.lastIndexOf('.') })))
      .toEqual({ focused: true, start: 0, end: '概率论与数理统计-annotated'.length, stemEnd: '概率论与数理统计-annotated'.length })
    await save.focus(); await save.press('Tab')
    expect(await name.evaluate(element => element === document.activeElement)).toBe(true)
    await name.press('Shift+Tab')
    expect(await save.evaluate(element => element === document.activeElement)).toBe(true)
    if (process.env.DSH_PDF_SAVE_AS_SCREENSHOT) {
      await mkdir(dirname(process.env.DSH_PDF_SAVE_AS_SCREENSHOT), { recursive: true })
      await page.screenshot({ path: process.env.DSH_PDF_SAVE_AS_SCREENSHOT })
    }
    await save.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)

    await trigger.click()
    await dialog.getByRole('button', { name: '更改位置…', exact: true }).click()
    const directory = dialog.getByRole('textbox', { name: '保存位置', exact: true })
    expect(await directory.evaluate(element => element === document.activeElement)).toBe(true)
    await directory.fill('/Users/reader/Documents/学习资料/用于验证很长保存目录不会撑开弹窗的路径')
    await page.evaluate(() => (window as typeof window & { __pdfSaveAsDialogFixture: { set(input: { replaceConfirm?: boolean; error?: string }): void } })
      .__pdfSaveAsDialogFixture.set({ replaceConfirm: true }))
    const replacement = page.getByRole('dialog', { name: '替换已有 PDF？', exact: true })
    expect(await replacement.getByRole('button', { name: '替换并保存', exact: true })
      .evaluate(element => element === document.activeElement)).toBe(true)
    await replacement.getByRole('button', { name: '返回', exact: true }).click()
    expect(await name.evaluate(element => element === document.activeElement)).toBe(true)

    await page.setViewportSize({ width: 360, height: 320 })
    await page.evaluate(() => (window as typeof window & { __pdfSaveAsDialogFixture: { set(input: { error: string }): void } })
      .__pdfSaveAsDialogFixture.set({ error: '保存位置暂时不可用，请检查目标文件夹后重试。'.repeat(16) }))
    await expect.poll(() => dialog.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const bounds = (await dialog.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(15)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(345)
    expect(bounds.y).toBeGreaterThanOrEqual(15)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(305)
    await save.scrollIntoViewIfNeeded()
    const saveBounds = (await save.boundingBox())!
    expect(saveBounds.y).toBeGreaterThanOrEqual(bounds.y)
    expect(saveBounds.y + saveBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height)
    await save.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)
    expect(errors).toEqual([])
  } finally { await opened.close() }
})
