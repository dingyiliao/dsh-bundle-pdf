import { existsSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'
import { attachPdfBrowserCoverage } from '../browser-coverage.ts'

/** Use the same browser selection and coverage lifecycle for both Web suites. */
export async function launchPdfBrowser(): Promise<Browser> {
  const executablePath = process.env.DSH_PDF_BROWSER_EXECUTABLE ?? process.env.PDF_BENCH_CHROMIUM
  if (executablePath) {
    return attachPdfBrowserCoverage(await chromium.launch({ executablePath }))
  }
  if (existsSync(chromium.executablePath())) return attachPdfBrowserCoverage(await chromium.launch())
  try { return attachPdfBrowserCoverage(await chromium.launch({ channel: 'chrome' })) }
  catch (error) {
    if (!/executable doesn't exist|distribution 'chrome' is not found/i.test(String(error))) throw error
    return attachPdfBrowserCoverage(await chromium.launch({ channel: 'msedge' }))
  }
}
