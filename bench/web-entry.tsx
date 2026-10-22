/** Isolated test adapter. This entry is never included in the shipped plugin. */
import { createRoot } from 'react-dom/client'
import { Reader } from '../src/client/Reader.tsx'
import { createPdfApi } from '../src/adapters/client/remote/pdf-api.ts'
import { readerLocales } from '../src/modules/viewer/index.js'
import { createTranslationRegistry } from '../src/translation/index.ts'
import { defaultSettings } from '../src/shared/contracts.ts'
import { observePdfPerformance, type PdfPerformanceEvent } from '../src/shared/performance.ts'
import styles from '../src/client/reader.css'
import { pageIndexAtOffset, windowLayout } from '../src/modules/viewer/index.ts'

interface Config { sessionId: string; token: string; pages: number; annotations: number }
interface Payload { metrics: Record<string, number | null>; stages: PdfPerformanceEvent[]; qualityPassed: boolean }
interface Hook { run(scenario: string, timeout: number): Promise<Payload>; snapshot(): unknown; dispose(): Promise<void> }
declare global { interface Window { __PDF_BENCH_CONFIG__: Config; __PDF_BENCH__: Hook } }

const config = window.__PDF_BENCH_CONFIG__
const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
const owner = new AbortController(), root = createRoot(document.getElementById('root')!)
const stages: PdfPerformanceEvent[] = []
let stageOverflow = false
const stop = observePdfPerformance(event => { if (stages.length >= 2000) { stageOverflow = true; return }; stages.push(event) })
const api = createPdfApi({ rpc: { async call(_path, method, payload, signal) {
  const response = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bench-token': config.token },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }), signal })
  if (!response.ok) throw new Error(`Benchmark RPC HTTP ${response.status}`)
  let envelope: any
  if (response.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const form = await response.formData()
    envelope = JSON.parse(String(form.get('metadata')))
    const blob = form.get('pdf-bytes')
    if (!(blob instanceof Blob)) throw new Error('Missing benchmark binary attachment')
    envelope.result.value.bytes = new Uint8Array(await blob.arrayBuffer())
  } else envelope = await response.json()
  const result = envelope.result
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
    scrollportRef={() => {}} useTabInfo={() => ({ tab: { id: config.sessionId, visible: true, signal: owner.signal, actions: { openResource() {} } } })}
    t={t} api={api} hostOcr={{
      availability: async () => ({ status: 'unavailable', reason: 'OCR is outside the reader benchmark.' }),
      recognize: async () => { throw new Error('OCR is outside the reader benchmark.') },
    }} imageUnderstanding={{
      availability: async () => ({ status: 'unavailable', reason: 'Image understanding is outside the reader benchmark.' }),
      prepare: async () => { throw new Error('Image understanding is outside the reader benchmark.') },
      prepareReference: async () => { throw new Error('Image understanding is outside the reader benchmark.') },
    }} translation={createTranslationRegistry({ timeoutMs: 600000, maxInputCharacters: 8192, maxOutputCharacters: 32768 })}
    settings={defaultSettings} />)
}

function rootElement() { return document.querySelector<HTMLElement>('.dsh-pdf-scroll') }
let pages: HTMLElement[] = []
function coverage() {
  const scroll = rootElement()
  if (!scroll) return { useful: 0, quality: 0, visible: [] as HTMLElement[] }
  pages = [...scroll.querySelectorAll<HTMLElement>('[data-pdf-page]')].sort((a, b) => Number(a.dataset.pdfPage) - Number(b.dataset.pdfPage))
  const bounds = scroll.getBoundingClientRect()
  const numeric = windowLayout(scroll)
  let expectedArea = 0
  if (numeric?.length) {
    for (let index = pageIndexAtOffset(numeric, scroll.scrollTop); index < numeric.length; index++) {
      const item = numeric[index], top = bounds.top + item.top + 27 - scroll.scrollTop
      if (top >= bounds.bottom) break
      const left = bounds.left + (scroll.scrollWidth - item.width) / 2 - scroll.scrollLeft
      expectedArea += Math.max(0, Math.min(bounds.right, left + item.width) - Math.max(bounds.left, left))
        * Math.max(0, Math.min(bounds.bottom, top + item.height) - Math.max(bounds.top, top))
    }
  }
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
    const expectedDpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(24_000_000 / (page.clientWidth * page.clientHeight)))
    const canvases = [...page.querySelectorAll<HTMLCanvasElement>('.dsh-pdf-canvas canvas')]
    const rectangles: { left: number; top: number; right: number; bottom: number; quality: boolean }[] = []
    for (const canvas of canvases) {
      if (canvas.dataset.pdfRasterReady !== 'true' || !canvas.width || !canvas.height) continue
      const rect = canvas.getBoundingClientRect(), left = Math.max(bounds.left, box.left, rect.left), right = Math.min(bounds.right, box.right, rect.right)
      const top = Math.max(bounds.top, box.top, rect.top), bottom = Math.min(bounds.bottom, box.bottom, rect.bottom)
      if (right > left && bottom > top) rectangles.push({ left, right, top, bottom,
        quality: !page.style.transform && canvas.width / rect.width >= expectedDpr * .99 && canvas.height / rect.height >= expectedDpr * .99 })
    }
    // A rectangle union counts overlapping retained zoom generations exactly once.
    const union = (rects: typeof rectangles) => {
      const xs = [...new Set(rects.flatMap(r => [r.left, r.right]))].sort((a, b) => a - b)
      let sum = 0
      for (let x = 0; x + 1 < xs.length; x++) {
        const intervals = rects.filter(r => r.left <= xs[x] && r.right >= xs[x + 1]).map(r => [r.top, r.bottom]).sort((a, b) => a[0] - b[0])
        let length = 0, end = -Infinity
        for (const [top, bottom] of intervals) { length += Math.max(0, bottom - Math.max(top, end)); end = Math.max(end, bottom) }
        sum += length * (xs[x + 1] - xs[x])
      }
      return sum
    }
    useful += union(rectangles); quality += union(rectangles.filter(r => r.quality))
  }
  return { useful: expectedArea ? Math.min(1, useful / expectedArea) : 0, quality: expectedArea ? Math.min(1, quality / expectedArea) : 0, visible }
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
async function selectZoom100(timeout: number) {
  const menu = document.querySelector<HTMLDetailsElement>('.dsh-pdf-toolbar-zoom')
  const trigger = menu?.querySelector<HTMLElement>('summary')
  const preset = [...(menu?.querySelectorAll<HTMLButtonElement>('.dsh-pdf-zoom-menu button') ?? [])]
    .find(button => button.textContent?.trim() === '100%')
  if (!trigger || !preset) throw new Error('The Reader 100% zoom control is unavailable')
  trigger.click(); preset.click()
  await frame()
  await waitQuality(performance.now(), timeout,
    () => trigger.getAttribute('aria-label')?.endsWith('100%') === true,
    () => trigger.getAttribute('aria-label')?.endsWith('100%') === true)
}
function searchPanel() {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('.dsh-pdf-sidebar-tab')]
    .find(button => button.getAttribute('aria-label') === t('reader.sidebar.search'))
  if (!tab) throw new Error('The Reader search tab is unavailable')
  tab.click()
  const panel = document.querySelector<HTMLElement>('.dsh-pdf-search-panel')
  const form = panel?.querySelector<HTMLFormElement>('form')
  const input = form?.querySelector<HTMLInputElement>('input')
  if (!panel || !form || !input) throw new Error('The Reader search form is unavailable')
  return { panel, form, input }
}
async function prepareSearch(timeout: number) {
  const { panel, form, input } = searchPanel()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('The native search input setter is unavailable')
  setter.call(input, 'zz_pdf_benchmark_no_match_187')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const start = performance.now()
  while (performance.now() - start < timeout) {
    await frame()
    if (form.querySelector<HTMLButtonElement>('button:not([disabled])')) return { panel, form }
  }
  throw new Error('The Reader search form did not accept the benchmark query')
}
async function submitAndWaitForSearch(panel: HTMLElement, form: HTMLFormElement, timeout: number) {
  form.requestSubmit()
  // A prior warm-up may leave the previous result visible until React commits
  // the new search state, so cross one frame before checking the terminal UI.
  await frame()
  const start = performance.now()
  while (performance.now() - start < timeout) {
    await frame(); checkError()
    const button = form.querySelector<HTMLButtonElement>('button')
    if (!button?.disabled && panel.textContent?.includes(t('reader.noResults')) &&
      !panel.textContent?.includes(t('reader.searching'))) return
  }
  throw new Error('Timed out waiting for the complete no-hit search result')
}
function validateVisibleContent() {
  const mounted = document.querySelectorAll('.dsh-pdf-windowed-page').length
  if (config.pages >= 64 && mounted > 12) throw new Error('Reader mounted too many page wrappers')
  const visible = coverage().visible
  if (!visible.length) throw new Error('No visible PDF page')
  const probe = document.createElement('canvas'); probe.width = 64; probe.height = 64
  const ctx = probe.getContext('2d')!
  for (const page of visible) {
    const canvases = [...page.querySelectorAll<HTMLCanvasElement>('.dsh-pdf-canvas canvas')].filter(canvas => canvas.dataset.pdfRasterReady === 'true')
    ctx.clearRect(0, 0, 64, 64)
    for (const canvas of canvases) {
      const rect = canvas.getBoundingClientRect(), box = page.getBoundingClientRect()
      ctx.drawImage(canvas, (rect.left - box.left) / box.width * 64, (rect.top - box.top) / box.height * 64, rect.width / box.width * 64, rect.height / box.height * 64)
    }
    const pixels = ctx.getImageData(0, 0, 64, 64).data
    let ink = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 230) ink++
    if (scenarioValidation !== 'reader.zoom4x' && ink < 5) throw new Error('Completed canvas is blank')
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

let scenarioValidation = ''
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
    scenarioValidation = scenario
    if (opened) throw new Error('One scenario per fresh browser context')
    const metrics: Record<string, number | null> = {}
    if (scenario === 'reader.open') {
      timedStart = performance.now(); open()
      Object.assign(metrics, await waitQuality(timedStart, timeout))
      // Text is checked after timing; never equate content.loaded() with visible raster.
    } else {
      open(); await waitQuality(performance.now(), timeout)
      await selectZoom100(timeout)
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
          () => document.querySelector('.dsh-pdf-toolbar-zoom summary')?.getAttribute('aria-label')?.endsWith('400%') === true
            && page.offsetWidth >= initialWidth * 3.99))
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
      } else if (scenario === 'reader.search-cold' || scenario === 'reader.search-warm') {
        const { panel, form } = await prepareSearch(timeout)
        if (scenario === 'reader.search-warm') await submitAndWaitForSearch(panel, form, timeout)
        stages.length = 0; longTasks.length = 0
        timedStart = performance.now()
        await submitAndWaitForSearch(panel, form, timeout)
        metrics.searchCompleteMs = performance.now() - timedStart
        metrics.searchResultCount = document.querySelectorAll('.dsh-pdf-search-hit').length
        if (metrics.searchResultCount !== 0) throw new Error('No-hit search unexpectedly returned results')
      } else throw new Error('Unknown Reader scenario')
    }
    const end = performance.now()
    Object.assign(metrics, tasks(end), { canvasPixelBytesEstimate: metrics.canvasPixelBytesEstimate ?? canvasBytes(), browserTotalRssMiB: null,
      mountedPageWrappers: document.querySelectorAll('.dsh-pdf-windowed-page').length, domNodes: document.querySelectorAll('*').length })
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
  async dispose() { root.unmount(); owner.abort(); stop(); longObserver?.disconnect() },
}
