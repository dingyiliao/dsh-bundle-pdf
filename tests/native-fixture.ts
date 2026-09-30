import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib'
import { createHash } from 'node:crypto'
import { createWorkspaces } from '../src/host/workspaces.ts'
import type { DraftRecord } from '../src/host/validation.ts'

export const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
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
  return { workspaces: createWorkspaces(files, { get: key => records.get(key), async put(key, value) { records.set(key, structuredClone(value)) }, async delete(key) { records.delete(key) } }),
    records, current: () => bytes, writes: () => fsRevision - 1 }
}
