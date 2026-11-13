export interface PlainPdfPage {
  size: readonly [number, number]
  rotate?: number
  lines?: readonly { text: string; x: number; y: number; size: number; lineHeight?: number }[]
  operators?: string
  annotationObjects?: readonly string[]
}

/** Deterministic Helvetica fixtures for tests and benchmarks with no external PDF writer. */
export function plainPdf(pages: readonly PlainPdfPage[]): Uint8Array {
  if (!pages.length) throw new Error('A PDF fixture needs at least one page')
  const pageReferences = pages.map((_, index) => `${5 + index * 2} 0 R`)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageReferences.join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /CreationDate (D:20000101000000Z) /ModDate (D:20000101000000Z) /Producer (DSH PDF benchmark) >>',
  ]
  const annotations: string[] = []
  for (const [index, page] of pages.entries()) {
    const textOperators = (page.lines ?? []).flatMap(({ text, x, y, size, lineHeight = 24 }) =>
      text.split(/\r?\n/).map((line, row) => {
        if (/[^ -~\u00a0-\u00ff]/.test(line)) throw new Error('PDF fixture text requires ASCII or Latin-1')
        return `BT /F1 ${size} Tf ${x} ${y - row * lineHeight} Td (${line.replace(/[()\\]/g, '\\$&')}) Tj ET\n`
      })).join('')
    const content = textOperators + (page.operators ?? '')
    const annotationRefs = (page.annotationObjects ?? []).map(body => {
      annotations.push(body)
      return `${4 + pages.length * 2 + annotations.length} 0 R`
    })
    const annotationEntry = annotationRefs.length ? ` /Annots [${annotationRefs.join(' ')}]` : ''
    const rotationEntry = page.rotate ? ` /Rotate ${page.rotate}` : ''
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.size.join(' ')}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + index * 2} 0 R${rotationEntry}${annotationEntry} >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  return classicPdf([...objects, ...annotations], 4)
}

export function blankPdf(count = 1, size: PlainPdfPage['size'] = [612, 792]): Uint8Array {
  return plainPdf(Array.from({ length: count }, () => ({ size })))
}

/** Serialize Latin-1 object bodies with a deterministic classic cross-reference table. */
export function classicPdf(objects: readonly string[], infoObject?: number): Uint8Array {
  let offset = 9
  const offsets = objects.map((body, index) => {
    const start = offset
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`
    offset += object.length
    return { start, object }
  })
  return Buffer.from('%PDF-1.7\n' + offsets.map(entry => entry.object).join('')
    + `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`
    + offsets.map(entry => `${String(entry.start).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R${infoObject === undefined ? '' : ` /Info ${infoObject} 0 R`} >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1')
}
