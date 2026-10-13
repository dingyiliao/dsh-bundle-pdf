import type { RefCallback } from 'react'
import type { OcrRegistry } from '../ocr/registry.ts'
import type { PdfClientApi, PdfSettings } from '../shared/contracts.ts'
import type { TranslationRegistry } from '../translation/index.js'

export type { PdfClientApi, PdfSettings, WorkspaceSnapshot } from '../shared/contracts.ts'

/** Volatile reading position; no PDF text or selection crosses this channel. */
export type PdfReadingContextUpdate =
  | { action: 'set'; sessionId: string; tabId: string; leaseId: string;
    documentId: string; contentVersion: string; page: number }
  | { action: 'clear'; sessionId: string; tabId: string; leaseId: string }

export interface ReaderProps {
  resourceAddress: string
  sessionId: string
  content: {
    kind: 'renderer'
    revision: number
    loaded(version: string): void
    failed(): void
    reload(): void
  }
  scrollportRef: RefCallback<HTMLElement>
  useTabInfo: () => { tab: { id: string; visible: boolean; signal: AbortSignal;
    actions: { openResource(address: string, options?: { replaceTab?: boolean }): void } } }
  t: (key: string) => string
  api: PdfClientApi
  ocr: OcrRegistry
  translation: TranslationRegistry
  settings: PdfSettings
  /** Desktop-only native Save As chooser; the browser keeps the in-page fallback. */
  pickSavePath?: (defaultPath: string) => Promise<string | null>
  /** Only the Session which owns the resource may publish its active reader. */
  allowReadingContext?: boolean
  reportReadingContext?: (update: PdfReadingContextUpdate) => Promise<void>
}
