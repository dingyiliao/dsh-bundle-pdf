import { pdfCapabilities } from './registry.js'

/** PDFium's lightweight open probe runs after the source bytes have been parsed. */
export interface PdfOpenProbe {
  pageCount: number
  formType: number
  signatureCount: number
}

/** Neither parser may silently downgrade a feature detected by the other. */
export function requiredPdfOpenCapabilities(probe: PdfOpenProbe, parsedFormKind?: 'acroform' | 'xfa'): string[] {
  const required: string[] = [pdfCapabilities.renderPage]
  if (parsedFormKind === 'acroform') required.push(pdfCapabilities.renderAcroForm)
  else if (parsedFormKind === 'xfa') required.push(pdfCapabilities.renderXfa)
  if (probe.formType === 1) required.push(pdfCapabilities.renderAcroForm)
  else if (probe.formType === 2 || probe.formType === 3) required.push(pdfCapabilities.renderXfa)
  else if (probe.formType !== 0) required.push(`pdf.form.unknown-${probe.formType}.render`)
  if (probe.signatureCount > 0) required.push(pdfCapabilities.previewSigned)
  return [...new Set(required)]
}
