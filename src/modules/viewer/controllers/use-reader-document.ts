import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const latest = useRef(options)
  latest.current = options
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [displayOwner, setDisplayOwner] = useState<{ token: number; content: ReaderContentLease } | null>(null)
  const [pdf, setPdf] = useState<NativeDocument | null>(null)
  const [pdfAnnotations, setPdfAnnotations] = useState<PdfAnnotation[]>(noAnnotations)
  const ownerSequence = useRef(0)
  const activePdf = useRef<{ document: NativeDocument; identity: string; dispose(): Promise<void> } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const token = ++ownerSequence.current
    latest.current.onResourceSwitch()
    const ownerContent = content
    setDisplayOwner(null)
    const stop = () => controller.abort()
    tabSignal.addEventListener('abort', stop, { once: true })
    if (tabSignal.aborted) controller.abort()
    void api.open(sessionId, resourceAddress, controller.signal).then(next => {
      if (!controller.signal.aborted && token === ownerSequence.current) {
        setSnapshot(next)
        setDisplayOwner({ token, content: ownerContent })
      }
    }).catch(failure => {
      if (!controller.signal.aborted && token === ownerSequence.current) {
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

  useLayoutEffect(() => () => {
    const pendingCapture = latest.current.releaseRegionCapture()
    const closingPdf = activePdf.current
    activePdf.current = null
    void Promise.resolve(pendingCapture).catch(() => undefined).then(() => closingPdf?.dispose())
  }, [])

  const documentReady = () => !!snapshot && !!pdf && activePdf.current?.identity === readerIdentity(snapshot)
  return { snapshot, setSnapshot, displayOwner, pdf, pdfAnnotations, ownerSequence, activePdf, documentReady }
}
