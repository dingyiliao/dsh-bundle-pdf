import assert from 'node:assert/strict'
import test from 'node:test'
import type { PDFPageProxy } from 'pdfjs-dist'
import { leasePageResources } from '../src/client/experiment/page-resource-lease.js'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function within(done: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([done, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('page cleanup did not finish')), 2000)
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('page resources are cleaned only after the last view releases its lease', async () => {
  let cleanups = 0
  let resolveCleaned!: () => void
  const cleaned = new Promise<void>(resolve => { resolveCleaned = resolve })
  const page = { cleanup() { cleanups++; resolveCleaned(); return true } } as unknown as PDFPageProxy
  const releaseFirst = leasePageResources(page)
  const releaseSecond = leasePageResources(page)
  releaseFirst()
  releaseFirst()
  await delay(300)
  assert.equal(cleanups, 0)
  releaseSecond()
  await within(cleaned)
  assert.equal(cleanups, 1)
})

test('quickly revisiting a page cancels pending cleanup and failed cleanup is retried', async () => {
  let attempts = 0
  let resolveCleaned!: () => void
  const cleaned = new Promise<void>(resolve => { resolveCleaned = resolve })
  const page = { cleanup() { if (++attempts >= 2) { resolveCleaned(); return true } return false } } as unknown as PDFPageProxy
  leasePageResources(page)()
  await delay(50)
  const releaseAgain = leasePageResources(page)
  await delay(350)
  assert.equal(attempts, 0)
  releaseAgain()
  await within(cleaned)
  assert.equal(attempts, 2)
})
