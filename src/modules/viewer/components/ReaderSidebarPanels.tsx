import type { PdfAnnotation } from '../../../core/pdf-types.js'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { TranslationRegistry } from '../../../translation/index.js'
import type { NativeDocument } from '../rendering/document.js'
import type { useReaderOcr } from '../controllers/use-reader-ocr.js'
import type { useReaderSearch } from '../controllers/use-reader-search.js'
import type { useReaderTranslation } from '../controllers/use-reader-translation.js'
import type { ReaderIndexingControl } from '../controllers/use-reader-indexing.js'
import { AnnotationList } from './AnnotationList.js'
import { OcrTranscriptPanel } from './OcrTranscriptPanel.js'
import { ScrollablePanel } from './ScrollablePanel.js'
import { TranslationPanel } from './TranslationPanel.js'
import { DocumentIndexSettings } from './DocumentIndexSettings.js'
import type { EngineCatalogSnapshot } from '../../engines/index.js'

type OcrTranscript = ReturnType<typeof useReaderOcr>['ocrTranscript']
type Search = ReturnType<typeof useReaderSearch>
type Translation = ReturnType<typeof useReaderTranslation>

export interface ReaderSidebarPanelsOptions {
  snapshot: WorkspaceSnapshot | null
  pdf: NativeDocument | null
  annotations: PdfAnnotation[]
  selectedAnnotation?: string
  clearAnnotation(): void
  selectAnnotation(id: string): void
  jump(page: number, point?: { x?: number; y?: number }): void
  ocrTranscript: OcrTranscript
  search: Search
  indexing?: ReaderIndexingControl
  engineCatalog?: EngineCatalogSnapshot
  translation: Translation
  rememberTargetLanguage?: (language: string) => Promise<boolean>
  translationEngine: string
  translationRegistry: TranslationRegistry
  t: (key: string) => string
}

/** Four independent feature panels sharing the same Reader sidebar chrome. */
export function readerSidebarPanels(options: ReaderSidebarPanelsOptions) {
  const { snapshot, pdf, annotations, selectedAnnotation, clearAnnotation, selectAnnotation,
    jump, ocrTranscript, search, indexing, translation, rememberTargetLanguage, translationEngine,
    translationRegistry, t } = options
  const activeTranscript = snapshot && ocrTranscript
    && ocrTranscript.result.documentId === snapshot.id
    && ocrTranscript.result.contentVersion === snapshot.contentVersion ? ocrTranscript : null
  return {
    annotations: <AnnotationList key={`${snapshot?.id ?? 'none'}:${snapshot?.reader.bytesHash ?? 'none'}`}
        annotations={annotations} selectedId={selectedAnnotation} pdf={pdf} t={t}
        onDeselect={clearAnnotation}
        onSelect={annotation => { selectAnnotation(annotation.id)
          jump(annotation.page, annotation.rect ? { x: annotation.rect[0], y: annotation.rect[3] } : {}) }} />,
    ocr: <ScrollablePanel className="dsh-pdf-ocr-scroll" verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}
      title={t('reader.sidebar.ocr')}>
      <OcrTranscriptPanel result={activeTranscript?.result ?? null} region={!!activeTranscript?.region} t={t} />
    </ScrollablePanel>,
    search: <ScrollablePanel className="dsh-pdf-search-panel" verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}
      title={t('reader.search')}>
      <form onSubmit={event => { event.preventDefault(); void search.run() }}>
        <input aria-label={t('reader.search')} placeholder={t('reader.searchPlaceholder')}
          value={search.query} onChange={event => search.setQuery(event.target.value)} />
        <button disabled={search.searching || !search.query.trim() || !pdf}>
          {search.searching ? t('reader.searching') : t('reader.search')}</button>
      </form>
      <p className="dsh-pdf-muted">{t('reader.searchCoverage')}</p>
      {indexing && <DocumentIndexSettings key={indexing.configuration?.identity ?? snapshot?.id}
        control={indexing} catalog={options.engineCatalog} t={t} />}
      {search.searched && <p>{search.hits.length ? `${search.hits.length}${search.hits.length >= 500 ? '+' : ''} ${t('reader.results')}` : t('reader.noResults')}</p>}
      {search.hits.map((hit, index) => <button className="dsh-pdf-search-hit" key={index}
        onClick={() => jump(hit.page, hit.x === undefined || hit.y === undefined ? {} : { x: hit.x, y: hit.y })}>
        <strong>{t('reader.page')} {hit.page} · {hit.source === 'ocr'
          ? t(hit.x === undefined ? 'reader.ocrPageMatch' : 'reader.ocrText') : t('reader.nativeText')}</strong>
        <span>{hit.text}</span>
      </button>)}
    </ScrollablePanel>,
    translation: translation.selection ? <TranslationPanel selection={translation.selection} translate={translation.translate}
      rememberTargetLanguage={rememberTargetLanguage} onClose={translation.close} t={t}
      engineName={translationEngine === 'dsh-model' ? t('reader.translationDshModel')
        : translationRegistry.list().find(engine => engine.id === translationEngine)?.name ?? translationEngine} />
      : <ScrollablePanel className="dsh-pdf-translation-panel" title={t('reader.sidebar.translation')}
        verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
        <p className="dsh-pdf-muted">{t('reader.sidebar.translationHint')}</p>
      </ScrollablePanel>,
  }
}
