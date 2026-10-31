import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PdfDocumentIndexPolicy, PdfDocumentIndexSettings, PdfIndexingTask } from '../../../contracts/indexing.js'
import type { PdfIndexingApi, PdfIndexingClientSnapshot } from '../ports/indexing.js'
import type { FloatingStatus } from '../components/FloatingStatusRail.js'

const empty: PdfIndexingClientSnapshot = { status: 'unavailable', enabled: false, tasks: [] }

export interface ReaderIndexingControl {
  disabled: boolean
  enabled: boolean
  label: string
  statusLabel: string
  onStart(): void
  onRebuild?(): void
  configuration?: {
    identity: string
    value: PdfDocumentIndexSettings
    disabled: boolean
    saving: boolean
    configure(policy: PdfDocumentIndexPolicy): Promise<boolean>
    useDefaults(): Promise<boolean>
  }
}
export interface ReaderIndexingOptions {
  api?: PdfIndexingApi
  sessionId: string
  documentId?: string
  signal: AbortSignal
  t(key: string): string
  onError(error: unknown): void
}

function indexingLabel(task: PdfIndexingTask, t: ReaderIndexingOptions['t']): string {
  if (task.state !== 'running' || !task.progress?.phase) return t(`reader.indexing.${task.state}`)
  return t(`reader.indexing.${task.progress.phase === 'ready' ? 'finalizing' : task.progress.phase}`)
}

function IndexTaskContent({ task, connected, t }: { task: PdfIndexingTask; connected: boolean; t(key: string): string }) {
  const progress = task.progress
  return <span className="dsh-pdf-indexing-task">
    <strong className="dsh-pdf-indexing-task-title">{task.title}</strong>
    <span className="dsh-pdf-indexing-phase">{connected ? indexingLabel(task, t) : t('reader.indexing.unavailable')}</span>
    {connected && task.state === 'running' && progress && <>
      <span className="dsh-pdf-indexing-progress-label">{t('reader.indexing.pages')} <span>{progress.indexedPages}/{progress.totalPages}</span></span>
      <progress aria-label={`${t('reader.indexing.pages')}: ${task.title}`} max={progress.totalPages} value={progress.indexedPages} />
      <span className="dsh-pdf-indexing-progress-label">{t('reader.indexing.chunks')} <span>{progress.embeddedChunks}/{progress.totalChunks}</span></span>
      <progress aria-label={`${t('reader.indexing.chunks')}: ${task.title}`} max={Math.max(1, progress.totalChunks)}
        value={progress.indexedPages === progress.totalPages ? progress.embeddedChunks : undefined} />
    </>}
    {connected && progress?.reusedChunks !== undefined && progress.computedChunks !== undefined && <span className="dsh-pdf-indexing-phase">
      {t('reader.indexing.reused')}: {progress.reusedChunks} · {t('reader.indexing.computed')}: {progress.computedChunks}
    </span>}
  </span>
}

