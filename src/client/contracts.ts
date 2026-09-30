import type { RefCallback } from 'react'
import type { OcrRegistry } from '../ocr/registry.ts'
import type { PdfClientApi, PdfSettings } from '../shared/contracts.ts'
import type { TranslationRegistry } from '../translation/index.js'
import type { NativeDictionary } from './native-dictionary.js'
import type { ReaderDocument } from './reader-document.js'

export type { PdfClientApi, PdfSettings, WorkspaceSnapshot } from '../shared/contracts.ts'

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
  useTabInfo: () => { tab: { id: string; signal: AbortSignal; actions: { openResource(address: string, options?: { replaceTab?: boolean }): void } } }
  t: (key: string) => string
  api: PdfClientApi
  ocr: OcrRegistry
  translation: TranslationRegistry
  dictionary: NativeDictionary
  settings: PdfSettings
  openPdf: (bytes: Uint8Array, signal?: AbortSignal) => Promise<{ document: ReaderDocument; dispose(): Promise<void> }>
}
