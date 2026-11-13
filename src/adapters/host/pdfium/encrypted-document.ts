import type { NativeReply } from '../../../engine/protocol/commands.js'
import type { PdfDocumentInfo, PdfPageInfo } from '../../../core/pdf-types.js'
import type { PdfOpenProbe } from '../../../modules/capabilities/index.js'

/** Use PDFium's display geometry for the same raster that the Reader presents. */
export async function encryptedDocumentInfo(probe: PdfOpenProbe,
  read: (offset: number, limit: number) => Promise<NativeReply<'documentInfo'>['value']>): Promise<PdfDocumentInfo> {
  const batchSize = 512
  const invalid = () => Object.assign(new Error('The protected PDF has unsupported native page geometry'), { code: 'pdf/native-unsupported' })
  const pages: PdfPageInfo[] = []
  let title: string | undefined, permissions = 0
  for (let offset = 0; offset < probe.pageCount; offset += batchSize) {
    const count = Math.min(batchSize, probe.pageCount - offset)
    const info = await read(offset, count)
    if (!offset) { title = info.title; permissions = info.permissions }
    if (info.pages.length !== count) throw invalid()
    for (const { page, visibleBox, mediaBox, boxSource, rotation, renderedWidth, renderedHeight } of info.pages) {
      const width = visibleBox[2] - visibleBox[0], height = visibleBox[3] - visibleBox[1]
      if (page !== pages.length + 1 || width <= 0 || height <= 0) throw invalid()
      const rotated = rotation % 180 !== 0
      // This is the effective raster scale. PDFium's public API does not expose the original /UserUnit.
      const userUnit = renderedWidth / (rotated ? height : width)
      const projectedHeight = userUnit * (rotated ? width : height)
      if (!Number.isFinite(userUnit) || Math.abs(projectedHeight - renderedHeight) > Math.max(0.01, renderedHeight * 0.00001)) throw invalid()
      pages.push({ page, cropBox: visibleBox, ...(boxSource === 'page-dictionary' ? { mediaBox } : {}), rotation, userUnit })
    }
  }
  return { pageCount: probe.pageCount, pages, title, annotations: [],
    signed: probe.signatureStatus === undefined ? probe.signatureCount > 0 : probe.signatureStatus !== 0,
    encrypted: true, allowTextExtraction: (permissions & 0x10) !== 0,
    ...(probe.formType === 1 ? { formKind: 'acroform' as const } : {}),
    readOnly: true, readOnlyReason: 'encrypted-document' }
}
