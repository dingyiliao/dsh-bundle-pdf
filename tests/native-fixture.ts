import { createHash } from 'node:crypto'
import { createWorkspaces } from './fixtures/working-copy-service.ts'
import { classicPdf, plainPdf } from './fixtures/plain-pdf.ts'
export { classicPdf } from './fixtures/plain-pdf.ts'
import type { DraftRecord } from '../src/modules/working-copy/index.ts'

export const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** PDFium replaces an ordinary end-of-line hyphen with its U+0002 layout marker. */
export async function hyphenatedTextPdf(): Promise<Uint8Array> {
  return plainPdf([{ size: [400, 300], lines: [
    { text: 'understand-', x: 40, y: 200, size: 12 },
    { text: 'ing the model', x: 40, y: 180, size: 12 },
  ] }])
}

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
  return classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >>',
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}endstream`,
    `<< /Length ${Buffer.byteLength(drawing)} >>\nstream\n${drawing}endstream`,
  ])
}

export async function nativeFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Names [(chapter) [12 0 R /XYZ 50 300 null]] >> >> >>',
    '<< /Type /Pages /Kids [4 0 R 8 0 R 12 0 R 16 0 R] /Count 4 /MediaBox [0 0 300 400] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  for (let index = 0; index < 4; index++) {
    const content = `1 0 0 rg 50 70 70 50 re f\n0 0 1 rg 180 240 60 60 re f\n0 g BT /F1 14 Tf 42 330 Td (Native PDF test page ${index + 1}) Tj ET\n`
    const page = 4 + index * 4
    objects.push(
      `<< /Type /Page /Parent 2 0 R /CropBox [30 40 280 360] /Rotate ${index * 90}
        ${index === 3 ? '/UserUnit 2' : ''} /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R
        /Annots [${page + 2} 0 R ${page + 3} 0 R] >>`,
      `<< /Length ${content.length} >>\nstream\n${content}endstream`,
      '<< /Type /Annot /Subtype /Link /Rect [50 140 150 165] /A << /S /URI /URI (https://example.com/native) >> >>',
      '<< /Type /Annot /Subtype /Link /Rect [180 140 230 165] /A << /S /Named /N /NextPage >> >>',
    )
  }
  return classicPdf(objects)
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
