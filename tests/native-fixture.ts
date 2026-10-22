import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib'
import { createHash } from 'node:crypto'
import { createWorkspaces } from '../src/host/workspaces.ts'
import type { DraftRecord } from '../src/modules/working-copy/index.ts'

export const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** A Type 1 glyph can map to a two-unit UTF-16 value through ToUnicode. */
export function supplementaryTextPdf(): Uint8Array {
  const cmap = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', '<00> <FF>', 'endcodespacerange',
    '2 beginbfchar', '<41> <D835DC45>', '<42> <D835DC5D>', 'endbfchar',
    'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end', '',
  ].join('\n')
  const drawing = 'BT /F1 24 Tf 72 720 Td (AB) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >>',
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}endstream`,
    `<< /Length ${Buffer.byteLength(drawing)} >>\nstream\n${drawing}endstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, 'ascii'))
}

export async function nativeFixture() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < 4; index++) {
    const page = pdf.addPage([300, 400])
    page.setCropBox(30, 40, 250, 320); page.setRotation(degrees(index * 90))
    if (index === 3) page.node.set(PDFName.of('UserUnit'), pdf.context.obj(2))
    page.drawRectangle({ x: 50, y: 70, width: 70, height: 50, color: rgb(1, 0, 0) })
    page.drawRectangle({ x: 180, y: 240, width: 60, height: 60, color: rgb(0, 0, 1) })
    page.drawText(`Native PDF test page ${index + 1}`, { x: 42, y: 330, size: 14, font })
    const link = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 140, 150, 165],
      A: { S: 'URI', URI: PDFString.of('https://example.com/native') } }))
    const named = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [180, 140, 230, 165], A: { S: 'Named', N: 'NextPage' } }))
    page.node.set(PDFName.of('Annots'), pdf.context.obj([link, named]))
  }
  pdf.catalog.set(PDFName.of('Names'), pdf.context.obj({ Dests: { Names: [PDFString.of('chapter'), [pdf.getPage(2).ref, PDFName.of('XYZ'), 50, 300, null]] } }))
  return pdf.save({ useObjectStreams: false })
}
export function memoryWorkspace(initial: Uint8Array) {
  let bytes = initial, version = digest(bytes), fsRevision = 1
  const records = new Map<string, DraftRecord>()
  const path = '/fixtures/native.pdf'
  const files: Parameters<typeof createWorkspaces>[0] = {
    async resolvePath(_agent, requested) { if (requested !== path) throw new Error('Unknown fixture'); return path },
    async read(_agent, requested) { if (requested !== path) throw new Error('Unknown fixture'); return { path, bytes, version, fsVersion: String(fsRevision), size: bytes.length } },
    async save(_agent, requested, value, expected) {
      if (requested !== path || expected !== version) throw new Error('Stale fixture write')
      bytes = value; version = digest(bytes); fsRevision++
      return { path, version, fsVersion: String(fsRevision), size: bytes.length }
    },
  }
  const drafts: Parameters<typeof createWorkspaces>[1] = {
    get: key => records.get(key), async put(key, value) { records.set(key, structuredClone(value)) }, async delete(key) { records.delete(key) },
  }
  return { workspaces: createWorkspaces(files, drafts), files, drafts,
    records, current: () => bytes, writes: () => fsRevision - 1 }
}
