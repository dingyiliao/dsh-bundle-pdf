import type { PageGeometry } from '../../src/modules/viewer/rendering/page-layout.js'

export interface ZoomHandoffScenario {
  name: string
  fit: 'width' | 'custom'
  zoom: number
  source: number
  deltas: number[]
  mixed?: boolean
  corner?: boolean
}

export const zoomHandoffScenarios: ZoomHandoffScenario[] = [
  { name: 'fit width to off-centre zoom on a middle page', fit: 'width', zoom: 1, source: 8, deltas: Array(6).fill(-40) },
  { name: 'custom off-centre zoom on a middle page', fit: 'custom', zoom: 1, source: 8, deltas: Array(6).fill(-40) },
  { name: 'zoom out through horizontal centering on a middle page', fit: 'custom', zoom: 2, source: 8, deltas: Array(10).fill(40) },
  { name: 'zoom out with top and horizontal scroll clamped', fit: 'custom', zoom: 2, source: 1, deltas: Array(12).fill(40) },
  { name: 'zoom out with bottom and horizontal scroll clamped', fit: 'custom', zoom: 2, source: 18, deltas: Array(12).fill(40) },
  { name: 'first fit-width gesture over mixed page dimensions', fit: 'width', zoom: 1, source: 8, mixed: true, deltas: Array(6).fill(-40) },
  { name: 'reversing a gesture over mixed page dimensions', fit: 'width', zoom: 1, source: 9, mixed: true, deltas: [-40, -40, -40, 40, 40, -40] },
  { name: 'top-left zoom with both scroll offsets remaining zero', fit: 'custom', zoom: 1, source: 1, corner: true, deltas: Array(6).fill(-40) },
]

interface Fixture {
  configure(scenario: { fit: 'width' | 'custom'; zoom: number; mixed?: boolean }): void
  state(): { fit: string; zoom: number; errors: string[] }
  layout(): readonly PageGeometry[] | null
  hold(): void
  release(): void
}

