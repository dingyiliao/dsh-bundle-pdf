import type { DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { PdfClientApi, PdfSettings } from '../shared/contracts.ts'
import type { TranslationRegistry } from '../translation/index.js'
import type { HostOcrApi, ImageUnderstandingApi, PdfReadingContextUpdate, PdfAgentNavigationApi,
  PdfRegionEvidenceApi, PdfTextSelectionEvidenceApi, PdfIndexingApi } from '../modules/viewer/index.js'
import type { PromptContentPart } from '../modules/explanation/index.js'
import type { PdfEvidenceNavigation } from './toolview/pdf-evidence-navigation.js'
import type { EngineCatalogSnapshot } from '../modules/engines/index.js'

export type { PdfClientApi, PdfSettings, WorkspaceSnapshot } from '../shared/contracts.ts'
export type { PdfReadingContextUpdate } from '../modules/viewer/index.js'

export type ReaderProps = Pick<DocumentPreviewProps, 'resourceAddress' | 'scrollportRef' | 'useTabInfo'> & {
  // Resource addresses are decoded into plain strings; DSH's slot owns the branded SessionId.
  sessionId: string
  content: Extract<DocumentPreviewProps['content'], { kind: 'renderer' }>
  t: (key: string) => string
  api: PdfClientApi
  hostOcr: HostOcrApi
  indexingApi?: PdfIndexingApi
  engineCatalog?: EngineCatalogSnapshot
  imageUnderstanding: ImageUnderstandingApi
  /** Host-owned, source-fenced image regions for explanation questions. */
  regionEvidence?: PdfRegionEvidenceApi
  textSelectionEvidence?: PdfTextSelectionEvidenceApi
  translation: TranslationRegistry
  settings: PdfSettings
  /** Persist the translation target for the next selection in this profile. */
  rememberTranslationTargetLanguage?: (language: string) => Promise<boolean>
  /** Desktop-only native Save As chooser; the browser keeps the in-page fallback. */
  pickSavePath?: (defaultPath: string) => Promise<string | null>
  /** Shell-specific resource address creation lives outside the Viewer. */
  addressForPath?: (sessionId: string, path: string) => string
  /** Only the Session which owns the resource may publish its active reader. */
  allowReadingContext?: boolean
  reportReadingContext?: (update: PdfReadingContextUpdate) => Promise<void>
  agentNavigation?: PdfAgentNavigationApi
  /** Append one user turn to this PDF's owning current conversation. */
  promptExplanation?: (content: string | readonly PromptContentPart[], signal: AbortSignal) => Promise<void>
  /** Client-local lease for validated navigation from persisted PDF tool cards. */
  evidenceNavigation?: PdfEvidenceNavigation
}
