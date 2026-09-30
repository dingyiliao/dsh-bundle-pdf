import React, { useEffect, useRef } from 'react'
import type { PdfRect } from '../../core/pdf-types.ts'
import type { NativePage } from './document.ts'
import type { PageViewport } from '../reader-selection.ts'

interface TileJob { key: string; x: number; y: number; width: number; height: number; canvas: HTMLCanvasElement; controller: AbortController; state: 'queued' | 'running' | 'ready' }
export interface TileSurfaceProps {
  page: NativePage; viewport: PageViewport; scrollRoot: HTMLElement | null
  patchBoxes: PdfRect[]; onReady(): void; onError(message: string): void
}

/** Device-pixel tiles, with one-pixel gutters and bounded visible canvases. */
export function TileSurface(props: TileSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const callbacks = useRef(props); callbacks.current = props
  const epoch = useRef(0)
  const patchKey = JSON.stringify(props.patchBoxes)
  const { page, viewport, scrollRoot } = props
  useEffect(() => {
    const host = hostRef.current
    if (!host || !scrollRoot) return
    const currentEpoch = ++epoch.current
    const ratio = Math.min(window.devicePixelRatio || 1, 2,
      Math.sqrt(12_000_000 / (Math.min(viewport.width, scrollRoot.clientWidth + 512) * Math.min(viewport.height, scrollRoot.clientHeight + 512))))
    const rasterWidth = Math.ceil(viewport.width * ratio), rasterHeight = Math.ceil(viewport.height * ratio)
    const sx = rasterWidth / viewport.width, sy = rasterHeight / viewport.height
    const jobs = new Map<string, TileJob>()
    let running = 0, disposed = false, frame = 0
    let desired = new Set<string>()
    const old = Array.from(host.querySelectorAll<HTMLCanvasElement>('canvas'))
    // Keep cached pixels visible at the new CSS scale until replacements finish.
    for (const canvas of old) {
      if (canvas.dataset.rotation !== String(viewport.rotation) || Number(canvas.dataset.tileEpoch) < currentEpoch - 1) { canvas.remove(); canvas.width = 0; canvas.height = 0; continue }
      canvas.style.left = `${Number(canvas.dataset.tileLeft) * viewport.width}px`
      canvas.style.top = `${Number(canvas.dataset.tileTop) * viewport.height}px`
      canvas.style.width = `${Number(canvas.dataset.tileWidth) * viewport.width}px`
      canvas.style.height = `${Number(canvas.dataset.tileHeight) * viewport.height}px`
    }
    const retire = (job: TileJob) => { job.controller.abort(); job.canvas.remove(); job.canvas.width = 0; job.canvas.height = 0; jobs.delete(job.key) }
    const complete = () => {
      if (!desired.size || [...desired].some(key => jobs.get(key)?.state !== 'ready')) return
      for (const canvas of old) { canvas.remove(); canvas.width = 0; canvas.height = 0 }
      callbacks.current.onReady()
    }
    const pump = () => {
      if (disposed) return
      for (const job of jobs.values()) {
        if (running >= 3) break
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
          if (!controller.signal.aborted && !disposed) callbacks.current.onError(String(error))
          if (jobs.get(job.key) === job) retire(job)
        }).finally(() => { running--; pump() })
      }
    }
    const reconcile = () => {
      frame = 0
      if (disposed) return
      const box = host.getBoundingClientRect(), root = scrollRoot.getBoundingClientRect()
      const left = Math.max(0, (root.left - box.left - 256) * sx), right = Math.min(rasterWidth, (root.right - box.left + 256) * sx)
      const top = Math.max(0, (root.top - box.top - 256) * sy), bottom = Math.min(rasterHeight, (root.bottom - box.top + 256) * sy)
      desired = new Set()
      if (right <= left || bottom <= top) { for (const job of jobs.values()) retire(job); return }
      const coords: { x: number; y: number }[] = []
      for (let y = Math.floor(top / 512) * 512; y < bottom; y += 512) for (let x = Math.floor(left / 512) * 512; x < right; x += 512) coords.push({ x, y })
      coords.sort((a, b) => Math.hypot(a.x - (left + right) / 2, a.y - (top + bottom) / 2) - Math.hypot(b.x - (left + right) / 2, b.y - (top + bottom) / 2))
      for (const { x, y } of coords) {
        const key = `${x}:${y}`; desired.add(key)
        if (jobs.has(key)) continue
        const width = Math.min(512, rasterWidth - x), height = Math.min(512, rasterHeight - y)
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        canvas.style.cssText = `position:absolute;left:${x / sx}px;top:${y / sy}px;width:${width / sx}px;height:${height / sy}px`
        Object.assign(canvas.dataset, { pdfTile: 'true', tileEpoch: String(currentEpoch), rotation: String(viewport.rotation),
          tileLeft: String(x / rasterWidth), tileTop: String(y / rasterHeight), tileWidth: String(width / rasterWidth), tileHeight: String(height / rasterHeight) })
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
  }, [page, viewport.width, viewport.height, viewport.rotation, viewport.scale, scrollRoot, patchKey])
  useEffect(() => {
    const host = hostRef.current
    return () => { for (const canvas of host?.querySelectorAll('canvas') ?? []) { canvas.width = 0; canvas.height = 0 } }
  }, [])
  return <div ref={hostRef} className="dsh-pdf-tile-surface" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} data-reader-engine="native" />
}
