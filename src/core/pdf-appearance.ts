import { PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib'
import type { EditableAnnotationType, PdfColor, PdfRect } from './pdf-types.js'

/** Explicit appearances keep saved annotations visible in readers without appearance synthesis. */
export function setAnnotationAppearance(
  doc: PDFDocument,
  dictionary: PDFDict,
  subtype: EditableAnnotationType,
  rect: PdfRect,
  quadPoints: number[] | undefined,
  color: PdfColor,
) {
  const [left, bottom, right, top] = rect
  const width = right - left
  const height = top - bottom
  const opacityObject = dictionary.lookupMaybe(PDFName.of('CA'), PDFNumber)
  const opacity = opacityObject?.asNumber() ?? (subtype === 'Highlight' ? 0.4 : 1)
  const f = (value: number) => Number(value.toFixed(5)).toString()
  const at = (x: number, y: number) => `${f(x - left)} ${f(y - bottom)}`
  const commands = ['q', '/GS0 gs', `${color.map(f).join(' ')} rg`, `${color.map(f).join(' ')} RG`]
  if (subtype === 'Text') {
    commands.push(`0.7 w 0.5 0.5 ${f(Math.max(0, width - 1))} ${f(Math.max(0, height - 1))} re B`)
    commands.push('0.2 0.2 0.2 RG')
    for (const ratio of [0.3, 0.5, 0.7]) {
      commands.push(`${f(width * 0.22)} ${f(height * ratio)} m ${f(width * 0.78)} ${f(height * ratio)} l S`)
    }
  } else {
    const quads = quadPoints?.length ? quadPoints : [left, top, right, top, left, bottom, right, bottom]
    for (let offset = 0; offset < quads.length; offset += 8) {
      const q = quads.slice(offset, offset + 8)
      if (subtype === 'Highlight') {
        commands.push(`${at(q[0], q[1])} m ${at(q[2], q[3])} l ${at(q[6], q[7])} l ${at(q[4], q[5])} l h f`)
      } else {
        const lineHeight = Math.hypot(q[0] - q[4], q[1] - q[5])
        const ratio = subtype === 'StrikeOut' ? 0.5 : 0.06
        const x1 = q[4] + (q[0] - q[4]) * ratio
        const y1 = q[5] + (q[1] - q[5]) * ratio
        const x2 = q[6] + (q[2] - q[6]) * ratio
        const y2 = q[7] + (q[3] - q[7]) * ratio
        commands.push(`${f(Math.max(0.5, lineHeight * 0.065))} w ${at(x1, y1)} m ${at(x2, y2)} l S`)
      }
    }
  }
  commands.push('Q')
  const resources = doc.context.obj({
    ExtGState: {
      GS0: {
        Type: 'ExtGState',
        ca: Math.max(0, Math.min(1, opacity)),
        CA: Math.max(0, Math.min(1, opacity)),
        BM: subtype === 'Highlight' ? 'Multiply' : 'Normal',
      },
    },
  })
  const appearance = doc.context.flateStream(commands.join('\n'), {
    Type: 'XObject', Subtype: 'Form', FormType: 1,
    BBox: [0, 0, width, height], Resources: resources,
  })
  dictionary.set(PDFName.of('AP'), doc.context.obj({ N: doc.context.register(appearance) }))
  dictionary.delete(PDFName.of('AS'))
}
