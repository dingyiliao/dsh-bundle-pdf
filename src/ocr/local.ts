import {
  OcrError, type OcrBox, type OcrConfiguration, type OcrEngine,
  type OcrOutput, type OcrRequest, type OcrTextPart,
} from './types.js'
import { recognizeInLocalWorker } from './bridge.js'

export interface LocalOcrOptions {
  /** Built src/ocr/local-worker.ts entry served by this plugin. */
  bridgePath?: string
  workerPath?: string
  corePath?: string
  langPath?: string
  /** Trusted application origin. Browser callers normally omit this. */
  origin?: string
  gzip?: boolean
  availableLanguages?: readonly string[]
}

interface LocalWorker {
  recognize(image: Blob, options: Record<string, never>, output: { text: true; blocks: true }): Promise<{ data: unknown }>
  terminate(): Promise<unknown>
}

export interface LocalWorkerOptions {
  workerPath: string
  corePath: string
  langPath: string
  gzip: boolean
  workerBlobURL: false
  cacheMethod: 'none'
  logger: (message: { status: string; progress: number }) => void
  errorHandler: (error: unknown) => void
}

/** Injectable only to exercise cancellation without starting real workers in unit tests. */
export interface LocalOcrDependencies {
  createWorker(languages: string[], mode: 1, options: LocalWorkerOptions): Promise<LocalWorker>
}

