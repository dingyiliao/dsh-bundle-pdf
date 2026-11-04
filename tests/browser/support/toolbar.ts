import { type Locator, type Page as BrowserPage } from 'playwright'
import { expect } from 'vitest'
import { captureStableAria, ROOT } from './scaffold.ts'
import { build } from 'esbuild'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

export async function chooseZoom(reader: Locator, label: string) {
  const zoom = reader.locator('.dsh-pdf-toolbar-zoom')
  await zoom.locator('summary').click()
  await reader.locator('.dsh-pdf-zoom-menu').getByRole('button', { name: label, exact: true }).click()
}

export const fileActions = (reader: Locator) => reader.locator('.dsh-pdf-tools-menu[aria-label="Document actions"]')

/** Document commands are direct in tall readers and use the menu in short readers. */
export async function documentAction(reader: Locator, name: string | RegExp): Promise<Locator> {
  const direct = reader.locator('.dsh-pdf-document-direct').getByRole('button', { name, exact: true })
  if (await direct.isVisible()) return direct
  const trigger = reader.locator('.dsh-pdf-tools > summary')
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  const command = fileActions(reader).getByRole('button', { name, exact: true })
  await command.waitFor({ state: 'visible' })
  return command
}

/** Both floating rails share a full-width canvas; neither creates an inner clipping column. */
export async function expectFloatingToolRails(reader: Locator) {
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
export async function openSidebarSection(reader: Locator, name: string) {
  const tab = reader.getByRole('tab', { name, exact: true })
  if (await tab.getAttribute('aria-expanded') !== 'true') await tab.click()
}

export async function captureToolbarEditsAria(page: BrowserPage, workspaceCwd: string) {
  return [await captureStableAria(page, '.dsh-pdf-tool-history', workspaceCwd),
    await captureStableAria(page, '.dsh-pdf-toolbar-save', workspaceCwd)].map(value => value.trim()).join('\n')
}

/** All persistent actions in the one-piece rail remain icon-only at every width. */
export async function expectIconOnlyMainToolbar(toolbar: Locator) {
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

export async function mountReaderToolRail(page: BrowserPage, fixture = 'reader-toolbar-layout', root = 'toolbar-root') {
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

export type ToolRailInput = Partial<import("../../modules/viewer/reader-toolbar-layout.web.fixture.tsx").ReaderToolbarLayoutInput>

export type ToolRailFixture = { set(input: ToolRailInput): void; calls(): string[]; resetCalls(): void }

export const setToolRail = (page: BrowserPage, input: ToolRailInput) => page.evaluate(value =>
  (window as typeof window & { __pdfToolbarLayoutFixture: ToolRailFixture }).__pdfToolbarLayoutFixture.set(value), input)

export const toolRailCalls = (page: BrowserPage) => page.evaluate(() =>
  (window as typeof window & { __pdfToolbarLayoutFixture: ToolRailFixture }).__pdfToolbarLayoutFixture.calls())

export async function saveToolRailShot(page: BrowserPage, name: string) {
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

export type ReaderSaveInput = import("../../modules/viewer/reader-save.web.fixture.tsx").ReaderSaveFixtureInput

export type ReaderSaveFixture = { set(input: ReaderSaveInput): void; calls(): number[]; errors(): string[]; resolve(): void; reject(): void }

export const setReaderSave = (page: BrowserPage, input: ReaderSaveInput) => page.evaluate(value =>
  (window as typeof window & { __pdfReaderSaveFixture: ReaderSaveFixture }).__pdfReaderSaveFixture.set(value), input)

export const settleReaderSave = (page: BrowserPage, outcome: 'resolve' | 'reject') => page.evaluate(value =>
  (window as typeof window & { __pdfReaderSaveFixture: ReaderSaveFixture }).__pdfReaderSaveFixture[value](), outcome)
