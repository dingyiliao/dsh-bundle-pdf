import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts } from 'pdf-lib'
import { readFile } from 'node:fs/promises'

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

/** A stable, editable two-page file that is independent of the plugin's PDF writer. */
export async function sourcePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (const label of ['Browser PDF page one', 'Browser PDF page two']) {
    const page = document.addPage([400, 560])
    page.drawText(label, { x: 50, y: 490, size: 18, font })
  }
  return document.save({ useObjectStreams: false })
}

export async function outlinedSourcePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.load(await sourcePdf())
  const outlines = document.context.obj({ Type: 'Outlines', Count: 2 })
  const outlinesRef = document.context.register(outlines)
  const chapter = document.context.obj({ Title: PDFHexString.fromText('Chapter 1'), Parent: outlinesRef, Count: 1,
    Dest: [document.getPage(1).ref, PDFName.of('XYZ'), 50, 490, null] })
  const chapterRef = document.context.register(chapter)
  const section = document.context.obj({ Title: PDFHexString.fromText('Section 1'), Parent: chapterRef,
    Dest: [document.getPage(1).ref, PDFName.of('XYZ'), 50, 490, null] })
  const sectionRef = document.context.register(section)
  chapter.set(PDFName.of('First'), sectionRef); chapter.set(PDFName.of('Last'), sectionRef)
  outlines.set(PDFName.of('First'), chapterRef); outlines.set(PDFName.of('Last'), chapterRef)
  document.catalog.set(PDFName.of('Outlines'), outlinesRef)
  return document.save({ useObjectStreams: false })
}

/** Real PDF outline destinations exercise the reader's vertical and rectangle fit modes. */
export async function fittedOutlinePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= 4; number++) {
    const page = document.addPage([400, 560])
    page.drawText(`Fit destination page ${number}`, { x: 50, y: 490, size: 18, font })
  }
  const outlines = document.context.obj({ Type: 'Outlines', Count: 2 })
  const outlinesRef = document.context.register(outlines)
  const vertical = document.context.obj({ Title: PDFHexString.fromText('Fit vertical'), Parent: outlinesRef,
    Dest: [document.getPage(1).ref, PDFName.of('FitV'), 70] })
  const rectangle = document.context.obj({ Title: PDFHexString.fromText('Fit rectangle'), Parent: outlinesRef,
    Dest: [document.getPage(2).ref, PDFName.of('FitR'), 50, 120, 350, 430] })
  const verticalRef = document.context.register(vertical)
  const rectangleRef = document.context.register(rectangle)
  vertical.set(PDFName.of('Next'), rectangleRef)
  rectangle.set(PDFName.of('Prev'), verticalRef)
  outlines.set(PDFName.of('First'), verticalRef)
  outlines.set(PDFName.of('Last'), rectangleRef)
  document.catalog.set(PDFName.of('Outlines'), outlinesRef)
  return document.save({ useObjectStreams: false })
}

/** An external-reader highlight with two /IRT replies and a nested follow-up. */
export async function externalThreadPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.load(await sourcePdf())
  const page = document.getPage(0)
  const root = document.context.register(document.context.obj({
    Type: 'Annot', Subtype: 'Highlight', P: page.ref, Rect: [48, 485, 270, 510],
    QuadPoints: [48, 510, 270, 510, 48, 485, 270, 485], C: [1, 1, 0], F: 4,
    NM: PDFString.of('external-thread-root'), T: PDFString.of('Document owner'),
  }))
  const alice = document.context.register(document.context.obj({
    Type: 'Annot', Subtype: 'Text', P: page.ref, Rect: [48, 485, 68, 505],
    IRT: root, RT: 'R', Contents: PDFHexString.fromText('Alice asks about the method'),
    T: PDFHexString.fromText('Alice'), CreationDate: PDFString.of("D:20261017100500+08'00'"),
    M: PDFString.of("D:20261017100500+08'00'"),
  }))
  const bob = document.context.register(document.context.obj({
    Type: 'Annot', Subtype: 'Text', P: page.ref, Rect: [48, 485, 68, 505],
    IRT: alice, RT: 'R', Contents: PDFHexString.fromText('Bob follows up'),
    T: PDFHexString.fromText('Bob'), CreationDate: PDFString.of("D:20261017102000+08'00'"),
    M: PDFString.of("D:20261017102000+08'00'"),
  }))
  page.node.set(PDFName.of('Annots'), document.context.obj([root, alice, bob]))
  return document.save({ useObjectStreams: false })
}

/** A selectable text mark without a comment, for the on-page comment flow. */
export async function uncommentedHighlightPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.load(await sourcePdf())
  const target = document.getPage(0)
  const annotation = document.context.obj({
    Type: 'Annot', Subtype: 'Highlight', P: target.ref, Rect: [48, 485, 270, 510],
    QuadPoints: [48, 510, 270, 510, 48, 485, 270, 485], C: [1, 1, 0], F: 4,
  })
  target.node.set(PDFName.of('Annots'), document.context.obj([document.context.register(annotation)]))
  return document.save({ useObjectStreams: false })
}