function paths(defaults: LocalOcrOptions, config: OcrConfiguration): Pick<LocalWorkerOptions, 'workerPath' | 'corePath' | 'langPath' | 'gzip'> {
  const origin = defaults.origin ?? globalThis.location?.origin
  if (!origin || !/^https?:\/\//.test(origin)) throw new OcrError('not-configured', 'LocalOCR requires the plugin asset server origin.')
  const result = {} as Record<'workerPath' | 'corePath' | 'langPath', string>
  for (const name of ['workerPath', 'corePath', 'langPath'] as const) {
    const raw = config[name] ?? defaults[name]
    if (typeof raw !== 'string' || !raw.trim()) throw new OcrError('not-configured', `LocalOCR requires a local ${name}.`)
    let url: URL
    try { url = new URL(raw, `${new URL(origin).origin}/`) } catch {
      throw new OcrError('not-configured', `LocalOCR ${name} is not a valid URL.`)
    }
    if (url.origin !== new URL(origin).origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
      throw new OcrError('not-configured', `LocalOCR ${name} must use plugin assets on the application origin.`)
    }
    if (name === 'corePath' && /\.m?js$/.test(url.pathname)) {
      throw new OcrError('not-configured', 'LocalOCR corePath must point to the directory containing all core builds.')
    }
    result[name] = name === 'workerPath' ? url.href : url.href.replace(/\/$/, '')
  }
  return { ...result, gzip: typeof config.gzip === 'boolean' ? config.gzip : defaults.gzip ?? true }
}

function bridgePath(defaults: LocalOcrOptions, config: OcrConfiguration): string {
  const raw = config.bridgePath ?? defaults.bridgePath
  const origin = defaults.origin ?? globalThis.location?.origin
  if (typeof raw !== 'string' || !raw.trim() || !origin) throw new OcrError('not-configured', 'LocalOCR requires its local bridgePath.')
  let url: URL
  try { url = new URL(raw, `${new URL(origin).origin}/`) } catch {
    throw new OcrError('not-configured', 'LocalOCR bridgePath is not a valid URL.')
  }
  if (url.origin !== new URL(origin).origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new OcrError('not-configured', 'LocalOCR bridgePath must use plugin assets on the application origin.')
  }
  return url.href
}

type DataNode = { text?: unknown; confidence?: unknown; bbox?: unknown; blocks?: unknown; paragraphs?: unknown; lines?: unknown; words?: unknown }
const nodes = (value: unknown): DataNode[] => Array.isArray(value) ? value.filter((node) => node && typeof node === 'object') : []
const confidence = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
  ? { value, minimum: 0, maximum: 100, meaning: 'Tesseract confidence score; not a calibrated probability.' } : null

function imageBox(value: unknown, width: number, height: number): OcrBox | null {
  if (!value || typeof value !== 'object') return null
  const box = value as OcrBox
  if (![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) || box.x1 < box.x0 || box.y1 < box.y0) return null
  return {
    x0: Math.max(0, Math.min(width, box.x0)), y0: Math.max(0, Math.min(height, box.y0)),
    x1: Math.max(0, Math.min(width, box.x1)), y1: Math.max(0, Math.min(height, box.y1)),
  }
}

export function normalizeTesseractOutput(raw: unknown, width: number, height: number): OcrOutput {
  if (!raw || typeof raw !== 'object' || typeof (raw as DataNode).text !== 'string') {
    throw new OcrError('recognition-failed', 'LocalOCR returned no text result.')
  }
  const data = raw as DataNode
  const blocks: OcrTextPart[] = [], lines: OcrTextPart[] = [], words: OcrTextPart[] = []
  const part = (node: DataNode, id: string, parentId?: string): OcrTextPart => ({
    id, ...(parentId ? { parentId } : {}), text: typeof node.text === 'string' ? node.text : '',
    box: imageBox(node.bbox, width, height), confidence: confidence(node.confidence),
  })
  for (const block of nodes(data.blocks)) {
    const blockId = `block-${blocks.length}`
    blocks.push(part(block, blockId))
    for (const paragraph of nodes(block.paragraphs)) {
      for (const line of nodes(paragraph.lines)) {
        const lineId = `line-${lines.length}`
        lines.push(part(line, lineId, blockId))
        for (const word of nodes(line.words)) words.push(part(word, `word-${words.length}`, lineId))
      }
    }
  }
  const text = data.text as string
  const warnings = text.trim() && !words.length ? ['Recognized text has no word geometry; word selection is unavailable.'] : []
  return {
    text, blocks, lines, words, confidence: confidence(data.confidence), status: 'complete', warnings,
    coverage: [{ x0: 0, y0: 0, x1: width, y1: height }],
  }
}

export function createLocalOcrEngine(defaults: LocalOcrOptions = {}, dependencies?: LocalOcrDependencies): OcrEngine {
  return {
    descriptor: {
      id: 'local', name: 'LocalOCR (Tesseract)', version: 'tesseract.js/7.0.0', execution: 'local',
      languages: defaults.availableLanguages, geometry: ['block', 'line', 'word'], confidence: true,
      maxPixels: 40_000_000,
      configurationFields: [
        { key: 'bridgePath', label: 'Local OCR bridge worker URL', type: 'string', required: true },
        { key: 'workerPath', label: 'Local worker URL', type: 'string', required: true },
        { key: 'corePath', label: 'Local core directory URL', type: 'string', required: true },
        { key: 'langPath', label: 'Local language directory URL', type: 'string', required: true },
      ],
    },
    availability(config) {
      try { paths(defaults, config); if (!dependencies) bridgePath(defaults, config); return { status: 'available' } } catch (error) {
        return { status: 'not-configured', reason: error instanceof Error ? error.message : 'LocalOCR is not configured.' }
      }
    },
    async recognize(request, config) {
      const assets = paths(defaults, config)
      if (defaults.availableLanguages && request.languages.some((language) => !defaults.availableLanguages!.includes(language))) {
        throw new OcrError('not-configured', 'One or more selected OCR languages are not installed locally.')
      }
      return dependencies ? recognizeLocally(request, assets, dependencies)
        : recognizeInLocalWorker(request, assets, bridgePath(defaults, config))
    },
  }
}

export async function recognizeLocally(request: OcrRequest, assets: ReturnType<typeof paths>, dependencies?: LocalOcrDependencies): Promise<OcrOutput> {
  let worker: LocalWorker | undefined
  let stopped = false
  let terminated = false
  const terminate = async () => {
    if (worker && !terminated) {
      terminated = true
      try { await worker.terminate() } catch { /* Worker may already be terminated after an initialization error. */ }
    }
  }
  let rejectAbort: (error: unknown) => void = () => undefined
  const interruption = new Promise<never>((_, reject) => { rejectAbort = reject })
  const interrupt = (reason: unknown) => {
    stopped = true
    rejectAbort(reason)
    void terminate()
  }
  const cancel = () => interrupt(request.signal?.reason instanceof OcrError
    ? request.signal.reason : new OcrError('cancelled', 'LocalOCR was cancelled.'))
  request.signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => interrupt(new OcrError('timeout', 'LocalOCR exceeded its time limit.')), request.timeoutMs ?? 120_000)
  if (request.signal?.aborted) cancel()
  const run = async (): Promise<OcrOutput> => {
    if (stopped) throw new OcrError('cancelled', 'LocalOCR was cancelled.')
    let api: LocalOcrDependencies
    try { api = dependencies ?? await import('tesseract.js') } catch (error) {
      throw new OcrError('dependency-unavailable', 'The local Tesseract module could not be loaded.', { cause: error })
    }
    if (stopped) throw new OcrError('cancelled', 'LocalOCR was cancelled.')
    worker = await api.createWorker([...request.languages], 1, {
      ...assets, workerBlobURL: false, cacheMethod: 'none',
      logger: ({ status, progress }) => {
        if (!stopped) request.onProgress?.({ stage: status, progress: Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : null })
      },
      errorHandler: (error) => interrupt(new OcrError('dependency-unavailable', 'LocalOCR worker or local assets could not be loaded.', { cause: error })),
    })
    // createWorker resolves only after initialization. A cancellation during startup
    // is returned promptly; terminate the late worker as soon as that handle exists.
    if (stopped) { await terminate(); throw new OcrError('cancelled', 'LocalOCR was cancelled.') }
    const image = request.image instanceof Blob ? request.image : new Blob([request.image.slice().buffer])
    const result = await worker.recognize(image, {}, { text: true, blocks: true })
    if (stopped) throw new OcrError('cancelled', 'LocalOCR was cancelled.')
    return normalizeTesseractOutput(result.data, request.width, request.height)
  }
  try {
    return await Promise.race([run(), interruption])
  } catch (error) {
    if (error instanceof OcrError) throw error
    throw new OcrError('recognition-failed', 'LocalOCR failed; check that its worker, core and language assets are installed.', { cause: error })
  } finally {
    stopped = true
    clearTimeout(timeout)
    request.signal?.removeEventListener('abort', cancel)
    await terminate()
  }
}