/** Runs in the browser. Samples actual page coordinates and composed coloured raster pixels. */
export async function recordWheelZoomHandoff(scenario: ZoomHandoffScenario) {
  const fixture = (window as typeof window & { __pdfWheelHandoff: Fixture }).__pdfWheelHandoff
  const root = document.querySelector<HTMLElement>('.dsh-pdf-scroll')!
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  fixture.configure(scenario)
  for (let index = 0; index < 4; index++) await frame()
  const entry = fixture.layout()?.[scenario.source - 1]
  if (!entry) throw new Error('Fixture numeric page layout did not become available')
  root.scrollTop = entry.top - 40
  root.scrollLeft = 0
  const lookup = () => root.querySelector<HTMLElement>(`[data-pdf-page="${scenario.source}"]`)
  let paper: HTMLElement | null = null
  for (let attempt = 0; attempt < 180; attempt++) {
    paper = lookup()
    const host = paper?.querySelector<HTMLElement>('.dsh-pdf-tile-surface')
    const ready = host?.dataset.pdfReadyEpoch
    const canvases = host?.querySelectorAll<HTMLCanvasElement>('canvas[data-pdf-raster-ready="true"]')
    if (ready && canvases?.length && [...canvases].every(canvas => canvas.dataset.tileEpoch === ready)) break
    if (attempt === 179) throw new Error('Fixture initial raster did not become ready')
    await frame()
  }
  if (!paper) throw new Error('Fixture anchor page is missing')
  const original = paper
  const outer = root.getBoundingClientRect(), initial = paper.getBoundingClientRect()
  const pointer = scenario.corner ? [initial.left, initial.top] : [Math.max(outer.left + 180, initial.left + 45), outer.top + 120]
  const fraction = [(pointer[0] - initial.left) / initial.width, (pointer[1] - initial.top) / initial.height]
  // Only require pixels that were already painted before the gesture. Newly
  // revealed, previously unpainted parts of a large page may legitimately load.
  const known = [...paper.querySelectorAll<HTMLCanvasElement>('canvas[data-pdf-raster-ready="true"]')].map(canvas => ({
    left: Number(canvas.dataset.tileLeft), top: Number(canvas.dataset.tileTop),
    right: Number(canvas.dataset.tileLeft) + Number(canvas.dataset.tileWidth),
    bottom: Number(canvas.dataset.tileTop) + Number(canvas.dataset.tileHeight),
  }))
  const points = [fraction, ...[.15, .5, .85].flatMap(x => [.15, .5, .85].map(y => [x, y]))]
    .filter(([x, y]) => known.some(box => x >= box.left && x < box.right && y >= box.top && y < box.bottom))
  const samples: Array<{ phase: string; x: number | null; y: number | null; present: boolean;
    sameElement: boolean; testedPixels: number; missingPixels: number; transform: string;
    left: number; top: number; width: number; height: number }> = []
  const sample = (phase: string) => {
    const current = lookup(), box = current?.getBoundingClientRect()
    const canvases = [...current?.querySelectorAll<HTMLCanvasElement>('canvas[data-pdf-raster-ready="true"]') ?? []].reverse()
    let testedPixels = 0, missingPixels = 0
    if (box) for (const [x, y] of points) {
      const sx = box.left + box.width * x, sy = box.top + box.height * y
      if (sx < outer.left + 1 || sx >= outer.right - 1 || sy < outer.top + 1 || sy >= outer.bottom - 1) continue
      testedPixels++
      let painted = false
      for (const canvas of canvases) {
        const bounds = canvas.getBoundingClientRect()
        if (!canvas.width || !canvas.height || sx < bounds.left || sx >= bounds.right || sy < bounds.top || sy >= bounds.bottom) continue
        const px = Math.min(canvas.width - 1, Math.max(0, Math.floor((sx - bounds.left) * canvas.width / bounds.width)))
        const py = Math.min(canvas.height - 1, Math.max(0, Math.floor((sy - bounds.top) * canvas.height / bounds.height)))
        const pixel = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(px, py, 1, 1).data
        if (!pixel[3]) continue
        // The controlled page contains blue stripes and no white areas.
        painted = pixel[0] < 220 && pixel[3] === 255
        break
      }
      if (!painted) missingPixels++
    }
    samples.push({ phase, x: box ? box.left + box.width * fraction[0] : null,
      y: box ? box.top + box.height * fraction[1] : null, present: !!current,
      sameElement: !!current && current === original, testedPixels, missingPixels,
      transform: root.querySelector<HTMLElement>('.dsh-pdf-windowed-pages')!.style.transform,
      left: root.scrollLeft, top: root.scrollTop, width: box?.width ?? 0, height: box?.height ?? 0 })
  }
  const sampledFrame = async (phase: string) => { await frame(); sample(phase) }
  fixture.hold()
  try {
    sample('initial')
    for (const deltaY of scenario.deltas) {
      paper.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
        deltaY, clientX: pointer[0], clientY: pointer[1] }))
      await sampledFrame('gesture')
    }
    for (let index = 0; index < 32; index++) await sampledFrame('handoff')
  } finally { fixture.release() }
  for (let index = 0; index < 15; index++) await sampledFrame('raster')
  const handoffs = samples.flatMap((sample, index) => {
    const previous = samples[index - 1]
    return previous && sample.phase === 'handoff' && sample.x !== null && sample.y !== null
      && previous.x !== null && previous.y !== null
      ? [{ x: Math.abs(sample.x - previous.x), y: Math.abs(sample.y - previous.y) }] : []
  })
  return { name: scenario.name, pointer, fraction, samples, errors: fixture.state().errors,
    maxHandoffX: Math.max(0, ...handoffs.map(point => point.x)),
    maxHandoffY: Math.max(0, ...handoffs.map(point => point.y)),
    missingFrames: samples.filter(sample => sample.testedPixels > 0 && sample.missingPixels > 0).length,
    missingPageFrames: samples.filter(sample => !sample.present).length }
}
