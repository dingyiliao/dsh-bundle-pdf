import { type Locator, type Page as BrowserPage } from 'playwright'
import { build } from 'esbuild'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { ROOT } from './scaffold.ts'

export interface IndexingControlsFixture {
  calls(): Array<{ action: string; sessionId: string; documentId: string }>
  diagnosticCalls(): Array<{ action: string; sessionId: string; documentId: string; occurrence: number }>
  errors(): string[]
  revision(): string | undefined
  show(name: string): void
  publish(state: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled', sessionId?: string, documentId?: string): void
  republish(): void
  disable(): void
}

export async function mountIndexingControls(page: BrowserPage) {
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

export const indexingFixture = (page: BrowserPage) => ({
  calls: () => page.evaluate(() => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.calls()),
  diagnosticCalls: () => page.evaluate(() => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.diagnosticCalls()),
  errors: () => page.evaluate(() => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.errors()),
  revision: () => page.evaluate(() => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.revision()),
  publish: (state: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled', sessionId?: string, documentId?: string) =>
    page.evaluate(input => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.publish(input.state, input.sessionId, input.documentId), { state, sessionId, documentId }),
  show: (name: string) => page.evaluate(name => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.show(name), name),
  republish: () => page.evaluate(() => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.republish()),
  disable: () => page.evaluate(() => (window as typeof window & { __pdfIndexingFixture: IndexingControlsFixture }).__pdfIndexingFixture.disable()),
})

export async function saveIndexingControlsShot(page: BrowserPage, name: string) {
  const directory = process.env.DSH_PDF_INDEXING_PREVIEW_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.mouse.move(page.viewportSize()!.width - 1, page.viewportSize()!.height - 1)
  await page.screenshot({ path: join(directory, `${name}.png`) })
}

export async function openIndexingTasks(reader: Locator) {
  const trigger = reader.locator('.dsh-pdf-activity-trigger')
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
}

export async function openIndexingTaskActions(reader: Locator, title: string) {
  await openIndexingTasks(reader)
  const label = `More task actions: ${title}`
  const trigger = reader.getByRole('button', { name: label, exact: true })
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  const menu = reader.getByRole('group', { name: label, exact: true })
  await menu.waitFor({ state: 'visible' })
  return menu
}
