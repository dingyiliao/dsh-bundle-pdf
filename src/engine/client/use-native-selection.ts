import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject, type PointerEvent } from 'react'
import type { PageView, ReaderSelection } from '../../client/viewer/index.js'
import type { createSelectionPages } from './selection-pages.js'
import { resolveSelection, selectionOnPage, type SelectionEndpoint, type SelectionPage } from './selection.js'

type Pages = ReturnType<typeof createSelectionPages>
type Fragment = ReaderSelection['fragments'][number]
type Point = { page: number; x: number; y: number; tolerance: number }
type Range = { anchor: SelectionEndpoint; focus: SelectionEndpoint }
type Drag = {
  root: HTMLDivElement
  pages: Pages
  revision: number
  pointerId: number
  start: Point
  anchor?: SelectionEndpoint
  focus?: SelectionEndpoint
  x: number
  y: number
  moved: boolean
  pendingPage?: number
  preview: ReadonlyMap<number, Fragment>
}
const noFragments: ReadonlyMap<number, Fragment> = new Map()
const interactive = 'button,a,input,textarea,select,summary,[contenteditable="true"]'
const selectionKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

function pdfPoint(element: EventTarget | null, x: number, y: number, views: Map<number, PageView>): Point | undefined {
  if (!(element instanceof Element) || element.closest(interactive)) return
  const surface = element.closest<HTMLElement>('[data-pdf-page]')
  const page = Number(surface?.dataset.pdfPage)
  const view = views.get(page)
  if (!view || surface !== view.element) return
  const bounds = surface.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return
  const [pdfX, pdfY] = view.viewport.convertToPdfPoint(
    (x - bounds.left) * view.viewport.width / bounds.width,
    (y - bounds.top) * view.viewport.height / bounds.height,
  )
  return { page, x: pdfX, y: pdfY, tolerance: Math.min(16, 6 / view.viewport.scale / view.viewport.userUnit) }
}

function dragPoint(current: Drag, views: Map<number, PageView>): Point | undefined {
  const { root, x, y } = current
  const bounds = root.getBoundingClientRect()
  if (x < bounds.left || x >= bounds.right || bounds.height < 2) return
  const insideY = Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, y))
  const element = root.ownerDocument.elementFromPoint(x, insideY)
  return pdfPoint(element, x, insideY, views)
}

/** Only edge motion while selecting drives continuous frames. */
function scrollDrag(current: Drag): -1 | 0 | 1 {
  const { root, x, y } = current
  const bounds = root.getBoundingClientRect()
  if (x < bounds.left || x >= bounds.right) return 0
  const edge = Math.min(36, bounds.height / 4)
  const distance = y < bounds.top + edge ? y - bounds.top - edge
    : Math.max(0, y - bounds.bottom + edge)
  if (!distance) return 0
  const before = root.scrollTop
  root.scrollTop += Math.sign(distance) * Math.min(24, Math.ceil(Math.abs(distance) / 3))
  return root.scrollTop < before ? -1 : root.scrollTop > before ? 1 : 0
}

