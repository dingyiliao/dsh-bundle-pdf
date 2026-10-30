import { existsSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'
import { attachPdfBrowserCoverage } from '../browser-coverage.ts'

/** Use the same browser selection and coverage lifecycle for both Web suites. */
export async function launchPdfBrowser(): Promise<Browser> {
  if (process.env.PDF_BENCH_CHROMIUM) {
    return attachPdfBrowserCoverage(await chromium.launch({ executablePath: process.env.PDF_BENCH_CHROMIUM }))
  }
  if (existsSync(chromium.executablePath())) return attachPdfBrowserCoverage(await chromium.launch())
  try { return attachPdfBrowserCoverage(await chromium.launch({ channel: 'chrome' })) }
  catch (error) {
    if (!/executable doesn't exist|distribution 'chrome' is not found/i.test(String(error))) throw error
    return attachPdfBrowserCoverage(await chromium.launch({ channel: 'msedge' }))
  }
}
