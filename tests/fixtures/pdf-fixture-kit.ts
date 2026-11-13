import { classicPdf, plainPdf } from './plain-pdf.ts'

/** Small, dependency-free PDF object helpers used only by tests.  Production
 * PDF creation and parsing is owned by the PDFium adapter; these helpers make
 * deterministic fixtures without pulling a second PDF implementation into
 * the package. */
export const ref = (objectNumber: number) => `${objectNumber} 0 R`

export function pdfName(value: string): string {
  return `/${value.replace(/[^A-Za-z0-9_#.-]/g, '')}`
}

export function pdfHex(value: string): string {
  const bytes = Buffer.from(value, 'utf16le')
  const swapped = Buffer.alloc(bytes.length)
  for (let index = 0; index < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1] ?? 0
    swapped[index + 1] = bytes[index] ?? 0
  }
  return `<FEFF${swapped.toString('hex').toUpperCase()}>`
}

export function pdfString(value: string): string {
  if (/^[\x20-\x7e\r\n\t]*$/.test(value)) return `(${value.replace(/[()\\]/g, '\\$&')})`
  return pdfHex(value)
}

export function pdfArray(values: readonly string[]): string { return `[${values.join(' ')}]` }
export function pdfDict(entries: Record<string, string>): string {
  return `<< ${Object.entries(entries).map(([key, value]) => `/${key} ${value}`).join(' ')} >>`
}
export function pdfStream(data: string, entries: Record<string, string> = {}): string {
  const length = Buffer.byteLength(data, 'latin1')
  return `${pdfDict({ Length: String(length), ...entries })}\nstream\n${data}\nendstream`
}

export function onePagePdf({
  width = 400,
  height = 600,
  content = '',
  pageEntries = {},
  catalogEntries = {},
  extraObjects = [],
}: {
  width?: number
  height?: number
  content?: string
  pageEntries?: Record<string, string>
  catalogEntries?: Record<string, string>
  extraObjects?: readonly string[]
} = {}): Uint8Array {
  const objects = [
    pdfDict({ Type: '/Catalog', Pages: ref(2), ...catalogEntries }),
    pdfDict({ Type: '/Pages', Kids: pdfArray([ref(5)]), Count: '1' }),
    pdfDict({ Type: '/Font', Subtype: '/Type1', BaseFont: '/Helvetica', Encoding: '/WinAnsiEncoding' }),
    pdfDict({ Producer: pdfString('DSH PDF test fixture') }),
    pdfDict({ Type: '/Page', Parent: ref(2), MediaBox: pdfArray(['0', '0', String(width), String(height)]),
      Resources: pdfDict({ Font: pdfDict({ F1: ref(3) }) }), Contents: ref(6), ...pageEntries }),
    pdfStream(content),
    ...extraObjects,
  ]
  return classicPdf(objects, 4)
}

export { classicPdf, plainPdf }
