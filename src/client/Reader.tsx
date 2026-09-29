import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnnotationMode, type PDFDocumentProxy } from 'pdfjs-dist'
import type { NewPdfAnnotation, PdfAnnotationOperation, PdfPageInfo, PdfRect } from '../core/pdf-types.js'
import type { NavigationPosition } from '../navigation/index.js'
import { mapImageBoxToPdf, mapResultToPdf } from '../ocr/mapping.js'
import type { WorkspaceSnapshot } from '../shared/contracts.js'
import type { ReaderProps } from './contracts.js'
import { Page } from './Page.js'
import { captureTextSelection, colorFromHex, colorToHex, pdfRectToViewport, overlapFraction, type PageView, type ReaderSelection } from './reader-selection.js'
import { readerLifetime, type OcrPage } from './reader-lifetime.js'
import { joinSearchText } from './reader-search.js'

interface SearchHit { page: number; text: string; x: number; y: number; source: 'native' | 'ocr' }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

export function Reader(props: ReaderProps) {
  const { api, t, settings, sessionId } = props
  const { tab } = props.useTabInfo()
  const lifetime = readerLifetime(sessionId, tab.id, tab.signal, settings.historyCapacity)
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [displayOwner, setDisplayOwner] = useState<{ token: number; content: ReaderProps['content'] } | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 600, height: 700 })
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState<'custom' | 'width' | 'page'>('width')
  const [rotation, setRotation] = useState(0)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [mode, setMode] = useState<'text' | 'region' | 'note'>('text')
  const [selection, setSelection] = useState<ReaderSelection | null>(null)
  const [color, setColor] = useState(settings.defaultColor)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [selectedAnnotation, setSelectedAnnotation] = useState<string>()
  const [pendingNote, setPendingNote] = useState<NewPdfAnnotation | null>(null)
  const [comment, setComment] = useState('')
  const [commentColor, setCommentColor] = useState(settings.defaultColor)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [ocrPages, setOcrPages] = useState<Map<number, OcrPage>>(() => lifetime.ocrPages)
  const [ocrProgress, setOcrProgress] = useState<string | null>(null)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [savePath, setSavePath] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [target, setTarget] = useState<{ path: string; version: string | null } | null>(null)
  const [targetChecking, setTargetChecking] = useState(false)
  const [reloadConfirm, setReloadConfirm] = useState(false)
  const views = useRef(new Map<number, PageView>())
  const history = useRef(lifetime.history)
  const captureLatest = useRef<(() => NavigationPosition) | undefined>(undefined)
  const restored = useRef(false)
  const navigationLock = useRef(false)
  const operationLock = useRef(false)
  const [navigating, setNavigating] = useState(false)
  const activePdf = useRef<{ document: PDFDocumentProxy; dispose(): Promise<void> } | null>(null)
  const ocrController = useRef<AbortController | null>(null)
  const searchSequence = useRef(0)
  const ownerSequence = useRef(0)
  const state = useRef({ snapshot, scrollRoot, rotation, zoom, fit, size, currentPage })
  state.current = { snapshot, scrollRoot, rotation, zoom, fit, size, currentPage }
  const callbacks = useRef(props)
  callbacks.current = props
  void historyRevision

  const notifyError = useCallback((value: unknown) => {
    const needsPassword = value instanceof Error && (('code' in value && value.code === 'password-required') || value.name === 'PasswordException')
    const message = needsPassword ? callbacks.current.t('reader.passwordRequired') : value instanceof Error ? value.message : String(value)
    setError(message)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const token = ++ownerSequence.current
    const ownerContent = props.content
    const stop = () => controller.abort()
    tab.signal.addEventListener('abort', stop, { once: true })
    if (tab.signal.aborted) controller.abort()
    setError('')
    void api.open(sessionId, props.resourceAddress, controller.signal).then((next) => {
      if (!controller.signal.aborted && token === ownerSequence.current) {
        setSnapshot(next)
        setDisplayOwner({ token, content: ownerContent })
      }
    }).catch((failure) => {
      if (!controller.signal.aborted && token === ownerSequence.current) { notifyError(failure); ownerContent.failed() }
    })
    return () => { controller.abort(); tab.signal.removeEventListener('abort', stop) }
  }, [api, sessionId, props.resourceAddress, props.content.revision, tab.signal, notifyError])

  useEffect(() => snapshot ? api.subscribe(snapshot.id, setSnapshot) : undefined, [api, snapshot?.id])

  useEffect(() => {
    if (!snapshot || !displayOwner || displayOwner.token !== ownerSequence.current) return
    const controller = new AbortController()
    let accepted = false
    let cancelled = false
    void callbacks.current.openPdf(snapshot.bytes.slice(), controller.signal).then(async (opened) => {
      if (controller.signal.aborted || cancelled || displayOwner.token !== ownerSequence.current) { await opened.dispose(); return }
      accepted = true
      const previous = activePdf.current
      activePdf.current = opened
      views.current.clear()
      setPdf(opened.document)
      displayOwner.content.loaded(snapshot.sourceVersion)
      // Give React a frame to cancel the previous canvas/text-layer work.
      await frame()
      await previous?.dispose()
    }).catch((failure) => {
      if (!controller.signal.aborted && displayOwner.token === ownerSequence.current) { notifyError(failure); displayOwner.content.failed() }
    })
    return () => { cancelled = true; if (!accepted) controller.abort() }
  }, [snapshot?.id, snapshot?.revision, snapshot?.sourceVersion, displayOwner?.token, notifyError])

  useLayoutEffect(() => () => {
    // Layout cleanup captures geometry before React detaches the page elements.
    try { lifetime.position = captureLatest.current?.() } catch { /* No page loaded yet. */ }
    void activePdf.current?.dispose()
    activePdf.current = null
    ocrController.current?.abort()
    searchSequence.current++
  }, [])
  useEffect(() => { lifetime.ocrPages = ocrPages }, [ocrPages, lifetime])
  useEffect(() => {
    const configuration = `${settings.ocrEngine}:${settings.ocrLanguages}`
    if (lifetime.ocrConfiguration !== configuration) {
      ocrController.current?.abort()
      setOcrPages(new Map())
      lifetime.ocrConfiguration = configuration
    }
  }, [settings.ocrEngine, settings.ocrLanguages, lifetime])
  useEffect(() => { setColor(settings.defaultColor) }, [settings.defaultColor])

  useEffect(() => {
    if (!snapshot) return
    if (history.current.resetForDocument(snapshot.contentVersion)) {
      setOcrPages(new Map())
      setHits([])
      setSearched(false)
      searchSequence.current++
      ocrController.current?.abort()
      lifetime.position = undefined
    }
    lifetime.contentVersion = snapshot.contentVersion
    setSelection(null)
    setHistoryRevision((n) => n + 1)
  }, [snapshot?.contentVersion])
  useEffect(() => { setSelection(null) }, [snapshot?.revision])
  useEffect(() => { history.current.setCapacity(settings.historyCapacity); setHistoryRevision((n) => n + 1) }, [settings.historyCapacity])

  useEffect(() => {
    if (!scrollRoot) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(scrollRoot)
    return () => observer.disconnect()
  }, [scrollRoot])

  useEffect(() => {
    if (!snapshot?.dirty) return
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [snapshot?.dirty])

  const pageScale = useCallback((page: PdfPageInfo, chosenFit = state.current.fit, chosenZoom = state.current.zoom, chosenRotation = state.current.rotation) => {
    if (chosenFit === 'custom') return chosenZoom
    const rotated = (page.rotation + chosenRotation) % 180 !== 0
    const width = (page.cropBox[2] - page.cropBox[0]) * page.userUnit
    const height = (page.cropBox[3] - page.cropBox[1]) * page.userUnit
    const available = state.current.size
    const widthScale = Math.max(0.1, (available.width - 32) / (rotated ? height : width))
    return chosenFit === 'page' ? Math.min(widthScale, Math.max(0.1, (available.height - 56) / (rotated ? width : height))) : widthScale
  }, [])

  const capture = useCallback((): NavigationPosition => {
    const current = state.current
    if (!current.snapshot || !current.scrollRoot) throw new Error(callbacks.current.t('reader.notReady'))
    const outer = current.scrollRoot.getBoundingClientRect()
    const available = [...views.current.entries()].sort(([a], [b]) => a - b)
    const pair = available.find(([, view]) => view.element.getBoundingClientRect().bottom > outer.top + 4) ?? available[0]
    const geometry = current.snapshot.document.pages[(pair?.[0] ?? current.currentPage) - 1]
    if (!pair) return { documentVersion: current.snapshot.contentVersion, page: geometry.page,
      x: geometry.cropBox[0], y: geometry.cropBox[3], rotation: current.rotation, fit: current.fit,
      scale: pageScale(geometry), viewportAnchor: { x: 0, y: 0 } }
    const [page, view] = pair, box = view.element.getBoundingClientRect()
    const screenX = Math.max(box.left, outer.left), screenY = Math.max(box.top, outer.top)
    const [x, y] = view.viewport.convertToPdfPoint(screenX - box.left, screenY - box.top)
    return { documentVersion: current.snapshot.contentVersion, page, x, y, rotation: current.rotation,
      scale: view.viewport.scale, fit: current.fit,
      viewportAnchor: { x: Math.max(0, Math.min(1, (screenX - outer.left) / outer.width)), y: Math.max(0, Math.min(1, (screenY - outer.top) / outer.height)) } }
  }, [pageScale])

  const applyPosition = useCallback(async (position: NavigationPosition, signal: AbortSignal) => {
    const current = state.current
    if (!current.snapshot || position.documentVersion !== current.snapshot.contentVersion || !current.snapshot.document.pages[position.page - 1]) throw new Error(callbacks.current.t('reader.invalidDestination'))
    const origin = { rotation: current.rotation, zoom: current.zoom, fit: current.fit, left: current.scrollRoot?.scrollLeft ?? 0, top: current.scrollRoot?.scrollTop ?? 0 }
    try {
    setRotation(position.rotation)
    setZoom(position.scale)
    setFit(position.fit)
    await frame()
    await frame()
    signal.throwIfAborted()
    const root = state.current.scrollRoot
    const placeholder = root?.querySelector<HTMLElement>(`[data-page-number="${position.page}"]`)
    if (!root || !placeholder) throw new Error(callbacks.current.t('reader.invalidDestination'))
    root.scrollTop += placeholder.getBoundingClientRect().top - root.getBoundingClientRect().top
    let view: PageView | undefined
    for (let attempt = 0; attempt < 180; attempt++) {
      signal.throwIfAborted()
      view = views.current.get(position.page)
      const geometry = state.current.snapshot!.document.pages[position.page - 1]
      const expected = pageScale(geometry, position.fit, position.scale, position.rotation)
      if (view && Math.abs(view.viewport.scale - expected) < 0.001 && view.viewport.rotation === ((geometry.rotation + position.rotation) % 360 + 360) % 360) break
      view = undefined
      await frame()
    }
    if (!view) throw new Error(callbacks.current.t('reader.notReady'))
    const [x, y] = view.viewport.convertToViewportPoint(position.x, position.y)
    const bounds = root.getBoundingClientRect(), pageBounds = view.element.getBoundingClientRect()
    root.scrollLeft += pageBounds.left + x - bounds.left - (position.viewportAnchor?.x ?? 0) * bounds.width
    root.scrollTop += pageBounds.top + y - bounds.top - (position.viewportAnchor?.y ?? 0) * bounds.height
    setCurrentPage(position.page)
    setPageInput(String(position.page))
    await frame()
    // Position is semantic; scroll clamping at page/document edges is expected.
    return { ...position, scale: view.viewport.scale }
    } catch (failure) {
      // A failed destination must not strand the reader at its loading placeholder.
      setRotation(origin.rotation); setZoom(origin.zoom); setFit(origin.fit)
      await frame(); await frame()
      if (state.current.scrollRoot) { state.current.scrollRoot.scrollLeft = origin.left; state.current.scrollRoot.scrollTop = origin.top }
      throw failure
    }
  }, [pageScale])
  captureLatest.current = capture

  useEffect(() => {
    if (!pdf || !snapshot || restored.current) return
    restored.current = true
    const saved = lifetime.position
    if (saved && saved.documentVersion === snapshot.contentVersion) {
      void applyPosition(saved, tab.signal).catch((failure) => { if (!tab.signal.aborted) notifyError(failure) })
    }
  }, [pdf, snapshot?.id, applyPosition, lifetime, tab.signal, notifyError])

  const jump = useCallback(async (page: number, options: Partial<NavigationPosition> = {}, remember = true) => {
    if (navigationLock.current) return
    navigationLock.current = true
    setNavigating(true)
    try {
      const current = state.current
      const geometry = current.snapshot?.document.pages[page - 1]
      if (!geometry) throw new Error(callbacks.current.t('reader.invalidDestination'))
      const target: NavigationPosition = { ...capture(), page, x: geometry.cropBox[0], y: geometry.cropBox[3], viewportAnchor: { x: 0, y: 0 }, ...options }
      if (remember) await history.current.jump(target, { capture, apply: applyPosition }, tab.signal)
      else await applyPosition(target, tab.signal)
      setHistoryRevision((n) => n + 1)
    } catch (failure) { if (!tab.signal.aborted) notifyError(failure) }
    finally { navigationLock.current = false; setNavigating(false) }
  }, [capture, applyPosition, notifyError, tab.signal])

  const destination = useCallback(async (value: unknown) => {
    try {
      if (!pdf) return
      const resolved = typeof value === 'string' ? await pdf.getDestination(value) : value
      if (!Array.isArray(resolved) || resolved.length < 2) throw new Error(t('reader.invalidDestination'))
      const pageIndex = typeof resolved[0] === 'number' ? resolved[0] : await pdf.getPageIndex(resolved[0])
      const kind = resolved[1]?.name
      const options: Partial<NavigationPosition> = {}
      if (kind === 'XYZ') {
        if (typeof resolved[2] === 'number') options.x = resolved[2]
        if (typeof resolved[3] === 'number') options.y = resolved[3]
        if (typeof resolved[4] === 'number' && resolved[4] > 0) { options.scale = resolved[4]; options.fit = 'custom' }
      } else if (kind === 'Fit' || kind === 'FitB') options.fit = 'page'
      else if (kind === 'FitH' || kind === 'FitBH') { options.fit = 'width'; if (typeof resolved[2] === 'number') options.y = resolved[2] }
      else if (kind === 'FitV' || kind === 'FitBV') {
        const geometry = state.current.snapshot!.document.pages[pageIndex]
        const page = await pdf.getPage(pageIndex + 1)
        const base = page.getViewport({ scale: 1, rotation: (geometry.rotation + state.current.rotation) % 360 })
        options.fit = 'custom'; options.scale = Math.max(0.1, (state.current.size.height - 56) / base.height)
        if (typeof resolved[2] === 'number') options.x = resolved[2]
      } else if (kind === 'FitR') {
        if (![resolved[2], resolved[3], resolved[4], resolved[5]].every(Number.isFinite)) throw new Error(t('reader.invalidDestination'))
        const geometry = state.current.snapshot!.document.pages[pageIndex]
        const page = await pdf.getPage(pageIndex + 1)
        const base = page.getViewport({ scale: 1, rotation: (geometry.rotation + state.current.rotation) % 360 })
        const box = pdfRectToViewport(base, [resolved[2], resolved[3], resolved[4], resolved[5]])
        if (box[2] <= box[0] || box[3] <= box[1]) throw new Error(t('reader.invalidDestination'))
        options.fit = 'custom'; options.scale = Math.max(0.1, Math.min((state.current.size.width - 32) / (box[2] - box[0]), (state.current.size.height - 56) / (box[3] - box[1])))
        const [x, y] = base.convertToPdfPoint(box[0], box[1]); options.x = x; options.y = y
      } else throw new Error(t('reader.invalidDestination'))
      await jump(pageIndex + 1, options)
    } catch (failure) { notifyError(failure) }
  }, [pdf, jump, notifyError, t])

  const act = async (operation: (current: WorkspaceSnapshot) => Promise<WorkspaceSnapshot>) => {
    if (!snapshot || operationLock.current) return
    operationLock.current = true
    setBusy(true)
    setError('')
    try { const next = await operation(snapshot); setSnapshot(next); return next }
    catch (failure) { notifyError(failure) }
    finally { operationLock.current = false; setBusy(false) }
  }
  const change = (operations: PdfAnnotationOperation[]) => act((current) => api.change(sessionId, current.id, current.revision, operations, tab.signal))
  const save = async (path?: string) => {
    if (path && target?.path !== path) { setError(t('reader.targetUnchecked')); return }
    const originalPath = snapshot?.path
    const result = await act((current) => api.save(sessionId, current.id, current.revision, path ? { path, overwrite, expectedTargetVersion: target!.version } : {}, tab.signal))
    if (result) {
      setSaveAsOpen(false); setOverwrite(false)
      if (path && result.path !== originalPath) {
        const encode = (part: string) => encodeURIComponent(part).replace(/%3A/gi, ':')
        const normalized = result.path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
        tab.actions.openResource(`dsh-resource://file/session/${encode(sessionId)}/${normalized.split('/').map(encode).join('/')}`, { replaceTab: true })
      }
    }
  }

  useEffect(() => {
    setTarget(null)
    setOverwrite(false)
    if (!saveAsOpen || !savePath.trim()) { setTargetChecking(false); return }
    const controller = new AbortController()
    setTargetChecking(true)
    const timer = setTimeout(() => {
      void api.inspectTarget(sessionId, savePath, controller.signal).then((result) => {
        if (!controller.signal.aborted) setTarget({ path: savePath, version: result.version })
      }).catch((failure) => { if (!controller.signal.aborted) notifyError(failure) })
        .finally(() => { if (!controller.signal.aborted) setTargetChecking(false) })
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [api, sessionId, saveAsOpen, savePath, notifyError])

  const selected = snapshot?.document.annotations.find((annotation) => annotation.id === selectedAnnotation)
  useEffect(() => {
    if (!selected) return
    setComment(selected.contents ?? '')
    setCommentColor(colorToHex(selected.color))
  }, [selected?.id, selected?.contents, selected?.color?.join(',')])

  const mark = async (subtype: 'Highlight' | 'Underline' | 'StrikeOut') => {
    if (!snapshot || !selection || selection.revision !== snapshot.revision || selection.kind !== 'text') return
    const operations: PdfAnnotationOperation[] = selection.fragments.map((fragment) => ({ type: 'add', annotation: {
      id: crypto.randomUUID(), page: fragment.page, subtype, rect: fragment.rect,
      quadPoints: fragment.quadPoints, color: colorFromHex(color),
    } }))
    const changed = await change(operations)
    if (changed) {
      setSelection(null)
      window.getSelection()?.removeAllRanges()
      setCommentsOpen(true)
      setPendingNote(null)
      if (operations[0].type === 'add') setSelectedAnnotation(operations[0].annotation.id)
    }
  }

  const beginNote = (page: number, point: number[]) => {
    if (!snapshot || snapshot.document.readOnly) return
    const bounds = snapshot.document.pages[page - 1].cropBox
    const width = Math.min(20, bounds[2] - bounds[0]), height = Math.min(20, bounds[3] - bounds[1])
    const x = Math.max(bounds[0], Math.min(bounds[2] - width, point[0]))
    const y = Math.max(bounds[1] + height, Math.min(bounds[3], point[1]))
    setPendingNote({ id: crypto.randomUUID(), page, subtype: 'Text', rect: [x, y - height, x + width, y] })
    setSelectedAnnotation(undefined)
    setComment('')
    setCommentColor(color)
    setCommentsOpen(true)
    setMode('text')
  }

  const runSearch = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!pdf || !snapshot || !query.trim()) return
    const sequence = ++searchSequence.current
    const needle = query.trim().toLocaleLowerCase()
    setSearching(true)
    setSearched(false)
    const found: SearchHit[] = []
    try {
      for (let number = 1; number <= pdf.numPages; number++) {
        if (sequence !== searchSequence.current || tab.signal.aborted) return
        const ocr = ocrPages.get(number)
        if (ocr) {
          for (const word of ocr.words) if (word.text.toLocaleLowerCase().includes(needle) && word.pdf) {
            found.push({ page: number, text: word.text, x: word.pdf.rect[0], y: word.pdf.rect[3], source: 'ocr' })
          }
          // Phrase queries span OCR word boundaries; return a page-level match as well.
          if (ocr.text.toLocaleLowerCase().includes(needle) && !found.some((hit) => hit.page === number)) {
            const box = snapshot.document.pages[number - 1].cropBox
            found.push({ page: number, text: ocr.text.slice(Math.max(0, ocr.text.toLocaleLowerCase().indexOf(needle) - 30), ocr.text.toLocaleLowerCase().indexOf(needle) + needle.length + 70), x: box[0], y: box[3], source: 'ocr' })
          }
        }
        {
          const page = await pdf.getPage(number)
          const content = await page.getTextContent()
          const items = content.items.filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
          const { text: combined, starts } = joinSearchText(items)
          let offset = 0, index = -1
          while ((index = combined.toLocaleLowerCase().indexOf(needle, offset)) >= 0 && found.length < 500) {
            let itemIndex = starts.findIndex((start) => start > index) - 1
            if (itemIndex < 0) itemIndex = items.length - 1
            const transform = items[itemIndex]?.transform
            const box = snapshot.document.pages[number - 1].cropBox
            found.push({ page: number, text: combined.slice(Math.max(0, index - 30), index + needle.length + 70), x: transform?.[4] ?? box[0], y: transform?.[5] ?? box[3], source: 'native' })
            offset = index + Math.max(1, needle.length)
          }
        }
        if (found.length >= 500) break
      }
      if (sequence === searchSequence.current) { setHits(found); setSearched(true) }
    } catch (failure) { if (sequence === searchSequence.current) notifyError(failure) }
    finally { if (sequence === searchSequence.current) setSearching(false) }
  }

  const recognize = async () => {
    if (!pdf || !snapshot || ocrController.current) return
    const controller = new AbortController()
    ocrController.current = controller
    const version = snapshot.contentVersion
    const region = selection?.kind === 'region' && selection.revision === snapshot.revision ? selection.fragments[0] : undefined
    const number = region?.page ?? currentPage
    setOcrProgress(t('reader.ocrPreparing'))
    setError('')
    const stop = () => controller.abort()
    tab.signal.addEventListener('abort', stop, { once: true })
    const canvases: HTMLCanvasElement[] = []
    try {
      const page = await pdf.getPage(number)
      controller.signal.throwIfAborted()
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(2, Math.sqrt(16_000_000 / (base.width * base.height)))
      const viewport = page.getViewport({ scale })
      const full = document.createElement('canvas')
      canvases.push(full)
      full.width = Math.ceil(viewport.width); full.height = Math.ceil(viewport.height)
      const render = page.render({ canvas: full, viewport, annotationMode: AnnotationMode.DISABLE })
      const cancelRender = () => render.cancel()
      controller.signal.addEventListener('abort', cancelRender, { once: true })
      try { await render.promise } finally { controller.signal.removeEventListener('abort', cancelRender) }
      controller.signal.throwIfAborted()
      let image = full, left = 0, top = 0
      if (region) {
        const rectangle = pdfRectToViewport(viewport, region.rect)
        left = Math.max(0, Math.floor(Math.min(rectangle[0], rectangle[2])))
        top = Math.max(0, Math.floor(Math.min(rectangle[1], rectangle[3])))
        image = document.createElement('canvas')
        canvases.push(image)
        image.width = Math.max(1, Math.min(full.width - left, Math.ceil(rectangle[2]) - left))
        image.height = Math.max(1, Math.min(full.height - top, Math.ceil(rectangle[3]) - top))
        image.getContext('2d')!.drawImage(full, left, top, image.width, image.height, 0, 0, image.width, image.height)
      }
      const blob = await new Promise<Blob>((resolve, reject) => image.toBlob((value) => value ? resolve(value) : reject(new Error(t('reader.imageFailed'))), 'image/png'))
      const result = await props.ocr.recognize({ image: blob, width: image.width, height: image.height,
        languages: settings.ocrLanguages.split('+').map((language) => language.trim()).filter(Boolean),
        signal: controller.signal, timeoutMs: settings.ocrTimeoutMs,
        onProgress: (progress) => setOcrProgress(`${t('reader.recognizing')} ${progress.progress === null ? '' : `${Math.round(progress.progress * 100)}%`}`),
      }, { cacheIdentity: { documentId: snapshot.id, contentVersion: version, page: number, region: region?.rect ?? null, renderRevision: `base-no-annotations:${scale}:${page.rotate}` } })
      const imageToPdf = (x: number, y: number) => viewport.convertToPdfPoint(x + left, y + top) as [number, number]
      const mapped = mapResultToPdf(result, imageToPdf)
      if (!controller.signal.aborted && state.current.snapshot?.contentVersion === version) {
        const words = mapped.words.length ? mapped.words : mapped.lines.length ? mapped.lines : mapped.blocks
        const coverage = result.coverage.map((box) => mapImageBoxToPdf(box, imageToPdf).rect)
        const batchId = crypto.randomUUID()
        setOcrPages((previous) => {
          const old = previous.get(number)
          const retained = (old?.words ?? []).filter((word) => !word.pdf || !coverage.some((box) => overlapFraction(word.pdf!.rect, box) > 0.5))
          const merged = [...retained, ...words.map((word) => ({ ...word, id: `${batchId}:${word.id}` }))]
          return new Map(previous).set(number, { words: merged, text: merged.map((word) => word.text).join(' '), engine: result.source.engineId, warnings: result.warnings })
        })
        if (!words.length) setError(t('reader.ocrNoText'))
        else if (result.status === 'partial') setError(t('reader.ocrPartial'))
        setSelection(null)
      }
    } catch (failure) { if (!controller.signal.aborted) notifyError(failure) }
    finally { for (const canvas of canvases) { canvas.width = 0; canvas.height = 0 }; tab.signal.removeEventListener('abort', stop); ocrController.current = null; setOcrProgress(null) }
  }

  const editable = !!snapshot && !snapshot.document.readOnly && !busy
  const hasTextSelection = selection?.kind === 'text' && selection.revision === snapshot?.revision
  const registerView = useCallback((number: number, view: PageView | null) => { if (view) views.current.set(number, view); else views.current.delete(number) }, [])
  const scrollRef = useCallback((node: HTMLDivElement | null) => { setScrollRoot(node); props.scrollportRef(node) }, [props.scrollportRef])
  const selectAnnotation = (id: string) => { setPendingNote(null); setSelectedAnnotation(id); setCommentsOpen(true) }

  return <div className="dsh-pdf-reader" aria-label={t('reader.title')} onKeyDown={(event) => {
    const input = event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]')
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
    if (!input && snapshot && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      void act((current) => event.shiftKey ? api.redo(sessionId, current.id, current.revision, tab.signal) : api.undo(sessionId, current.id, current.revision, tab.signal))
    }
  }}>
    <div className="dsh-pdf-toolbar" role="toolbar" aria-label={t('reader.navigation')}>
      <button disabled={!history.current.canGoBack || busy || navigating} title={`${t('reader.back')} ${history.current.peek()?.page ?? ''}`} onClick={() => {
        if (navigationLock.current) return
        navigationLock.current = true; setNavigating(true)
        void history.current.back({ apply: applyPosition }, tab.signal).then(() => setHistoryRevision((n) => n + 1)).catch(notifyError).finally(() => { navigationLock.current = false; setNavigating(false) })
      }}>← {t('reader.back')}</button>
      <button title={t('reader.previous')} aria-label={t('reader.previous')} disabled={!pdf || navigating || currentPage <= 1} onClick={() => void jump(currentPage - 1, {}, false)}>‹</button>
      <form className="dsh-pdf-page-form" onSubmit={(event) => { event.preventDefault(); void jump(Number(pageInput)) }}>
        <input aria-label={t('reader.page')} inputMode="numeric" value={pageInput} onChange={(event) => setPageInput(event.target.value)} />
        <span>/ {snapshot?.document.pageCount ?? '—'}</span>
      </form>
      <button title={t('reader.next')} aria-label={t('reader.next')} disabled={!pdf || navigating || currentPage >= pdf.numPages} onClick={() => void jump(currentPage + 1, {}, false)}>›</button>
      <select disabled={navigating} aria-label={t('reader.zoom')} value={fit === 'custom' ? String(zoom) : fit} onChange={(event) => {
        if (event.target.value === 'width' || event.target.value === 'page') setFit(event.target.value)
        else { setFit('custom'); setZoom(Number(event.target.value)) }
      }}>
        <option value="width">{t('reader.fitWidth')}</option><option value="page">{t('reader.fitPage')}</option>
        {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((value) => <option value={value} key={value}>{Math.round(value * 100)}%</option>)}
        {fit === 'custom' && ![0.5, 0.75, 1, 1.25, 1.5, 2, 3].includes(zoom) && <option value={zoom}>{Math.round(zoom * 100)}%</option>}
      </select>
      <button onClick={() => setRotation((value) => (value + 90) % 360)} disabled={!pdf || navigating} title={t('reader.rotate')}>↻</button>
      <button aria-pressed={searchOpen} onClick={() => setSearchOpen((value) => !value)}>{t('reader.search')}</button>
      <button aria-pressed={commentsOpen} onClick={() => setCommentsOpen((value) => !value)}>{t('reader.comments')}</button>
    </div>
    <div className="dsh-pdf-toolbar dsh-pdf-editbar" role="toolbar" aria-label={t('reader.editing')}>
      <button aria-pressed={mode === 'text'} onClick={() => setMode('text')}>{t('reader.selectText')}</button>
      <button aria-pressed={mode === 'region'} onClick={() => setMode('region')}>{t('reader.selectRegion')}</button>
      <input type="color" aria-label={t('reader.color')} value={color} onChange={(event) => setColor(event.target.value)} />
      <button disabled={!editable || !hasTextSelection} onClick={() => void mark('Highlight')}>{t('reader.highlight')}</button>
      <button disabled={!editable || !hasTextSelection} onClick={() => void mark('Underline')}>{t('reader.underline')}</button>
      <button disabled={!editable || !hasTextSelection} onClick={() => void mark('StrikeOut')}>{t('reader.strike')}</button>
      <button disabled={!editable} aria-pressed={mode === 'note'} onClick={() => {
        const region = selection?.fragments[0]
        if (region) beginNote(region.page, [region.rect[0], region.rect[3]])
        else setMode('note')
      }}>{t('reader.note')}</button>
      <button disabled={!pdf || !!ocrProgress} onClick={() => void recognize()}>{selection?.kind === 'region' ? t('reader.ocrRegion') : t('reader.ocrPage')}</button>
      <button disabled={!snapshot?.canUndo || busy} onClick={() => void act((current) => api.undo(sessionId, current.id, current.revision, tab.signal))} title={t('reader.undo')}>↶</button>
      <button disabled={!snapshot?.canRedo || busy} onClick={() => void act((current) => api.redo(sessionId, current.id, current.revision, tab.signal))} title={t('reader.redo')}>↷</button>
      <button className="dsh-pdf-primary" disabled={!editable || !snapshot?.dirty} onClick={() => void save()}>{t('reader.save')}</button>
      <button disabled={!editable} onClick={() => { setSavePath(snapshot?.path.replace(/\.pdf$/i, '-annotated.pdf') ?? ''); setSaveAsOpen(true) }}>{t('reader.saveAs')}</button>
      <span className={snapshot?.dirty ? 'dsh-pdf-status is-dirty' : 'dsh-pdf-status'} role="status">{busy ? t('reader.working') : snapshot?.document.readOnly ? t('reader.readOnly') : snapshot?.dirty ? t('reader.unsaved') : snapshot ? t('reader.saved') : ''}</span>
    </div>
    {snapshot?.document.readOnly && <div className="dsh-pdf-notice">{t(snapshot.document.readOnlyReason === 'encrypted-document' ? 'reader.encryptedReadOnly' : 'reader.signedReadOnly')}</div>}
    {mode === 'note' && <div className="dsh-pdf-notice">{t('reader.placeNote')}</div>}
    {error && <div className="dsh-pdf-error" role="alert"><span>{error}</span><button aria-label={t('reader.dismiss')} onClick={() => setError('')}>×</button></div>}
    {snapshot?.warning && <div className="dsh-pdf-notice" role="status">{snapshot.warning}</div>}
    {snapshot?.conflict && <div className="dsh-pdf-notice">{t('reader.conflict')}<button onClick={() => setSaveAsOpen(true)}>{t('reader.saveAs')}</button></div>}
    {ocrProgress && <div className="dsh-pdf-notice" role="status">{ocrProgress}<button onClick={() => ocrController.current?.abort()}>{t('reader.cancel')}</button></div>}
    {saveAsOpen && <form className="dsh-pdf-dialog" onSubmit={(event) => { event.preventDefault(); void save(savePath) }}>
      <label>{t('reader.savePath')}<input value={savePath} required onChange={(event) => setSavePath(event.target.value)} /></label>
      <p>{targetChecking ? t('reader.targetChecking') : target?.version ? t('reader.targetExists') : target ? t('reader.targetNew') : t('reader.targetUnchecked')}</p>
      {target?.version && <label><input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />{t('reader.overwrite')}</label>}
      <button type="submit" disabled={busy || !target || target.path !== savePath || (!!target.version && !overwrite)}>{t('reader.save')}</button><button type="button" onClick={() => setSaveAsOpen(false)}>{t('reader.cancel')}</button>
    </form>}
    {reloadConfirm && <div className="dsh-pdf-dialog"><p>{t('reader.reloadConfirm')}</p>
      <button onClick={() => { void act((current) => api.reload(sessionId, current.id, current.revision, tab.signal)); setReloadConfirm(false) }}>{t('reader.reload')}</button>
      <button onClick={() => setReloadConfirm(false)}>{t('reader.cancel')}</button></div>}
    <div className="dsh-pdf-body">
      {searchOpen && <aside className="dsh-pdf-search-panel">
        <form onSubmit={(event) => void runSearch(event)}><input aria-label={t('reader.search')} placeholder={t('reader.searchPlaceholder')} value={query} onChange={(event) => setQuery(event.target.value)} />
          <button disabled={searching || !query.trim() || !pdf}>{searching ? t('reader.searching') : t('reader.search')}</button></form>
        <p className="dsh-pdf-muted">{t('reader.searchCoverage')}</p>
        {searched && <p>{hits.length ? `${hits.length}${hits.length >= 500 ? '+' : ''} ${t('reader.results')}` : t('reader.noResults')}</p>}
        {hits.map((hit, index) => <button className="dsh-pdf-search-hit" key={index} onClick={() => void jump(hit.page, { x: hit.x, y: hit.y })}>
          <strong>{t('reader.page')} {hit.page} · {hit.source === 'ocr' ? t('reader.ocrText') : t('reader.nativeText')}</strong><span>{hit.text}</span>
        </button>)}
      </aside>}
      <div className="dsh-pdf-scroll" ref={scrollRef} tabIndex={0} onScroll={() => {
        if (!scrollRoot) return
        const top = scrollRoot.getBoundingClientRect().top
        const page = [...scrollRoot.querySelectorAll<HTMLElement>('[data-page-number]')].find((element) => element.getBoundingClientRect().bottom > top + 40)
        if (page) { const number = Number(page.dataset.pageNumber); setCurrentPage(number); setPageInput(String(number)) }
      }} onPointerUp={() => {
        if (mode === 'text' && scrollRoot && snapshot) {
          const next = captureTextSelection(scrollRoot, views.current, snapshot.revision)
          setSelection(next)
        }
      }} onKeyUp={() => {
        if (scrollRoot && snapshot) setSelection(captureTextSelection(scrollRoot, views.current, snapshot.revision))
      }}>
        {!pdf && <div className="dsh-pdf-empty" role="status">{error ? t('reader.cannotOpen') : t('reader.loading')}</div>}
        {pdf && snapshot?.document.pages.map((geometry) => <Page key={`${snapshot.id}:${geometry.page}`} pdf={pdf} geometry={geometry}
          scale={pageScale(geometry)} rotation={rotation} mode={mode} t={t} scrollRoot={scrollRoot}
          annotations={snapshot.document.annotations.filter((annotation) => annotation.page === geometry.page)}
          selectedAnnotation={selectedAnnotation} selection={selection} ocrWords={ocrPages.get(geometry.page)?.words}
          onView={registerView} onDestination={(value) => void destination(value)}
          onNamedAction={(action) => void jump(action === 'FirstPage' ? 1 : action === 'LastPage' ? pdf.numPages : action === 'NextPage' ? geometry.page + 1 : geometry.page - 1)}
          onAnnotation={selectAnnotation} onNote={beginNote} onRegion={(page, region) => setSelection({ kind: 'region', revision: snapshot.revision, text: '', fragments: [{ page, ...region }] })}
          onError={notifyError} />)}
      </div>
      {commentsOpen && <aside className="dsh-pdf-comments">
        <h3>{t('reader.comments')}</h3>
        {(selected || pendingNote) && <div className="dsh-pdf-comment-editor">
          <label>{t('reader.commentText')}<textarea value={comment} disabled={!!selected && !selected.editable} onChange={(event) => setComment(event.target.value)} rows={5} /></label>
          <label>{t('reader.color')}<input type="color" value={commentColor} disabled={!!selected && !selected.editable} onChange={(event) => setCommentColor(event.target.value)} /></label>
          {selected?.readOnlyReason && <p className="dsh-pdf-muted">{t(`reader.reason.${selected.readOnlyReason}`)}</p>}
          <button disabled={!editable || (!!selected && !selected.editable)} onClick={async () => {
            const patch = { contents: comment, color: colorFromHex(commentColor) }
            const next = pendingNote ? await change([{ type: 'add', annotation: { ...pendingNote, ...patch } }]) : selected ? await change([{ type: 'update', id: selected.id, patch }]) : undefined
            if (next && pendingNote) { setSelectedAnnotation(pendingNote.id); setPendingNote(null) }
          }}>{t('reader.applyComment')}</button>
          {pendingNote && <button onClick={() => setPendingNote(null)}>{t('reader.cancel')}</button>}
          {selected && <button disabled={!editable || !selected.editable} onClick={async () => { if (await change([{ type: 'delete', id: selected.id }])) setSelectedAnnotation(undefined) }}>{t('reader.delete')}</button>}
        </div>}
        {snapshot?.document.annotations.filter((annotation) => annotation.supported || (annotation.contents && annotation.subtype !== 'Popup')).map((annotation) => <button
          className={`dsh-pdf-comment-item${selectedAnnotation === annotation.id ? ' is-selected' : ''}`} key={annotation.id}
          onClick={() => { selectAnnotation(annotation.id); void jump(annotation.page, annotation.rect ? { x: annotation.rect[0], y: annotation.rect[3] } : {}) }}>
          <strong>{t('reader.page')} {annotation.page} · {annotation.supported ? t(`reader.type.${annotation.subtype}`) : annotation.subtype}</strong>
          <span>{annotation.contents || t('reader.noComment')}</span>
          {annotation.author && <small>{annotation.author}</small>}
          {annotation.createdAt && <small>{t('reader.created')} {annotation.createdAt}</small>}
          {annotation.modifiedAt && <small>{t('reader.modified')} {annotation.modifiedAt}</small>}
        </button>)}
        {!snapshot?.document.annotations.some((annotation) => annotation.supported) && <p className="dsh-pdf-muted">{t('reader.noAnnotations')}</p>}
      </aside>}
    </div>
    <div className="dsh-pdf-footer"><span title={snapshot?.path}>{snapshot?.path}</span>
      {selection && <button onClick={() => { setSelection(null); window.getSelection()?.removeAllRanges() }}>{t('reader.clearSelection')}</button>}
      <button disabled={!snapshot || busy} onClick={() => snapshot?.dirty ? setReloadConfirm(true) : void act((current) => api.reload(sessionId, current.id, current.revision, tab.signal))}>{t('reader.reload')}</button>
    </div>
  </div>
}

export default Reader
