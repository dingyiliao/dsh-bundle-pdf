import type { PdfPageInfo } from '../../core/pdf-types.js'
import type { NativeTextContent } from '../../shared/native.js'
import type { OcrOutput } from '../../ocr/types.js'
import { NativeViewport } from '../../shared/geometry/native-viewport.js'

export const RECOVERED_TEXT_WARNING = 'Local OCR repaired an invalid PDF character mapping. Text and selection geometry are approximate; verify important content against the page image.'

/** One positioned layer replaces the broken layer; never stack duplicate selectable words. */
export function recoveredPageText(output: OcrOutput, geometry: PdfPageInfo,
  width: number, height: number): NativeTextContent {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2048)) {
    throw Object.assign(new Error('Invalid text recovery image dimensions'), { code: 'pdf/text-recovery-failed' })
  }
  const viewport = new NativeViewport(geometry, 1)
  const point = (x: number, y: number) => viewport.convertToPdfPoint(x * viewport.width / width, y * viewport.height / height)
  const words = output.words.filter(word => word.text.trim() && word.box
    && [word.box.x0, word.box.y0, word.box.x1, word.box.y1].every(Number.isFinite)
    && word.box.x0 >= 0 && word.box.y0 >= 0 && word.box.x1 <= width && word.box.y1 <= height
    && word.box.x1 > word.box.x0 && word.box.y1 > word.box.y0)
  if (!words.length || words.length > 10000 || words.reduce((sum, word) => sum + word.text.length, 0) > 200000) {
    throw Object.assign(new Error('Local OCR did not return a bounded, positioned text layer'), { code: 'pdf/text-recovery-failed' })
  }
  return { items: words.map((word, index) => {
    const box = word.box!, next = words[index + 1]
    const sameLine = next?.parentId !== undefined && next.parentId === word.parentId
    const end = sameLine && next.box!.x0 > box.x1 ? next.box!.x0 : box.x1
    const tl = point(box.x0, box.y0), tr = point(end, box.y0), bl = point(box.x0, box.y1)
    const runWidth = Math.hypot(tr[0] - tl[0], tr[1] - tl[1])
    const runHeight = Math.hypot(bl[0] - tl[0], bl[1] - tl[1])
    return { str: word.text + (sameLine ? ' ' : ''),
      transform: [(tr[0] - tl[0]) / runWidth * runHeight, (tr[1] - tl[1]) / runWidth * runHeight,
        tl[0] - bl[0], tl[1] - bl[1], bl[0], bl[1]],
      width: runWidth, height: runHeight, dir: 'ltr', fontName: 'recoveredSans', hasEOL: !sameLine }
  }), styles: { recoveredSans: { fontFamily: 'sans-serif', ascent: 1, descent: 0, vertical: false } },
  lang: null, extraction: 'local-ocr', warnings: [RECOVERED_TEXT_WARNING,
    ...(output.status === 'partial' ? ['Local recognition is partial; some page text may be missing.'] : []), ...output.warnings.slice(0, 3)] }
}
