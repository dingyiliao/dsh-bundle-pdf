import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { loadPdfDocument } from '../core/pdf-document.ts'
import { PdfDocumentError, type PdfAnnotation, type PdfColor, type PdfDocumentInfo, type PdfRect } from '../core/pdf-types.ts'

const supportedTypes = new Set(['Highlight', 'Underline', 'StrikeOut', 'Text'])
const pdfRequire = createRequire(import.meta.url)

function numbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return undefined
  const result = Array.from(value as ArrayLike<unknown>)
  return result.every((item): item is number => typeof item === 'number' && Number.isFinite(item)) ? result : undefined
}

function annotationModel(value: Record<string, unknown>, page: number, index: number): PdfAnnotation {
  const subtype = typeof value.subtype === 'string' ? value.subtype : 'Unknown'
  const rect = numbers(value.rect)
  const quads = numbers(value.quadPoints)
  const color = numbers(value.color)
  const contents = value.contentsObj as { str?: unknown } | undefined
  const title = value.titleObj as { str?: unknown } | undefined
  return {
    id: typeof value.id === 'string' ? value.id : `readonly-${page}-${index}`,
    page, subtype,
    rect: rect?.length === 4 ? rect as PdfRect : undefined,
    quadPoints: quads?.length && quads.length % 8 === 0 ? quads : undefined,
    color: color?.length === 3 ? color.map((item) => Math.max(0, Math.min(1, item / 255))) as PdfColor : undefined,
    opacity: typeof value.opacity === 'number' && Number.isFinite(value.opacity) ? value.opacity : undefined,
    contents: typeof contents?.str === 'string' ? contents.str : undefined,
    author: typeof title?.str === 'string' ? title.str : undefined,
    createdAt: typeof value.creationDate === 'string' ? value.creationDate : undefined,
    modifiedAt: typeof value.modificationDate === 'string' ? value.modificationDate : undefined,
    flags: typeof value.annotationFlags === 'number' ? value.annotationFlags : 0,
    supported: supportedTypes.has(subtype), editable: false, readOnlyReason: 'encrypted-document',
  }
}

/** Preserve strict editable parsing; PDF.js can read encryption that the editor cannot safely save. */
export async function loadPdfForReading(bytes: Uint8Array): Promise<PdfDocumentInfo> {
  let strictError: PdfDocumentError
  try { return await loadPdfDocument(bytes) }
  catch (error) {
    if (!(error instanceof PdfDocumentError) || !['invalid-pdf', 'encrypted'].includes(error.code)) throw error
    strictError = error
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const assetRoot = dirname(pdfRequire.resolve('pdfjs-dist/package.json')).replaceAll('\\', '/')
  const task = pdfjs.getDocument({
    // PDF.js transfers its input buffer. The workspace must retain the exact original bytes.
    data: bytes.slice(), disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false,
    standardFontDataUrl: `${assetRoot}/standard_fonts/`, cMapUrl: `${assetRoot}/cmaps/`,
  })
  try {
    const pdf = await task.promise
    const metadata = await pdf.getMetadata()
    const info = metadata.info as { EncryptFilterName?: unknown; Title?: unknown; IsSignaturesPresent?: unknown }
    // An unrelated malformed PDF must retain its strict parsing failure.
    if (typeof info.EncryptFilterName !== 'string' || !info.EncryptFilterName) throw strictError
    const pages: PdfDocumentInfo['pages'] = []
    const annotations: PdfAnnotation[] = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const view = [...page.view] as PdfRect
      // The public API exposes only the visible box; retain MediaBox as unknown.
      pages.push({ page: pageNumber, cropBox: view, rotation: page.rotate, userUnit: page.userUnit })
      const native = await page.getAnnotations({ intent: 'display' })
      annotations.push(...native.map((value, index) => annotationModel(value, pageNumber, index)))
    }
    return {
      pageCount: pdf.numPages, pages, annotations,
      title: typeof info.Title === 'string' ? info.Title : undefined,
      signed: info.IsSignaturesPresent === true,
      encrypted: true, readOnly: true, readOnlyReason: 'encrypted-document',
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new PdfDocumentError('password-required', 'This encrypted PDF requires a password. Password unlocking is not supported yet.')
    }
    throw error
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
