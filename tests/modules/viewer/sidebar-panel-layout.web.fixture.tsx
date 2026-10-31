import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfAnnotation, PdfOutlineItem } from '../../../src/core/pdf-types.js'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.js'
import { NativeViewport } from '../../../src/shared/geometry/native-viewport.js'
import { BookmarkPanel } from '../../../src/modules/viewer/components/BookmarkPanel.js'
import { PageThumbnailPanel } from '../../../src/modules/viewer/components/PageThumbnailPanel.js'
import { readerSidebarPanels, type ReaderSidebarPanelsOptions } from '../../../src/modules/viewer/components/ReaderSidebarPanels.js'
import { readingSidebarSections, type ReadingSidebarSection } from '../../../src/modules/viewer/components/ReadingSidebar.js'
import type { ReaderDocument, ReaderOutlineItem } from '../../../src/modules/viewer/ports/reader-document.js'
import { readerLocales } from '../../../src/modules/viewer/locales.js'

const actions: string[] = []
const outlines: ReaderOutlineItem[] = Array.from({ length: 80 }, (_, index) => ({
  id: `outline-${index}`, title: `Chapter ${index + 1}: A long document bookmark`, dest: [index, { name: 'XYZ' }, 0, 600, null], items: [],
}))
const outlineItems: PdfOutlineItem[] = outlines.map((item, index) => ({ id: item.id!, title: item.title, page: index + 1, children: [] }))
const pdf: ReaderDocument = {
  numPages: 80,
  async getOutline() { return outlines },
  async getDestination(name) { return name },
  async getPageIndex(ref) { return Number(ref) },
  async getPage(number) {
    return {
      pageNumber: number, rotate: 0, userUnit: 1, view: [0, 0, 400, 600],
      getViewport({ scale, rotation }) { return new NativeViewport({ page: number,
        mediaBox: [0, 0, 400, 600], cropBox: [0, 0, 400, 600], rotation: 0, userUnit: 1 }, scale, rotation) },
      async getTextContent() { return { lang: null, styles: {}, items: [] } },
      async getAnnotations() { return [] },
      async tile() { throw new Error('Layout fixture does not render native tiles') },
      render({ canvas }) {
        const context = canvas.getContext('2d')!
        context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
        context.fillStyle = '#333'; context.font = '12px sans-serif'; context.fillText(`Page ${number}`, 8, 24)
        return { promise: Promise.resolve(), cancel() {} }
      },
    }
  },
}
const annotations: PdfAnnotation[] = Array.from({ length: 80 }, (_, index) => ({
  id: `note-${index}`, page: index + 1, subtype: 'Text', flags: 4, supported: true, editable: true,
  rect: [20, 20, 50, 50], contents: `Reading note ${index + 1}: A useful paragraph to revisit.`,
}))
const snapshot = { id: 'layout-document', contentVersion: 'layout-v1', reader: { bytesHash: 'layout-hash' } } as WorkspaceSnapshot
const original = 'A long selected passage preserves the exact original words and their surrounding context. '.repeat(28)
const translate: ReaderSidebarPanelsOptions['translation']['translate'] = async () => ({
  document: { documentId: snapshot.id, contentVersion: snapshot.contentVersion }, requestId: 1,
  text: '这是一段用于验证侧栏布局的长译文。滚动正文时标题和关闭按钮应始终留在原处，不与正文或滚动条重叠。\n\n'.repeat(36),
  status: 'complete', warnings: [],
  interpretation: { text: `${original} Completed ending.`, kind: 'completion', certainty: 'tentative',
    explanation: 'The selection may end in an incomplete sentence. This proposed completion is contextual evidence, not a replacement for the original. '.repeat(3) },
  source: { engineId: 'layout-fixture', engineVersion: '1', instanceId: 'layout', configurationRevision: '1' },
})

Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  async writeText() { actions.push('copy') },
} })

function Fixture() {
  const [active, setActive] = useState<ReadingSidebarSection>('translation')
  const [translationVisible, setTranslationVisible] = useState(true)
  const [selectedAnnotation, setSelectedAnnotation] = useState<string>()
  const [query, setQuery] = useState('context')
  const t = (key: string) => readerLocales.en[key] ?? key
  Object.assign(window, { __pdfSidebarPanelLayoutFixture: {
    show(section: ReadingSidebarSection) { setActive(section); if (section === 'translation') setTranslationVisible(true) },
    actions: () => [...actions],
  } })
  const panels = readerSidebarPanels({
    snapshot, pdf: pdf as ReaderSidebarPanelsOptions['pdf'], annotations, selectedAnnotation,
    clearAnnotation() { setSelectedAnnotation(undefined) },
    selectAnnotation(id) { setSelectedAnnotation(id); actions.push('annotation') },
    jump() { actions.push('jump') },
    ocrTranscript: { result: { documentId: snapshot.id, contentVersion: snapshot.contentVersion,
      revision: 0, page: 1, text: Array.from({ length: 100 }, (_, index) => `OCR paragraph ${index + 1}: Extracted text from a scanned page.`).join('\n\n'),
      status: 'complete', warnings: [], source: { backendId: 'layout-ocr', backendVersion: '1' }, geometry: { status: 'none' } } },
    search: { query, setQuery, searching: false, searched: true,
      hits: Array.from({ length: 80 }, (_, index) => ({ page: index + 1, source: 'native', text: `Context result ${index + 1}: surrounding document evidence.`, x: 10, y: 20 })),
      async run() { actions.push('search') }, cancel() {}, invalidateDocument() {}, resetContent() {} },
    translation: { selection: translationVisible ? { text: original, pages: [1], targetLanguage: 'zh', owner: 1,
      documentId: snapshot.id, contentVersion: snapshot.contentVersion } : null,
      translate, begin() {}, close() { actions.push('close'); setTranslationVisible(false) }, reset() {} },
    async rememberTargetLanguage() { return true }, translationEngine: 'layout-fixture',
    translationRegistry: { list: () => [] } as unknown as ReaderSidebarPanelsOptions['translationRegistry'], t,
  })
  return <div className="dsh-pdf-reader"><div className="dsh-pdf-body">
    <aside className="dsh-pdf-sidebar dsh-pdf-glass" style={{ inset: 0, width: '100%', maxWidth: '100%' }}>
      <div className="dsh-pdf-sidebar-shell" style={{ width: '100%' }}><div className="dsh-pdf-sidebar-main">
        <div className="dsh-pdf-sidebar-panels">
          {readingSidebarSections.map(section => <div key={section} className="dsh-pdf-sidebar-panel"
            data-layout-panel={section} role="tabpanel" hidden={active !== section}>
            {section === 'pages' ? <PageThumbnailPanel pdf={pdf} active={active === section} currentPage={1}
              onNavigatePage={() => actions.push('page')} t={t} />
              : section === 'bookmarks' ? <BookmarkPanel pdf={pdf} active={active === section} currentPage={1}
                outlineAccess={{ documentId: snapshot.id, revision: 0, items: outlineItems, editable: true, busy: false,
                  async change() { actions.push('bookmark'); return true } }} onNavigateDestination={() => actions.push('bookmark-jump')} t={t} />
                : panels[section]}
          </div>)}
        </div>
      </div></div>
    </aside>
  </div></div>
}

createRoot(document.getElementById('sidebar-layout-root')!).render(<Fixture />)