/** A distant narrow note page centered beyond the horizontal viewport at 100% zoom. */
export async function widePageWithNotePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index < WIDE_NOTE_PAGE; index++) {
    const page = document.addPage([4000, 560])
    if (index === 1) page.drawText('Wide first page', { x: 50, y: 490, size: 18, font })
  }
  const target = document.addPage([300, 560])
  target.drawText('Narrow note page', { x: 50, y: 490, size: 18, font })
  const annotation = document.context.obj({
    Type: 'Annot', Subtype: 'Text', P: target.ref, Rect: [50, 440, 70, 460],
    Contents: PDFHexString.fromText('Narrow-page note'), Name: PDFName.of('Comment'),
  })
  target.node.set(PDFName.of('Annots'), document.context.obj([document.context.register(annotation)]))
  return document.save({ useObjectStreams: false })
}

export async function distantHighlightPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index < WIDE_NOTE_PAGE; index++) document.addPage([4000, 560])
  const target = document.addPage([300, 560])
  target.drawText('Highlighted target page', { x: 50, y: 490, size: 18, font })
  const annotation = document.context.obj({
    Type: 'Annot', Subtype: 'Highlight', P: target.ref, Rect: [48, 485, 270, 510],
    QuadPoints: [48, 510, 270, 510, 48, 485, 270, 485],
    Contents: PDFHexString.fromText('Distant highlight'), C: [1, 1, 0], F: 4,
  })
  target.node.set(PDFName.of('Annots'), document.context.obj([document.context.register(annotation)]))
  return document.save({ useObjectStreams: false })
}

/** Same-size pages reproduce a distant highlight jump in a book-length PDF. */
export async function longHighlightPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= LONG_ANNOTATION_PAGE_COUNT; number++) {
    const page = document.addPage([595.28, 841.89])
    if (number === LONG_ANNOTATION_TARGET) {
      page.drawText('Highlighted destination', { x: 50, y: 760, size: 18, font })
      const annotation = document.context.obj({
        Type: 'Annot', Subtype: 'Highlight', P: page.ref, Rect: [48, 755, 295, 780],
        QuadPoints: [48, 780, 295, 780, 48, 755, 295, 755],
        Contents: PDFHexString.fromText('Distant book highlight'), C: [1, 0.5, 0], F: 4,
      })
      page.node.set(PDFName.of('Annots'), document.context.obj([document.context.register(annotation)]))
    } else if (number === LONG_ANNOTATION_SOURCE) {
      page.drawText('Starting page', { x: 50, y: 760, size: 18, font })
    }
  }
  return document.save({ useObjectStreams: false })
}

/** Keep the large fixture small on disk while exercising a distant page. */
export async function manyPageSourcePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= LARGE_PAGE_COUNT; number++) {
    const page = document.addPage([400, 560])
    if (number === 1 || number === 2 || number === 115 || number === LARGE_PAGE_COUNT) {
      page.drawText(`Browser PDF page ${number}`, { x: 50, y: 490, size: 18, font })
    }
    if (number === 1 || number === LARGE_PAGE_COUNT) {
      const action = number === 1 ? 'LastPage' : 'FirstPage'
      const link = document.context.obj({ Type: 'Annot', Subtype: 'Link', P: page.ref, Rect: [50, 430, 180, 455],
        A: { S: PDFName.of('Named'), N: PDFName.of(action) } })
      page.node.set(PDFName.of('Annots'), document.context.obj([document.context.register(link)]))
    }
  }
  return document.save({ useObjectStreams: false })
}

/** Read the saved file with pdf-lib, separately from the Host's edit result. */
export async function savedNoteContents(path: string): Promise<string[]> {
  const document = await PDFDocument.load(await readFile(path))
  const array = document.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  if (!array) return []
  const contents: string[] = []
  for (let index = 0; index < array.size(); index++) {
    const annotation = document.context.lookup(array.get(index), PDFDict)
    if (annotation.lookup(PDFName.of('Subtype'), PDFName).asString() !== '/Text') continue
    contents.push(annotation.lookup(PDFName.of('Contents'), PDFHexString).decodeText())
  }
  return contents
}

export async function savedHighlightColors(path: string): Promise<number[][]> {
  const document = await PDFDocument.load(await readFile(path))
  const annotations = document.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  if (!annotations) return []
  const colors: number[][] = []
  for (let index = 0; index < annotations.size(); index++) {
    const annotation = document.context.lookup(annotations.get(index), PDFDict)
    if (annotation.lookup(PDFName.of('Subtype'), PDFName).asString() !== '/Highlight') continue
    const color = annotation.lookup(PDFName.of('C'), PDFArray)
    if (color) colors.push([0, 1, 2].map(channel => color.lookup(channel, PDFNumber).asNumber()))
  }
  return colors
}
