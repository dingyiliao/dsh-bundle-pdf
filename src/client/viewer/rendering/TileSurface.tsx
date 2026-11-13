import { useEffect, useRef } from 'react'
import type { PdfRect } from '../../../core/pdf-types.ts'
import type { NativePage } from './document.ts'
import type { PageViewport } from '../model/reader-selection.js'

interface TileJob { key: string; x: number; y: number; width: number; height: number; canvas: HTMLCanvasElement; controller: AbortController; state: 'queued' | 'running' | 'ready' }
export interface TileSurfaceProps {
  page: NativePage; viewport: PageViewport; scrollRoot: HTMLElement | null
  scrollPreview?: boolean
  patchBoxes: PdfRect[]; onReady(): void; onError(message: string): void
}

/** Device-pixel tiles, with one-pixel gutters and bounded visible canvases. */
export function TileSurface(props: TileSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const callbacks = useRef(props); callbacks.current = props
  const epoch = useRef(0)
  const patchKey = JSON.stringify(props.patchBoxes)
  const { page, viewport, scrollRoot, scrollPreview } = props
  useEffect(() => {
    const host = hostRef.current
    if (!host || !scrollRoot) return
    const currentEpoch = ++epoch.current
    // At preview resolution a single large tile can cover a typical page.
    const tileSize = scrollPreview ? 1024 : 768
    const ratio = Math.min(window.devicePixelRatio || 1, scrollPreview ? 0.75 : 2,
      Math.sqrt(12_000_000 / (Math.min(viewport.width, scrollRoot.clientWidth + 512) * Math.min(viewport.height, scrollRoot.clientHeight + 512))))
    const rasterWidth = Math.ceil(viewport.width * ratio), rasterHeight = Math.ceil(viewport.height * ratio)
    const sx = rasterWidth / viewport.width, sy = rasterHeight / viewport.height
    const margin = scrollPreview ? 0 : 256
    const jobs = new Map<string, TileJob>()
    let running = 0, disposed = false, frame = 0
    let desired = new Set<string>()
    const canvases = Array.from(host.querySelectorAll<HTMLCanvasElement>('canvas'))
    // A resize can start several raster epochs before any of them finishes.
    // Retain the last *complete* frame, not merely the preceding epoch: the
    // latter may contain only a few tiles and would expose a white page.
    const readyEpoch = Number(host.dataset.pdfReadyEpoch)
    const fallbackEpoch = canvases.some(canvas => Number(canvas.dataset.tileEpoch) === readyEpoch)
      ? readyEpoch : Math.max(-1, ...canvases.map(canvas => Number(canvas.dataset.tileEpoch)))
    const old: HTMLCanvasElement[] = []
    for (const canvas of canvases) {
      if (canvas.dataset.rotation !== String(viewport.rotation) || Number(canvas.dataset.tileEpoch) !== fallbackEpoch) {
        canvas.remove(); canvas.width = 0; canvas.height = 0; continue
      }
      old.push(canvas)
    }
    const retire = (job: TileJob) => { job.controller.abort(); job.canvas.remove(); job.canvas.width = 0; job.canvas.height = 0; jobs.delete(job.key) }
    let committed = false
    const complete = () => {
      if (committed) return
      if (!desired.size || [...desired].some(key => jobs.get(key)?.state !== 'ready')) return
      committed = true
      for (const canvas of old) { canvas.remove(); canvas.width = 0; canvas.height = 0 }
      host.dataset.pdfReadyEpoch = String(currentEpoch)
      callbacks.current.onReady()
    }
    const pump = () => {
      if (disposed) return
      for (const job of jobs.values()) {
        if (running >= (scrollPreview ? 1 : 3)) break
        if (job.state !== 'queued' || !desired.has(job.key)) continue
        job.state = 'running'; running++
        const controller = job.controller
        void (async () => {
          const request = { rotation: (viewport.rotation - page.rotate + 360) % 360, rasterWidth, rasterHeight,
            x: job.x - 1, y: job.y - 1, width: job.width + 2, height: job.height + 2 }
          const image = await page.tile({ ...request, annotations: true }, controller.signal)
          controller.signal.throwIfAborted()
          const context = job.canvas.getContext('2d')!
          context.drawImage(image, 1, 1, job.width, job.height, 0, 0, job.width, job.height)
          const intersecting = callbacks.current.patchBoxes.filter(([l, t, r, b]) => r * sx > job.x && l * sx < job.x + job.width && b * sy > job.y && t * sy < job.y + job.height)
          if (intersecting.length) {
            const clean = await page.tile({ ...request, annotations: false }, controller.signal)
            controller.signal.throwIfAborted()
            context.save(); context.beginPath()
            for (const [l, t, r, b] of intersecting) context.rect(l * sx - job.x, t * sy - job.y, (r - l) * sx, (b - t) * sy)
            context.clip(); context.drawImage(clean, 1, 1, job.width, job.height, 0, 0, job.width, job.height); context.restore()
          }
          job.state = 'ready'
          job.canvas.dataset.pdfRasterReady = 'true'
          job.canvas.dataset.pdfRasterScale = String(viewport.scale * ratio)
          host.append(job.canvas)
          complete()
        })().catch(error => {
          if (!controller.signal.aborted && !page.owner.lifetime.signal.aborted && !disposed) callbacks.current.onError(String(error))
          if (jobs.get(job.key) === job) retire(job)
        }).finally(() => { running--; pump() })
      }
    }
    const reconcile = () => {
      frame = 0
      if (disposed) return
      const box = host.getBoundingClientRect(), root = scrollRoot.getBoundingClientRect()
      desired = new Set()
      if (box.width <= 0 || box.height <= 0) { for (const job of jobs.values()) retire(job); return }
      // A divider resize can stretch the painted raster before a new scale is committed.
      const scaleX = rasterWidth / box.width, scaleY = rasterHeight / box.height
      const left = Math.max(0, (root.left - box.left - margin) * scaleX), right = Math.min(rasterWidth, (root.right - box.left + margin) * scaleX)
      const top = Math.max(0, (root.top - box.top - margin) * scaleY), bottom = Math.min(rasterHeight, (root.bottom - box.top + margin) * scaleY)
      if (right <= left || bottom <= top) { for (const job of jobs.values()) retire(job); return }
      const coords: { x: number; y: number }[] = []
      for (let y = Math.floor(top / tileSize) * tileSize; y < bottom; y += tileSize) for (let x = Math.floor(left / tileSize) * tileSize; x < right; x += tileSize) coords.push({ x, y })
      coords.sort((a, b) => Math.hypot(a.x - (left + right) / 2, a.y - (top + bottom) / 2) - Math.hypot(b.x - (left + right) / 2, b.y - (top + bottom) / 2))
      for (const { x, y } of coords) {
        const key = `${x}:${y}`; desired.add(key)
        if (jobs.has(key)) continue
        const width = Math.min(tileSize, rasterWidth - x), height = Math.min(tileSize, rasterHeight - y)
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        canvas.style.cssText = `position:absolute;left:${100 * x / rasterWidth}%;top:${100 * y / rasterHeight}%;width:${100 * width / rasterWidth}%;height:${100 * height / rasterHeight}%`
        Object.assign(canvas.dataset, { pdfTile: 'true', tileEpoch: String(currentEpoch), rotation: String(viewport.rotation) })
        canvas.setAttribute('aria-hidden', 'true')
        jobs.set(key, { key, x, y, width, height, canvas, controller: new AbortController(), state: 'queued' })
      }
      for (const job of jobs.values()) if (!desired.has(job.key)) retire(job)
      complete(); pump()
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(reconcile) }
    scrollRoot.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule); observer.observe(scrollRoot)
    reconcile()
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); scrollRoot.removeEventListener('scroll', schedule)
      for (const job of jobs.values()) {
        job.controller.abort()
        if (job.state !== 'ready') { job.canvas.width = 0; job.canvas.height = 0 }
      }
    }
  }, [page, viewport.width, viewport.height, viewport.rotation, viewport.scale, scrollRoot, patchKey, scrollPreview])
  useEffect(() => {
    const host = hostRef.current
    return () => { for (const canvas of host?.querySelectorAll('canvas') ?? []) { canvas.width = 0; canvas.height = 0 } }
  }, [])
  return <div ref={hostRef} className="dsh-pdf-tile-surface" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />
}
