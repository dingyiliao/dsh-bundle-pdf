import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnnotationList } from '../../../src/modules/viewer/components/AnnotationList.js'
import type { PdfAnnotation } from '../../../src/core/pdf-types.js'
import type { NativeDocument } from '../../../src/modules/viewer/index.js'

const notes: PdfAnnotation[] = Array.from({ length: 1000 }, (_, index) => ({
  id: `note-${index}`, page: 1, subtype: 'Text', flags: 4, supported: true, editable: true,
  rect: [40, 40, 60, 60], contents: `Note ${index}`,
}))
const multiPageNotes: PdfAnnotation[] = notes.map((annotation, index) => ({ ...annotation, page: index % 12 + 1 }))
const highlights: PdfAnnotation[] = Array.from({ length: 120 }, (_, index) => ({
  id: `highlight-${index}`, page: Math.floor(index / 10) + 1, subtype: 'Highlight',
  flags: 4, supported: true, editable: true,
  // Page 2 intentionally has no matching text: revisits also test negative caching.
  rect: index >= 10 && index < 20 ? [200, 200, 220, 220] : [64, 98, 118, 110],
  quadPoints: index >= 10 && index < 20 ? undefined : [64, 110, 118, 110, 64, 98, 118, 98],
  contents: `Comment ${index}`,
}))
const reads: number[] = []
const pdf = { async text(page: number) {
  reads.push(page)
  return { lang: null, styles: {}, items: [{ str: 'Target phrase', transform: [10, 0, 0, 10, 60, 100],
    width: 70, height: 10, dir: 'ltr', fontName: 'nativeSans', hasEOL: false }] }
} }
const labels: Record<string, string> = {
  'reader.comments': 'Annotations', 'reader.filterAnnotations': 'Filter annotations',
  'reader.allAnnotations': 'All annotations', 'reader.annotationPagePrefix': 'Page ',
  'reader.annotationPageSuffix': '', 'reader.type.Text': 'Note', 'reader.type.Highlight': 'Highlight',
}

function Fixture() {
  const [mode, setMode] = useState<'notes' | 'multi-page-notes' | 'highlights'>('notes')
  const [selectedId, setSelectedId] = useState<string>()
  Object.assign(window, { annotationListProbe: { setMode, reads } })
  return <div className="dsh-pdf-reader"><div className="dsh-pdf-comments">
    <div className="dsh-pdf-panel-scroll"><AnnotationList
      annotations={mode === 'notes' ? notes : mode === 'multi-page-notes' ? multiPageNotes : highlights}
      selectedId={selectedId} pdf={mode === 'highlights' ? pdf as unknown as NativeDocument : null}
      details={<div id="annotation-test-editor"><textarea aria-label="Annotation editor" defaultValue="Comment" /></div>}
      onSelect={item => setSelectedId(item.id)} onDeselect={() => setSelectedId(undefined)} t={key => labels[key] ?? key} />
    </div>
  </div></div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
