import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { readerStyles } from '../../../src/client/reader-styles.js'
import { ReadingSidebar } from '../../../src/client/viewer/components/ReadingSidebar.js'
import { ScrollablePanel } from '../../../src/client/viewer/components/ScrollablePanel.js'
import { readerLocales } from '../../../src/client/viewer/locales.js'

const style = document.createElement('style')
style.textContent = readerStyles
document.head.append(style)
const t = (key: string) => readerLocales.en[key] ?? key

function Fixture() {
  const [expanded, setExpanded] = useState(true)
  const [documentClicks, setDocumentClicks] = useState(0)
  const [panelClicks, setPanelClicks] = useState(0)
  return <div className="dsh-pdf-reader"><div className="dsh-pdf-body">
    <div className="sidebar-glass-document" data-testid="glass-document" onClick={() => setDocumentClicks(value => value + 1)}>
      <p>Original PDF text remains readable here, but should be diffused behind the reading sidebar.</p>
      <output data-testid="document-clicks">{documentClicks}</output>
    </div>
    <ReadingSidebar activeSection="ocr" onSectionChange={() => {}} expanded={expanded} onExpandedChange={setExpanded}
      panels={{ ocr: <ScrollablePanel className="dsh-pdf-ocr-scroll" title={t('reader.sidebar.ocr')}
        verticalLabel={t('reader.verticalScroll')} horizontalLabel={t('reader.horizontalScroll')}>
        <div data-testid="glass-sample" style={{ height: 120 }} />
        <button type="button" data-testid="glass-panel-action" onClick={() => setPanelClicks(value => value + 1)}>Panel action</button>
        <p>Recognized text belongs above the frosted material.</p>
        <output data-testid="panel-clicks">{panelClicks}</output>
      </ScrollablePanel> }} pdf={null} currentPage={64} pageInput="64" navigating={false}
      onPageInputChange={() => {}} onPageInputSubmit={() => {}} onPageInputReset={() => {}}
      onNavigatePage={() => {}} onStepPage={() => {}} onNavigateDestination={() => {}} t={t} />
  </div></div>
}

createRoot(document.getElementById('sidebar-glass-root')!).render(<Fixture />)
