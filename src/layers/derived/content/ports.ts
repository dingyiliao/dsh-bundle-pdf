import type { HostWorkspaceSnapshot } from '../../document/working-copy/index.js'
import type { NativeTextContent } from '../../../shared/native.js'

/** Page-reading port used by derived-content production without depending on the facade. */
export interface AgentPageReadPort {
  readPageText(sessionId: string, documentId: string, page: number, signal: AbortSignal): Promise<{
    snapshot: HostWorkspaceSnapshot; content: NativeTextContent
  }>
}

/** Activity emitted by content producers; the facade decides how to persist or present it. */
export interface IndexingDiagnosticActivity {
  page?: number
  layer: 'native' | 'ocr' | 'image' | 'render' | 'embedding'
  event: 'started' | 'ready' | 'failed'
  error?: unknown
}
