import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OcrTranscriptPanel } from '../../../src/client/viewer/components/OcrTranscriptPanel.js'
import { ReadingSidebar } from '../../../src/client/viewer/components/ReadingSidebar.js'
import { ScrollablePanel } from '../../../src/client/viewer/components/ScrollablePanel.js'
import { readerLocales } from '../../../src/client/viewer/locales.js'
import type { HostOcrRecognition } from '../../../src/client/viewer/ports/ocr.js'

const result: HostOcrRecognition = { documentId: 'layout-document', page: 64, revision: 1, contentVersion: 'layout-v1',
  text: 'Recognized text with a selectable passage.\n第二行识别文字。', status: 'complete',
  source: { backendId: 'layout-ocr', backendVersion: '1' }, geometry: { status: 'none' }, warnings: [] }
const calls: ({ start: number; end: number } | undefined)[] = []

function Fixture() {
  const [locale, setLocale] = useState<'en' | 'zh'>('en')
  const t = (key: string) => readerLocales[locale][key] ?? key
  Object.assign(window, { __pdfOcrToolbarLayout: { locale: setLocale, calls: () => calls } })
  return <div className="dsh-pdf-reader"><div className="dsh-pdf-body">
    <ReadingSidebar activeSection="ocr" onSectionChange={() => {}} expanded onExpandedChange={() => {}}
      panels={{ ocr: <ScrollablePanel className="dsh-pdf-ocr-scroll" title={t('reader.sidebar.ocr')}
        verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
        <OcrTranscriptPanel result={result} region t={t} onTranslate={range => { calls.push(range) }} />
      </ScrollablePanel> }} pdf={null} currentPage={64} pageInput="64" navigating={false}
      onPageInputChange={() => {}} onPageInputSubmit={() => {}} onPageInputReset={() => {}}
      onNavigatePage={() => {}} onStepPage={() => {}} onNavigateDestination={() => {}} t={t} />
  </div></div>
}

createRoot(document.getElementById('ocr-toolbar-layout-root')!).render(<Fixture />)