/** Render Host-owned work through the existing task rail; commands never invent local success. */
export function useReaderIndexing({ api, sessionId, documentId, signal, t, onError }: ReaderIndexingOptions) {
  const snapshot = useSyncExternalStore(
    useCallback(listener => api?.subscribe(sessionId, listener) ?? (() => {}), [api, sessionId]),
    useCallback(() => api?.getSnapshot(sessionId) ?? empty, [api, sessionId]),
    useCallback(() => api?.getSnapshot(sessionId) ?? empty, [api, sessionId]),
  )
  const requests = useRef(new Map<string, AbortController>())
  const [pending, setPending] = useState(new Set<string>())
  const errorCallback = useRef(onError)
  errorCallback.current = onError
  useEffect(() => {
    setPending(new Set())
    return () => { for (const controller of requests.current.values()) controller.abort(); requests.current.clear() }
  }, [api, sessionId, documentId, signal])

  const connected = snapshot.status === 'ready'
  async function command(action: 'start' | 'rebuild' | 'cancel', target: string): Promise<void> {
    const settings = snapshot.documents?.find(value => value.documentId === target)
    const enabled = settings ? action === 'cancel'
      ? settings.policy.embeddingEngine !== 'none' || settings.activePolicy.embeddingEngine !== 'none'
      : settings.policy.embeddingEngine !== 'none' : snapshot.enabled
    if (!api || !connected || !enabled || signal.aborted || requests.current.has(target)) return
    const controller = new AbortController()
    requests.current.set(target, controller)
    setPending(current => new Set(current).add(target))
    try {
      await api[action](sessionId, target, AbortSignal.any([signal, controller.signal]))
    } catch (error) {
      if (!controller.signal.aborted && !signal.aborted && requests.current.get(target) === controller) errorCallback.current(error)
    } finally {
      if (requests.current.get(target) === controller) {
        requests.current.delete(target)
        setPending(current => { const next = new Set(current); next.delete(target); return next })
      }
    }
  }
  async function configure(action: 'configure' | 'defaults', policy?: PdfDocumentIndexPolicy): Promise<boolean> {
    // The whole policy belongs to this render; borrowing a newer mirror's
    // revision would let a stale UI overwrite another view's changes.
    const settings = snapshot.documents?.find(value => value.documentId === documentId)
    if (!api || !connected || !documentId || !settings || signal.aborted) return false
    const key = `configuration:${documentId}`
    if (requests.current.has(key)) return false
    const controller = new AbortController()
    requests.current.set(key, controller)
    setPending(current => new Set(current).add(key))
    try {
      const active = AbortSignal.any([signal, controller.signal])
      if (action === 'configure') await api.configure(sessionId, documentId, settings.revision, policy!, active)
      else await api.useDefaults(sessionId, documentId, settings.revision, active)
      return !active.aborted && requests.current.get(key) === controller
    } catch (error) {
      if (!controller.signal.aborted && !signal.aborted && requests.current.get(key) === controller) throw error
      return false
    } finally {
      if (requests.current.get(key) === controller) {
        requests.current.delete(key)
        setPending(current => { const next = new Set(current); next.delete(key); return next })
      }
    }
  }
  const statuses: FloatingStatus[] = api ? snapshot.tasks.filter(task => task.state !== 'ready'
    || snapshot.dismissed?.[task.documentId] !== task.occurrence).map(task => {
    const active = task.state === 'queued' || task.state === 'running'
    const completed = task.state === 'ready'
    const settings = snapshot.documents?.find(value => value.documentId === task.documentId)
    const enabled = settings ? active
      ? settings.policy.embeddingEngine !== 'none' || settings.activePolicy.embeddingEngine !== 'none'
      : settings.policy.embeddingEngine !== 'none' : snapshot.enabled
    const action = active ? 'cancel' : task.state === 'failed' ? 'rebuild' : 'start'
    const actionLabel = t(active ? 'reader.cancel' : task.state === 'failed' ? 'reader.indexing.rebuild' : 'reader.indexing.retry')
    return { id: `indexing:${task.documentId}`, occurrence: task.occurrence,
      className: 'dsh-pdf-indexing-status', kind: task.state === 'failed' ? 'error' : 'indexing',
      tone: !connected ? 'neutral' : task.state === 'failed' ? 'error' : task.state === 'ready' ? 'success'
        : task.state === 'running' ? 'progress' : 'neutral',
      activity: connected && active ? 'progress' : 'dot',
      title: task.failureCode ? `${task.title}: ${task.failureCode}` : task.title,
      summary: `${task.title} · ${connected ? indexingLabel(task, t) : t('reader.indexing.unavailable')}`,
      content: <IndexTaskContent task={task} connected={connected} t={t} />,
      actions: completed ? [{ label: t('reader.indexing.done'),
        ariaLabel: `${t('reader.indexing.done')}: ${task.title}`, disabled: !connected,
        onClick: () => api.dismiss(sessionId, task.documentId, task.occurrence) }]
        : [{ label: actionLabel,
          ariaLabel: `${active ? t('reader.indexing.cancel') : actionLabel}: ${task.title}`,
          disabled: !connected || !enabled || pending.has(task.documentId),
          onClick: () => { void command(action, task.documentId) } }],
    } satisfies FloatingStatus
  }) : []
  if (api && snapshot.status === 'unavailable' && documentId) statuses.unshift({ id: 'indexing-connection', kind: 'error',
    activity: 'dot', content: t('reader.indexing.unavailable') })
  const current = snapshot.tasks.find(task => task.documentId === documentId)
  const settings = snapshot.documents?.find(value => value.documentId === documentId)
  const enabled = settings ? settings.policy.embeddingEngine !== 'none' : snapshot.enabled
  const statusLabel = t(!connected ? snapshot.status === 'loading' ? 'reader.indexing.checking' : 'reader.indexing.unavailable'
    : !enabled ? 'reader.indexing.disabled' : current?.state === 'ready' ? 'reader.indexing.ready'
      : current?.state === 'queued' || current?.state === 'running' ? 'reader.indexing.running' : 'reader.indexing.start')
  const control: ReaderIndexingControl | undefined = api ? {
    enabled,
    label: t(settings?.pending || current?.state === 'ready' || current?.state === 'failed' ? 'reader.indexing.update' : 'reader.indexing.start'),
    statusLabel: connected && enabled && current ? indexingLabel(current, t) : statusLabel,
    disabled: !documentId || !connected || !enabled || signal.aborted || pending.has(documentId)
      || pending.has(`configuration:${documentId}`)
      || current?.state === 'queued' || current?.state === 'running',
    onStart: () => { if (documentId) void command('start', documentId) },
    onRebuild: () => { if (documentId) void command('rebuild', documentId) },
    ...(settings ? { configuration: {
      identity: JSON.stringify([sessionId, documentId]), value: settings,
      disabled: !connected || signal.aborted,
      saving: pending.has(`configuration:${documentId}`),
      configure: policy => configure('configure', policy), useDefaults: () => configure('defaults'),
    } } : {}),
  } : undefined
  return { statuses, control }
}
