import { readFile } from 'node:fs/promises'
import { inspectFixturePdf } from '../../fixtures/native-document.ts'
import { classicPdf, pdfArray, pdfDict, pdfHex, pdfName, pdfString, plainPdf, ref } from '../../fixtures/pdf-fixture-kit.ts'

export const FILE_NAME = 'reader-e2e.pdf'
export const WIDE_NOTE_FILE_NAME = 'reader-wide-note-e2e.pdf'
export const ANNOTATION_FILE_NAME = 'reader-annotation-e2e.pdf'
export const LONG_ANNOTATION_FILE_NAME = 'reader-long-annotation-e2e.pdf'
export const LARGE_FILE_NAME = 'reader-many-pages-e2e.pdf'
export const WIDE_NOTE_PAGE = 25
export const LONG_ANNOTATION_TARGET = 123
export const LONG_ANNOTATION_SOURCE = 752
export const LONG_ANNOTATION_PAGE_COUNT = 1151
export const LARGE_PAGE_COUNT = 128
export const NOTE = 'Saved through the PDF reader browser UI'

const annotation = (subtype: string, rect: string, contents: string, extra = '') =>
  pdfDict({ Type: '/Annot', Subtype: `/${subtype}`, Rect: rect, Contents: pdfHex(contents), F: '4',
    ...(subtype === 'Text' ? {} : { QuadPoints: '[48 510 270 510 48 485 270 485]', C: '[1 0.55 0]' }), ...extra ? { Extra: extra } : {} })

export async function sourcePdf(): Promise<Uint8Array> {
  return plainPdf([{ size: [400, 560], lines: [{ text: 'Browser PDF page one', x: 50, y: 490, size: 18 }] },
    { size: [400, 560], lines: [{ text: 'Browser PDF page two', x: 50, y: 490, size: 18 }] }])
}

