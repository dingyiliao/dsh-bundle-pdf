/** Isolated test adapter. This entry is never included in the shipped plugin. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Reader } from '../src/client/Reader.tsx'
import { createPdfApi } from '../src/client/api.ts'
import { createPdfRuntime } from '../src/client/pdf-runtime.ts'
import { readerLocales } from '../src/client/reader-locales.ts'
import { createNativeDictionary } from '../src/client/native-dictionary.ts'
import { createOcrRegistry } from '../src/ocr/index.ts'
import { createTranslationRegistry } from '../src/translation/index.ts'
import { defaultSettings } from '../src/shared/contracts.ts'
import { observePdfPerformance, type PdfPerformanceEvent } from '../src/shared/performance.ts'
import styles from '../src/client/reader.css'

interface Config { sessionId: string; token: string; pages: number; annotations: number }
interface Payload { metrics: Record<string, number | null>; stages: PdfPerformanceEvent[]; qualityPassed: boolean }
interface Hook { run(scenario: string, timeout: number): Promise<Payload>; snapshot(): unknown; dispose(): Promise<void> }
declare global { interface Window { __PDF_BENCH_CONFIG__: Config; __PDF_BENCH__: Hook } }

const config = window.__PDF_BENCH_CONFIG__
const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
const owner = new AbortController(), root = createRoot(document.getElementById('root')!)
const runtime = createPdfRuntime(owner.signal), dictionary = createNativeDictionary()
const stages: PdfPerformanceEvent[] = []
let stageOverflow = false
const stop = observePdfPerformance(event => { if (stages.length >= 2000) { stageOverflow = true; return }; stages.push(event) })
const api = createPdfApi({ rpc: { async call(_path, _method, payload, signal) {
  const response = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bench-token': config.token },
    body: JSON.stringify(payload), signal })
  if (!response.ok) throw new Error(`Benchmark RPC HTTP ${response.status}`)
  const result = await response.json()
  if (result.ok && result.value?.document
    && (result.value.document.pageCount !== config.pages || result.value.document.annotations.length !== config.annotations)) {
    throw new Error('Reader metadata differs from the corpus manifest')
  }
  return result
} } }, owner.signal)
let opened = false, timedStart = 0
const longTasks: { startTime: number; duration: number }[] = []
const supportsLongTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false
const longObserver = supportsLongTasks ? new PerformanceObserver(list => {
  for (const item of list.getEntries()) longTasks.push({ startTime: item.startTime, duration: item.duration })
}) : undefined
longObserver?.observe({ type: 'longtask', buffered: false })
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const locales = readerLocales.en as Record<string, string>
const t = (key: string) => locales[key] ?? key

function open() {
  opened = true
  root.render(<Reader resourceAddress={`dsh-resource://file/session/${config.sessionId}//bench/fixture.pdf`}
    sessionId={config.sessionId} content={{ kind: 'renderer', revision: 0, loaded() {}, failed() {}, reload() {} }}
    scrollportRef={() => {}} useTabInfo={() => ({ tab: { id: config.sessionId, signal: owner.signal, actions: { openResource() {} } } })}
    t={t} api={api} ocr={createOcrRegistry()} translation={createTranslationRegistry({ timeoutMs: 600000, maxInputCharacters: 8192, maxOutputCharacters: 32768 })}
    dictionary={dictionary} settings={{ ...defaultSettings, translationEngine: 'none' }} openPdf={runtime.openPdf} />)
}

function rootElement() { return document.querySelector<HTMLElement>('.dsh-pdf-scroll') }
let pages: HTMLElement[] = []
function coverage() {
  const scroll = rootElement()
  if (!scroll) return { useful: 0, quality: 0, visible: [] as HTMLElement[] }
  if (pages.length !== config.pages) pages = [...scroll.querySelectorAll<HTMLElement>('[data-pdf-page]')]
  const bounds = scroll.getBoundingClientRect()
  // Pages are vertically ordered in this Reader. A binary search avoids reading 1,000 rectangles each frame.
  let lo = 0, hi = pages.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (pages[mid].getBoundingClientRect().bottom <= bounds.top) lo = mid + 1; else hi = mid }
  let area = 0, useful = 0, quality = 0
  const visible: HTMLElement[] = []
  for (let i = lo; i < pages.length; i++) {
    const page = pages[i], box = page.getBoundingClientRect()
    if (box.top >= bounds.bottom) break
    const a = Math.max(0, Math.min(bounds.right, box.right) - Math.max(bounds.left, box.left))
      * Math.max(0, Math.min(bounds.bottom, box.bottom) - Math.max(bounds.top, box.top))
    if (!a) continue
    area += a; visible.push(page)
    const canvas = page.querySelector<HTMLCanvasElement>('.dsh-pdf-canvas canvas')
    if (!canvas || canvas.dataset.pdfRasterReady !== 'true' || !canvas.width || !canvas.height) continue
    useful += a
    const expectedDpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(24_000_000 / (page.clientWidth * page.clientHeight)))
    // An old canvas stretched by CSS does not satisfy the target sampling quality.
    if (!page.style.transform && canvas.width / page.clientWidth >= expectedDpr * 0.99
      && canvas.height / page.clientHeight >= expectedDpr * 0.99) quality += a
  }
  return { useful: area ? useful / area : 0, quality: area ? quality / area : 0, visible }
}

function checkError() {
  const error = document.querySelector('.dsh-pdf-error')?.textContent?.trim()
  if (error) throw new Error(error)
}
async function waitQuality(start: number, timeout: number, response = () => true, committed = () => true) {
  let firstUseful: number | null = null
  while (performance.now() - start < timeout) {
    await frame(); checkError()
    const current = coverage()
    if (response() && current.useful >= 0.9 && firstUseful === null) firstUseful = performance.now() - start
    if (committed() && current.quality >= 0.99) {
      await frame() // DOM/raster completion plus a frame boundary is a presentation proxy.
      if (coverage().quality >= 0.99 && committed()) return { firstUsefulProxyMs: firstUseful, targetQualityProxyMs: performance.now() - start }
    }
  }
  throw new Error('Timed out waiting for completed raster at the target sampling quality')
}
function canvasBytes() { return [...document.querySelectorAll('canvas')].reduce((total, canvas) => total + canvas.width * canvas.height * 4, 0) }
function validateVisibleContent() {
  if (pages.length !== config.pages) throw new Error('Unexpected page placeholder count')
  const visible = coverage().visible
  if (!visible.length) throw new Error('No visible PDF page')
  const probe = document.createElement('canvas'); probe.width = 64; probe.height = 64
  const ctx = probe.getContext('2d')!
  for (const page of visible) {
    const canvas = page.querySelector<HTMLCanvasElement>('.dsh-pdf-canvas canvas')!
    ctx.clearRect(0, 0, 64, 64); ctx.drawImage(canvas, 0, 0, 64, 64)
    const pixels = ctx.getImageData(0, 0, 64, 64).data
    let ink = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 230) ink++
    if (ink < 5) throw new Error('Completed canvas is blank')
    if (!page.querySelector('.dsh-pdf-text-layer')?.textContent?.includes('PDF benchmark page')) throw new Error('Expected text layer content is absent')
  }
  probe.width = 0; probe.height = 0
}
function tasks(end: number) {
  const matching = longTasks.filter(task => task.startTime >= timedStart && task.startTime < end)
  return { longTaskCount: supportsLongTasks ? matching.length : null,
    longTaskTotalMs: supportsLongTasks ? matching.reduce((sum, item) => sum + item.duration, 0) : null,
    longTaskMaxMs: supportsLongTasks ? Math.max(0, ...matching.map(item => item.duration)) : null }
}
function nearestRank(values: number[], q: number) { return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1] : null }

window.__PDF_BENCH__ = {
  snapshot() {
    const current = coverage(), scroll = rootElement()
    return { visibleUseful: current.useful, visibleQuality: current.quality, pageCount: pages.length,
      visiblePages: current.visible.map(page => ({ number: page.dataset.pdfPage, width: page.clientWidth, height: page.clientHeight, transform: page.style.transform,
        canvases: [...page.querySelectorAll('canvas')].map(canvas => ({ width: canvas.width, height: canvas.height, ready: canvas.dataset.pdfRasterReady })) })),
      scroll: scroll ? { width: scroll.clientWidth, height: scroll.clientHeight, top: scroll.scrollTop } : null,
      message: document.querySelector('.dsh-pdf-error')?.textContent ?? null, stages }
  },
  async run(scenario, timeout) {
    if (opened) throw new Error('One scenario per fresh browser context')
    const metrics: Record<string, number | null> = {}
    if (scenario === 'reader.open') {
      timedStart = performance.now(); open()
      Object.assign(metrics, await waitQuality(timedStart, timeout))
      // Text is checked after timing; never equate content.loaded() with visible raster.
    } else {
      open(); await waitQuality(performance.now(), timeout)
      const zoom = document.querySelector<HTMLSelectElement>('select[aria-label="Zoom"]')!
      zoom.value = '1'; zoom.dispatchEvent(new Event('change', { bubbles: true }))
      await frame(); await waitQuality(performance.now(), timeout, () => true, () => zoom.value === '1')
      stages.length = 0; longTasks.length = 0
      const scroll = rootElement()!
      scroll.scrollTop = 0; scroll.scrollLeft = 0; await frame()
      if (scenario === 'reader.zoom4x') {
        const page = pages[0], initialWidth = page.getBoundingClientRect().width
        const box = page.getBoundingClientRect(), outer = scroll.getBoundingClientRect()
        const x = Math.max(box.left + 5, Math.min(box.right - 5, outer.left + outer.width / 2))
        const y = Math.max(box.top + 5, Math.min(box.bottom - 5, outer.top + outer.height / 2))
        timedStart = performance.now()
        for (let i = 0; i < 2; i++) page.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
          ctrlKey: true, clientX: x, clientY: y, deltaY: -Math.log(2) / 0.002 }))
        Object.assign(metrics, await waitQuality(timedStart, timeout,
          () => page.getBoundingClientRect().width >= initialWidth * 3.99,
          () => Math.abs(Number(zoom.value) - 4) < 0.001 && page.offsetWidth >= initialWidth * 3.99))
      } else if (scenario === 'reader.scroll') {
        const distance = Math.min(8000, scroll.scrollHeight - scroll.clientHeight), duration = 1500
        const intervals: number[] = []
        let previous = performance.now(), blankWeighted = 0, weight = 0, maxBlank = 0, peakCanvas = canvasBytes()
        timedStart = previous
        while (performance.now() - timedStart < duration) {
          await frame(); const now = performance.now(), delta = now - previous; previous = now
          scroll.scrollTop = distance * Math.min(1, (now - timedStart) / duration)
          const blank = 1 - coverage().useful
          intervals.push(delta); blankWeighted += blank * delta; weight += delta
          maxBlank = Math.max(maxBlank, blank); peakCanvas = Math.max(peakCanvas, canvasBytes()); checkError()
        }
        scroll.scrollTop = distance
        const settled = await waitQuality(performance.now(), timeout)
        Object.assign(metrics, { scrollSettleProxyMs: settled.targetQualityProxyMs, scrollDistanceCssPx: scroll.scrollTop,
          rafSampleCount: intervals.length, rafIntervalP95Ms: nearestRank(intervals, 0.95), rafIntervalMaxMs: Math.max(...intervals),
          blankAreaTimeRatio: weight ? blankWeighted / weight : null, maxBlankAreaRatio: maxBlank,
          canvasPixelBytesEstimate: Math.max(peakCanvas, canvasBytes()) })
        if (Math.abs(scroll.scrollTop - distance) > 2) throw new Error('Scroll workload did not reach the specified endpoint')
      } else throw new Error('Unknown Reader scenario')
    }
    const end = performance.now()
    Object.assign(metrics, tasks(end), { canvasPixelBytesEstimate: metrics.canvasPixelBytesEstimate ?? canvasBytes(), browserTotalRssMiB: null })
    // Wait for the actual text layer before correctness validation, outside the timing interval.
    const validationStart = performance.now()
    while (coverage().visible.some(page => !page.querySelector('.dsh-pdf-text-layer')?.textContent?.includes('PDF benchmark page'))) {
      if (performance.now() - validationStart > timeout) throw new Error('Timed out waiting for text layer')
      await frame(); checkError()
    }
    validateVisibleContent()
    if (stageOverflow) throw new Error('Performance event collector overflow')
    return { metrics, stages: stages.filter(event => event.startMs >= timedStart && event.startMs < end), qualityPassed: true }
  },
  async dispose() { root.unmount(); owner.abort(); stop(); longObserver?.disconnect(); dictionary.dispose(); await runtime.dispose() },
}
