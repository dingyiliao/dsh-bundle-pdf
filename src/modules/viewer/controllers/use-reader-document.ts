import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PdfAnnotation } from '../../../core/pdf-types.js'
import type { PdfClientApi, WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { ReaderContentLease } from '../ports/reader.js'
import { NativeDocument, openNativeDocument } from '../rendering/document.js'

const noAnnotations: PdfAnnotation[] = []
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const readerIdentity = (snapshot: WorkspaceSnapshot) => `${snapshot.id}:${snapshot.reader.bytesHash}:${snapshot.reader.generation}`

export interface ReaderDocumentOptions {
  api: PdfClientApi
  sessionId: string
  resourceAddress: string
  content: ReaderContentLease
  tabSignal: AbortSignal
  onError(error: unknown): void
  onResourceSwitch(): void
  onNativeOpened(): void
  /** Cancel a region render, then return the task whose native handle must stay alive. */
  releaseRegionCapture(): Promise<unknown> | null
}

/** Owns one Reader's resource request, native handle and late-result cleanup. */
export function useReaderDocument(options: ReaderDocumentOptions) {
  const { api, sessionId, resourceAddress, content, tabSignal } = options
  const resource = useMemo(() => ({ api, sessionId, resourceAddress, tabSignal }),
    [api, sessionId, resourceAddress, tabSignal])
  const currentResource = useRef(resource)
  currentResource.current = resource
  const latest = useRef(options)
  latest.current = options
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [displayOwner, setDisplayOwner] = useState<{ token: number; content: ReaderContentLease; resource: typeof resource } | null>(null)
  const [pdf, setPdf] = useState<NativeDocument | null>(null)
  const [pdfAnnotations, setPdfAnnotations] = useState<PdfAnnotation[]>(noAnnotations)
  const ownerSequence = useRef(0)
  const activePdf = useRef<{ document: NativeDocument; identity: string; dispose(): Promise<void> } | null>(null)
  const mounted = useRef(true)
  const failedOwner = useRef<{ resource: typeof resource; revision: number } | null>(null)
  const rendered = useRef({ snapshot, displayOwner, pdf })
  rendered.current = { snapshot, displayOwner, pdf }
  const published = useRef(rendered.current)
  const waiters = useRef(new Map<typeof resource, { promise: Promise<number | false>; resolve(token: number | false): void }>())
  const readiness = (requested: typeof resource, value = published.current): number | false | undefined => {
    if (!mounted.current || currentResource.current !== requested || requested.tabSignal.aborted) return false
    if (failedOwner.current?.resource === requested && failedOwner.current.revision === latest.current.content.revision) return false
    const { snapshot, displayOwner, pdf } = value
    if (!snapshot || !pdf || displayOwner?.resource !== requested
      || displayOwner.token !== ownerSequence.current || displayOwner.content.revision !== latest.current.content.revision
      || activePdf.current?.document !== pdf || activePdf.current.identity !== readerIdentity(snapshot)) return
    return displayOwner.token
  }
  const settleWaiters = () => {
    for (const [requested, waiter] of waiters.current) {
      const token = readiness(requested)
      if (token !== undefined) { waiters.current.delete(requested); waiter.resolve(token) }
    }
  }
  // Same-resource content refreshes temporarily revoke the display owner. Keep
  // an intent until React has published the replacement; never transfer it to
  // another resource, Session, API carrier or tab lifetime.
  const waitForReady = useCallback((): Promise<number | false> => {
    const token = readiness(resource)
    if (token !== undefined) return Promise.resolve(token)
    const pending = waiters.current.get(resource)
    if (pending) return pending.promise
    let resolve!: (token: number | false) => void
    const promise = new Promise<number | false>(finish => { resolve = finish })
    waiters.current.set(resource, { promise, resolve })
    return promise
  }, [resource])
  useLayoutEffect(() => { published.current = rendered.current; settleWaiters() })
  useLayoutEffect(() => {
    const abort = () => settleWaiters()
    tabSignal.addEventListener('abort', abort, { once: true })
    return () => { tabSignal.removeEventListener('abort', abort) }
  }, [tabSignal])

  useEffect(() => {
    const controller = new AbortController()
    const token = ++ownerSequence.current
    failedOwner.current = null
    latest.current.onResourceSwitch()
    const ownerContent = content
    setDisplayOwner(null)
    const stop = () => controller.abort()
    tabSignal.addEventListener('abort', stop, { once: true })
    if (tabSignal.aborted) controller.abort()
    void api.open(sessionId, resourceAddress, controller.signal).then(next => {
      if (!controller.signal.aborted && token === ownerSequence.current) {
        setSnapshot(next)
        setDisplayOwner({ token, content: ownerContent, resource })
      }
    }).catch(failure => {
      if (!controller.signal.aborted && token === ownerSequence.current) {
        failedOwner.current = { resource, revision: ownerContent.revision }
        settleWaiters()
        latest.current.onError(failure)
        ownerContent.failed()
      }
    })
    return () => { controller.abort(); tabSignal.removeEventListener('abort', stop) }
  }, [api, sessionId, resourceAddress, content.revision, tabSignal])

  useEffect(() => snapshot ? api.subscribe(snapshot.id, setSnapshot) : undefined, [api, snapshot?.id])

  useEffect(() => {
    if (!snapshot || !displayOwner || displayOwner.token !== ownerSequence.current) return
    const identity = readerIdentity(snapshot)
    if (activePdf.current?.identity === identity) {
      const latestSnapshot = latestSnapshotRef.current
      displayOwner.content.loaded(latestSnapshot && readerIdentity(latestSnapshot) === identity
        ? latestSnapshot.sourceVersion : snapshot.sourceVersion)
      return
    }
    const priorCapture = latest.current.releaseRegionCapture()
    const controller = new AbortController()
    let accepted = false
    let cancelled = false
    const opening = openNativeDocument(snapshot, sessionId, api.native)
    void opening.then(async opened => {
      if (controller.signal.aborted || cancelled || displayOwner.token !== ownerSequence.current) {
        try { await opened.dispose() }
        catch (failure) { console.warn('[pdf] Could not release a stale document', failure) }
        return
      }
      accepted = true
      const previous = activePdf.current
      activePdf.current = { ...opened, identity }
      latest.current.onNativeOpened()
      setPdf(opened.document)
      setPdfAnnotations(snapshot.baselineAnnotations ?? snapshot.document.annotations)
      const latestSnapshot = latestSnapshotRef.current
      displayOwner.content.loaded(latestSnapshot && readerIdentity(latestSnapshot) === identity
        ? latestSnapshot.sourceVersion : snapshot.sourceVersion)
      await frame()
      await priorCapture?.catch(() => undefined)
      try { await previous?.dispose() }
      catch (failure) { console.warn('[pdf] Could not release the previous document', failure) }
    }).catch(failure => {
      if (!controller.signal.aborted && displayOwner.token === ownerSequence.current) {
        failedOwner.current = { resource: displayOwner.resource, revision: displayOwner.content.revision }
        settleWaiters()
        latest.current.onError(failure)
        displayOwner.content.failed()
      }
    })
    return () => { cancelled = true; if (!accepted) controller.abort() }
  }, [snapshot?.id, snapshot?.reader.bytesHash, snapshot?.reader.generation, displayOwner?.token, api, sessionId])

  const latestSnapshotRef = useRef(snapshot)
  latestSnapshotRef.current = snapshot
  useEffect(() => {
    if (snapshot && displayOwner?.token === ownerSequence.current && activePdf.current?.identity === readerIdentity(snapshot)) {
      displayOwner.content.loaded(snapshot.sourceVersion)
    }
  }, [snapshot?.sourceVersion])

  useLayoutEffect(() => { mounted.current = true; return () => {
    mounted.current = false
    settleWaiters()
    const pendingCapture = latest.current.releaseRegionCapture()
    const closingPdf = activePdf.current
    activePdf.current = null
    void Promise.resolve(pendingCapture).catch(() => undefined).then(() => closingPdf?.dispose())
  } }, [])

  const documentReady = useCallback(() => typeof readiness(resource, rendered.current) === 'number', [resource])
  return { snapshot, setSnapshot, displayOwner, pdf, pdfAnnotations, ownerSequence, activePdf, documentReady, waitForReady }
}