function outlinedPdf(pageCount: number, entries: readonly { title: string; page: number; parent?: number; fit?: string }[]): Uint8Array {
  const pageRefs = Array.from({ length: pageCount }, (_, index) => ref(5 + index * 2))
  const objects: string[] = [pdfDict({ Type: '/Catalog', Pages: ref(2), Outlines: ref(5 + pageCount * 2) }),
    pdfDict({ Type: '/Pages', Kids: pdfArray(pageRefs), Count: String(pageCount) }),
    pdfDict({ Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' }),
    pdfDict({ Producer: pdfString('DSH browser fixture') })]
  for (let page = 0; page < pageCount; page++) {
    objects.push(pdfDict({ Type: '/Page', Parent: ref(2), MediaBox: '[0 0 400 560]', Resources: pdfDict({ Font: pdfDict({ F1: ref(3) }) }), Contents: ref(6 + page * 2) }),
      `<< /Length 0 >>\nstream\n\nendstream`)
  }
  const root = 5 + pageCount * 2, first = root + 1
  const children = entries.map((_, index) => entries
    .map((entry, childIndex) => entry.parent === index ? childIndex : -1)
    .filter(index => index >= 0))
  const topLevel = entries.map((entry, index) => entry.parent === undefined ? index : -1).filter(index => index >= 0)
  const items = entries.map((entry, index) => {
    const object = first + index
    const parent = entry.parent === undefined ? root : first + entry.parent
    const siblings = entry.parent === undefined ? topLevel : children[entry.parent]!
    const siblingIndex = siblings.indexOf(index)
    const next = siblingIndex >= 0 && siblings[siblingIndex + 1] !== undefined ? ref(first + siblings[siblingIndex + 1]!) : undefined
    const previous = siblingIndex > 0 ? ref(first + siblings[siblingIndex - 1]!) : undefined
    const descendants = children[index]!
    const destination = entry.fit === '/FitR'
      ? `[${pageRefs[entry.page - 1]} /FitR 0 0 300 310]`
      : entry.fit === '/FitV'
        ? `[${pageRefs[entry.page - 1]} /FitV 0]`
        : `[${pageRefs[entry.page - 1]} ${entry.fit ?? '/Fit'}]`
    return pdfDict({ Title: pdfHex(entry.title), Parent: ref(parent), Dest: destination,
      ...(descendants.length ? { First: ref(first + descendants[0]!), Last: ref(first + descendants[descendants.length - 1]!), Count: String(descendants.length) } : {}),
      ...(next ? { Next: next } : {}), ...(previous ? { Prev: previous } : {}) })
  })
  objects.push(pdfDict({ Type: '/Outlines', Count: String(entries.length),
    ...(topLevel.length ? { First: ref(first + topLevel[0]!), Last: ref(first + topLevel[topLevel.length - 1]!) } : {}) }), ...items)
  return classicPdf(objects, 4)
}

export async function outlinedSourcePdf(): Promise<Uint8Array> {
  return outlinedPdf(2, [{ title: 'Chapter 1', page: 2 }, { title: 'Section 1', page: 2, parent: 0 }])
}

export async function fittedOutlinePdf(): Promise<Uint8Array> {
  // Keep both destinations away from the initial page.  This makes the
  // browser test verify an actual outline jump instead of accidentally
  // passing because the responsive sidebar opened with page 2 already
  // visible.
  return outlinedPdf(4, [{ title: 'Fit vertical', page: 2, fit: '/FitV' }, { title: 'Fit rectangle', page: 3, fit: '/FitR' }])
}

export async function externalThreadPdf(): Promise<Uint8Array> {
  return plainPdf([{ size: [400, 560], lines: [{ text: 'Browser PDF page one', x: 50, y: 490, size: 18 }], annotationObjects: [
    annotation('Highlight', '[48 485 270 510]', ''),
    // plainPdf assigns the first page annotation object number 7.  `/IRT`
    // stores a PDF object reference, not an annotation-array offset; using
    // `0 0 R` here made PDFium correctly treat both replies as orphaned text.
    pdfDict({ Type: '/Annot', Subtype: '/Text', Rect: '[48 485 68 505]', Contents: pdfHex('Alice asks about the method'), IRT: ref(7), RT: '/R', T: pdfHex('Alice'),
      CreationDate: pdfString('D:20260101090000Z'), M: pdfString('D:20260101090000Z') }),
    pdfDict({ Type: '/Annot', Subtype: '/Text', Rect: '[48 485 68 505]', Contents: pdfHex('Bob follows up'), IRT: ref(7), RT: '/R', T: pdfHex('Bob'),
      CreationDate: pdfString('D:20260101091000Z'), M: pdfString('D:20260101091000Z') }),
  ] }])
}

export async function uncommentedHighlightPdf(): Promise<Uint8Array> {
  return plainPdf([{ size: [400, 560], lines: [{ text: 'Browser PDF page one', x: 50, y: 490, size: 18 }], annotationObjects: [annotation('Highlight', '[48 485 270 510]', '')] }])
}

export async function widePageWithNotePdf(): Promise<Uint8Array> {
  return plainPdf(Array.from({ length: WIDE_NOTE_PAGE }, (_, index) => ({ size: index === WIDE_NOTE_PAGE - 1 ? [300, 560] as const : [4000, 560] as const,
    lines: index === 0 || index === WIDE_NOTE_PAGE - 1 ? [{ text: index === 0 ? 'Wide first page' : 'Narrow note page', x: 50, y: 490, size: 18 }] : undefined,
    annotationObjects: index === WIDE_NOTE_PAGE - 1 ? [annotation('Text', '[50 440 70 460]', 'Narrow-page note')] : undefined })))
}

export async function distantHighlightPdf(): Promise<Uint8Array> {
  return plainPdf([...Array.from({ length: WIDE_NOTE_PAGE - 1 }, () => ({ size: [4000, 560] as const })),
    { size: [300, 560], lines: [{ text: 'Highlighted target page', x: 50, y: 490, size: 18 }], annotationObjects: [annotation('Highlight', '[48 485 270 510]', 'Distant highlight')] }])
}

export async function longHighlightPdf(): Promise<Uint8Array> {
  return plainPdf(Array.from({ length: LONG_ANNOTATION_PAGE_COUNT }, (_, index) => ({ size: [595.28, 841.89] as const,
    lines: index + 1 === LONG_ANNOTATION_TARGET || index + 1 === LONG_ANNOTATION_SOURCE ? [{ text: index + 1 === LONG_ANNOTATION_TARGET ? 'Highlighted destination' : 'Starting page', x: 50, y: 760, size: 18 }] : undefined,
    annotationObjects: index + 1 === LONG_ANNOTATION_TARGET ? [annotation('Highlight', '[48 755 295 780]', 'Distant book highlight')] : undefined })))
}

export async function manyPageSourcePdf(): Promise<Uint8Array> {
  return plainPdf(Array.from({ length: LARGE_PAGE_COUNT }, (_, index) => ({ size: [400, 560] as const,
    lines: [1, 2, 115, LARGE_PAGE_COUNT].includes(index + 1) ? [{ text: `Browser PDF page ${index + 1}`, x: 50, y: 490, size: 18 }] : undefined,
    annotationObjects: index === 0 || index + 1 === LARGE_PAGE_COUNT ? [pdfDict({ Type: '/Annot', Subtype: '/Link', Rect: '[50 430 180 455]', A: pdfDict({ S: '/Named', N: pdfName(index === 0 ? 'LastPage' : 'FirstPage') }) })] : undefined })))
}

export async function savedNoteContents(path: string): Promise<string[]> {
  const inspection = await inspectFixturePdf(new Uint8Array(await readFile(path)))
  return inspection.annotations.filter(annotation => annotation.subtype === 'Text' && annotation.contents).map(annotation => annotation.contents!)
}

export async function savedHighlightColors(path: string): Promise<number[][]> {
  const inspection = await inspectFixturePdf(new Uint8Array(await readFile(path)))
  return inspection.annotations.filter(annotation => annotation.subtype === 'Highlight' && annotation.color).map(annotation => annotation.color!)
}
