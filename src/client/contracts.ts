import type { DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { PdfClientApi, PdfSettings } from '../shared/contracts.ts'
import type { TranslationRegistry } from '../translation/index.js'
import type { HostOcrApi } from './host-ocr-api.js'
import type { ImageUnderstandingApi } from './image-understanding-api.js'
import type { PromptContentPart } from './explain-mode.js'

export type { PdfClientApi, PdfSettings, WorkspaceSnapshot } from '../shared/contracts.ts'

/** Volatile reading position; no PDF text or selection crosses this channel. */
export type PdfReadingContextUpdate =
  | { action: 'set'; sessionId: string; tabId: string; leaseId: string;
    documentId: string; contentVersion: string; page: number }
  | { action: 'clear'; sessionId: string; tabId: string; leaseId: string }

export type ReaderProps = Pick<DocumentPreviewProps, 'resourceAddress' | 'scrollportRef' | 'useTabInfo'> & {
  // Resource addresses are decoded into plain strings; DSH's slot owns the branded SessionId.
  sessionId: string
  content: Extract<DocumentPreviewProps['content'], { kind: 'renderer' }>
  t: (key: string) => string
  api: PdfClientApi
  hostOcr: HostOcrApi
  imageUnderstanding: ImageUnderstandingApi
  translation: TranslationRegistry
  settings: PdfSettings
  /** Persist the translation target for the next selection in this profile. */
  rememberTranslationTargetLanguage?: (language: string) => Promise<boolean>
  /** Desktop-only native Save As chooser; the browser keeps the in-page fallback. */
  pickSavePath?: (defaultPath: string) => Promise<string | null>
  /** Only the Session which owns the resource may publish its active reader. */
  allowReadingContext?: boolean
  reportReadingContext?: (update: PdfReadingContextUpdate) => Promise<void>
  /** Append one user turn to this PDF's owning current conversation. */
  promptExplanation?: (content: string | readonly PromptContentPart[], signal: AbortSignal) => Promise<void>
}
