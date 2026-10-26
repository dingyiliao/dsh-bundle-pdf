/** Opt-in V8 coverage for the shipped PDF Client running inside Web e2e. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'

const PACKAGE_ID = '@dylanl1/dsh-plugin-pdf'
let nextArtifact = 0

interface SourceMapSection {
  offset: { line: number; column: number }
  map: { sources?: string[]; [key: string]: unknown }
}

interface IndexedSourceMap {
  sections?: SourceMapSection[]
}

/** V8 uses UTF-16 offsets, just like JavaScript string indexing. */
function lineStarts(source: string): number[] {
  const starts = [0]
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') starts.push(index + 1)
  return starts
}

function sectionOffset(starts: number[], section: SourceMapSection): number {
  return (starts[section.offset.line] ?? 0) + section.offset.column
}

function sourceMapReference(source: string): string | undefined {
  const matches = [...source.matchAll(/^\/\/# sourceMappingURL=([^\r\n]+)\s*$/gm)]
  return matches.at(-1)?.[1]
}

async function collectPage(page: Page) {
  const entries = await page.coverage.stopJSCoverage()
  if (process.env.DSH_PDF_BROWSER_COVERAGE_DEBUG === '1') {
    console.info('PDF browser coverage scripts:', entries.map(entry => ({
      url: entry.url, bytes: entry.source?.length ?? 0, hasPackage: entry.source?.includes(PACKAGE_ID) ?? false,
    })))
  }
  const ownEntries = []
  for (const entry of entries) {
    if (!entry.url.includes('/plugins/') || !entry.url.includes(PACKAGE_ID)) continue
    if (!entry.source) throw new Error(`PDF browser coverage: script source unavailable for ${entry.url}`)
    const reference = sourceMapReference(entry.source)
    if (!reference) throw new Error(`PDF browser coverage: source map missing from ${entry.url}`)
    const response = await page.request.get(new URL(reference, entry.url).href)
    if (!response.ok()) throw new Error(`PDF browser coverage: source map request failed (${response.status()}) for ${entry.url}`)
    const sourceMap = await response.json() as IndexedSourceMap
    if (!sourceMap.sections?.length) throw new Error(`PDF browser coverage: expected indexed combo source map for ${entry.url}`)
    if (process.env.DSH_PDF_BROWSER_COVERAGE_DEBUG === '1') {
      console.info('PDF browser coverage map sections:', sourceMap.sections.map(section => ({
        line: section.offset.line, firstSources: section.map.sources?.slice(0, 3),
      })))
    }
    const starts = lineStarts(entry.source)
    let matchedSection = false
    for (const [index, section] of sourceMap.sections.entries()) {
      const start = sectionOffset(starts, section)
      const end = sourceMap.sections[index + 1]
        ? sectionOffset(starts, sourceMap.sections[index + 1]!)
        : entry.source.length
      // A source-map URL like ../src/client/Reader.tsx resolves under the package scope.
      // in DSH's combo map, so use the factory registration rather than its relocated path.
      if (!entry.source.slice(start, Math.min(start + 300, end)).includes(`id: "${PACKAGE_ID}"`)) continue
      matchedSection = true
      const functions = entry.functions.map(fn => ({
        functionName: fn.functionName,
        isBlockCoverage: fn.isBlockCoverage,
        ranges: fn.ranges
          .map(range => ({
            startOffset: Math.max(range.startOffset, start) - start,
            endOffset: Math.min(range.endOffset, end) - start,
            count: range.count,
          }))
          .filter(range => range.endOffset > range.startOffset),
      })).filter(fn => fn.ranges.length > 0)
      ownEntries.push({ url: entry.url, generatedSource: entry.source.slice(start, end), sourceMap: section.map, functions })
    }
    if (!matchedSection) throw new Error(`PDF browser coverage: no ${PACKAGE_ID} section in ${entry.url}`)
  }
  return ownEntries
}

/** Preserve ordinary Web e2e behavior; only the explicit coverage lane wraps page creation and browser close. */
export function attachPdfBrowserCoverage(browser: Browser): Browser {
  const outputDirectory = process.env.DSH_PDF_BROWSER_COVERAGE_DIR
  if (!outputDirectory) return browser
  const pages: Page[] = []
  const originalNewPage = browser.newPage.bind(browser)
  const originalClose = browser.close.bind(browser)
  browser.newPage = async (options) => {
    const page = await originalNewPage(options)
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false })
    pages.push(page)
    return page
  }
  browser.close = async (options) => {
    try {
      const entries = (await Promise.all(pages.filter(page => !page.isClosed()).map(collectPage))).flat()
      if (entries.length > 0) {
        await mkdir(outputDirectory, { recursive: true })
        const file = join(outputDirectory, `browser-${process.pid}-${Date.now()}-${++nextArtifact}.json`)
        await writeFile(file, JSON.stringify({ version: 1, packageId: PACKAGE_ID, entries }), 'utf8')
      }
    } finally {
      await originalClose(options)
    }
  }
  return browser
}