export function useNativeSelection(options: {
  pages: Pages | undefined
  views: MutableRefObject<Map<number, PageView>>
  revision: number | undefined
  visiblePage: number
  pageCount?: number
  hasMappedOcr?: boolean
  active: boolean
  canSelect(revision: number): boolean
  onRevealPage?(page: number, direction: -1 | 1): void
  onSelect(selection: ReaderSelection | null): void
  onError(error: unknown): void
}) {
  const [fallbackOwner, setFallbackOwner] = useState<Pages>()
  const [touchInput] = useState(() => !!globalThis.matchMedia?.('(pointer: coarse)').matches)
  const [preview, setPreview] = useState(noFragments)
  const [semantic, setSemantic] = useState<{ owner: Pages; revision: number; page: number; text: string }>()
  const drag = useRef<Drag>()
  const caret = useRef<Range>()
  const frame = useRef(0)
  const generation = useRef(0)
  const keyboard = useRef(Promise.resolve())
  const { pages, revision, active, visiblePage } = options
  const enabled = !!pages && options.canSelect(revision ?? -1) && fallbackOwner !== pages && !options.hasMappedOcr && !touchInput
  const latest = useRef({ ...options, enabled })
  latest.current = { ...options, enabled }

  function cancel() {
    generation.current++
    caret.current = undefined
    drag.current = undefined
    keyboard.current = Promise.resolve()
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = 0
    setPreview(noFragments)
  }
  useEffect(() => {
    cancel()
    return () => {
      generation.current++
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
      drag.current = undefined
    }
  }, [pages, revision, active, enabled])

  function isCurrent(token: number, owner: Pages, ownerRevision: number) {
    const now = latest.current
    return generation.current === token && now.enabled && now.active && now.pages === owner && now.revision === ownerRevision
      && now.canSelect(ownerRevision)
  }

  function fallback(token: number, owner: Pages, ownerRevision: number) {
    if (!isCurrent(token, owner, ownerRevision)) return
    cancel()
    latest.current.onSelect(null)
    setFallbackOwner(owner)
  }

  async function load(token: number, owner: Pages, ownerRevision: number, page: number) {
    try {
      const data = await owner.load(page)
      if (isCurrent(token, owner, ownerRevision)) {
        if (!data) fallback(token, owner, ownerRevision)
        return data ?? undefined
      }
    } catch {
      // The legacy layer handles text when the native geometry command cannot serve it.
      fallback(token, owner, ownerRevision)
    }
  }

  useEffect(() => {
    if (!pages || !active || revision === undefined) return
    // Scroll first. Preparing one current page after a pause gives assistive
    // technology semantic text even when browse-only zoom disables selection,
    // without scheduling text work for every raster page.
    let disposed = false
    const timer = setTimeout(() => {
      void pages.load(visiblePage).then(data => {
        if (!disposed && latest.current.pages === pages
          && latest.current.revision === revision && data) {
          setSemantic({ owner: pages, revision, page: data.page, text: data.text })
        }
      }).catch(error => { if (!disposed && latest.current.pages === pages && latest.current.revision === revision) latest.current.onError(error) })
    }, 160)
    return () => { disposed = true; clearTimeout(timer) }
  }, [pages, revision, active, visiblePage])

  async function finish(token: number, owner: Pages, ownerRevision: number, anchor: SelectionEndpoint, focus: SelectionEndpoint) {
    const first = Math.min(anchor.page, focus.page), last = Math.max(anchor.page, focus.page)
    // Avoid an unbounded series of geometry reads for a single gesture.
    if (last - first >= 32) { fallback(token, owner, ownerRevision); return }
    const loaded = new Map<number, SelectionPage>()
    for (let page = first; page <= last; page++) {
      if (!isCurrent(token, owner, ownerRevision)) return
      const data = await load(token, owner, ownerRevision, page)
      if (!data) return
      loaded.set(page, data)
    }
    if (!isCurrent(token, owner, ownerRevision)) return
    caret.current = { anchor, focus }
    latest.current.onSelect(resolveSelection(anchor, focus, page => loaded.get(page), ownerRevision))
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!pages || revision === undefined || !enabled || !active || event.button !== 0
      || !options.canSelect(revision)) return
    if (event.pointerType === 'touch') { fallback(generation.current, pages, revision); return }
    const previous = event.shiftKey ? caret.current?.anchor : undefined
    cancel()
    const start = pdfPoint(event.target, event.clientX, event.clientY, options.views.current)
    if (!start) return
    const token = generation.current
    const current: Drag = { root: event.currentTarget, pages, revision, start, anchor: previous, pointerId: event.pointerId,
      x: event.clientX, y: event.clientY, moved: false, preview: noFragments }
    drag.current = current
    void load(token, pages, revision, start.page).then(data => {
      if (data && drag.current === current) {
        current.anchor ??= data.hit(start.x, start.y, start.tolerance) ?? undefined
        if (current.moved) queueDrag(current, token)
      }
    })
  }

  function queueDrag(current: Drag, token: number) {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      if (drag.current !== current || !isCurrent(token, current.pages, current.revision)) return
      const direction = scrollDrag(current)
      const views = latest.current.views.current
      const point = dragPoint(current, views)
      if (point) {
        const end = current.pages.get(point.page)
        if (!end && current.pendingPage !== point.page) {
          current.pendingPage = point.page
          void load(token, current.pages, current.revision, point.page).then(data => {
            if (data && drag.current === current) queueDrag(current, token)
          }).finally(() => {
            if (current.pendingPage === point.page) current.pendingPage = undefined
          })
        }
        const hit = end?.hit(point.x, point.y, point.tolerance)
        if (hit) current.focus = hit
        else if (end && direction) current.focus = { page: end.page, offset: direction > 0 ? end.text.length : 0 }
      }
      const { anchor, focus } = current
      if (anchor && focus) {
        const visible = new Map<number, Fragment>()
        for (const [page] of views) {
          if (page < Math.min(anchor.page, focus.page) || page > Math.max(anchor.page, focus.page)) continue
          const data = current.pages.get(page)
          const fragment = data && selectionOnPage(anchor, focus, data)
          if (fragment) visible.set(page, fragment)
        }
        // A held pointer can leave both endpoints unchanged while pages scroll.
        if (visible.size !== current.preview.size || [...visible].some(([page, fragment]) => current.preview.get(page) !== fragment)) {
          current.preview = visible
          setPreview(visible)
        }
      }
      if (direction) queueDrag(current, token)
    })
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    if (!current.moved) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 3) return
      current.moved = true
      current.root.setPointerCapture?.(event.pointerId)
    }
    current.x = event.clientX
    current.y = event.clientY
    queueDrag(current, generation.current)
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    current.x = event.clientX
    current.y = event.clientY
    drag.current = undefined
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = 0
    const token = generation.current
    const point = current.moved ? dragPoint(current, latest.current.views.current) : current.start
    const run = async () => {
      const first = await load(token, current.pages, current.revision, current.start.page)
      if (!first) return
      const anchor = current.anchor ?? first.hit(current.start.x, current.start.y, current.start.tolerance)
      if (!anchor) return
      const last = point && await load(token, current.pages, current.revision, point.page)
      // Releasing in a margin or between pages commits the last displayed range.
      const focus = (point && last?.hit(point.x, point.y, point.tolerance)) || current.focus
      if (focus) await finish(token, current.pages, current.revision, anchor, focus)
    }
    void run().catch(error => {
      if (isCurrent(token, current.pages, current.revision)) latest.current.onError(error)
    }).finally(() => { if (generation.current === token) setPreview(noFragments) })
  }

  function onDoubleClick(event: MouseEvent<HTMLDivElement>) {
    if (!pages || revision === undefined || !enabled || !active || event.button !== 0 || !options.canSelect(revision)) return
    const point = pdfPoint(event.target, event.clientX, event.clientY, options.views.current)
    if (!point) return
    cancel()
    const token = generation.current
    void load(token, pages, revision, point.page).then(data => {
      const hit = data?.hit(point.x, point.y, point.tolerance)
      const word = hit && data?.word(hit.glyphOffset)
      if (word) return finish(token, pages, revision, ...word)
    }).catch(error => { if (isCurrent(token, pages, revision)) latest.current.onError(error) })
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const { key, shiftKey, altKey, ctrlKey, metaKey } = event
    const range = caret.current
    const collapse = range && (range.anchor.page !== range.focus.page || range.anchor.offset !== range.focus.offset)
    if (!pages || revision === undefined || !enabled || !active || drag.current || altKey || ctrlKey || metaKey
      || !selectionKeys.has(key) || (!shiftKey && (!collapse || (key !== 'ArrowLeft' && key !== 'ArrowRight')))
      || !options.canSelect(revision)) return
    event.preventDefault()
    const token = generation.current
    const run = async () => {
      if (!isCurrent(token, pages, revision)) return
      const from = caret.current?.focus ?? { page: latest.current.visiblePage, offset: 0 }
      const direction = key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home' ? -1 : 1
      const committed = caret.current
      if (!shiftKey && committed) {
        const { anchor, focus } = committed
        const forward = anchor.page < focus.page || anchor.page === focus.page && anchor.offset < focus.offset
        const edge = forward === (direction < 0) ? anchor : focus
        caret.current = { anchor: edge, focus: edge }
        latest.current.onSelect(null)
        return
      }
      const data = await load(token, pages, revision, from.page)
      if (!data) return
      const vertical = key === 'ArrowUp' || key === 'ArrowDown'
      const edge = key === 'Home' || key === 'End'
      let to = edge ? data.lineEdge(from.offset, direction)
        : vertical ? data.adjacentLine(from.offset, direction) : data.step(from.offset, direction)
      const adjacent = from.page + direction
      if (!edge && (!to || to.offset === from.offset) && adjacent > 0 && adjacent <= (latest.current.pageCount ?? 0)) {
        const next = await load(token, pages, revision, adjacent)
        if (!next) return
        to = { page: adjacent, offset: direction < 0 ? next.text.length : 0 }
      }
      if (!to || !isCurrent(token, pages, revision)) return
      const anchor = shiftKey ? caret.current?.anchor ?? from : to
      await finish(token, pages, revision, anchor, to)
      if (to.page !== from.page && isCurrent(token, pages, revision)) latest.current.onRevealPage?.(to.page, direction)
    }
    keyboard.current = keyboard.current.then(run).catch(error => {
      if (isCurrent(token, pages, revision)) latest.current.onError(error)
    })
  }

  return { enabled, preview, semantic: semantic?.owner === pages && semantic?.revision === revision && semantic?.page === visiblePage ? semantic : undefined,
    onPointerDown, onPointerMove, onPointerUp, onDoubleClick, onKeyDown, cancel }
}
