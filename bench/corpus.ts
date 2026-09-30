import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { applyPdfOperations } from '../src/core/pdf-document.ts'
import type { PdfAnnotationOperation } from '../src/core/pdf-types.ts'
import { corpusSchema, type Corpus } from './schema.ts'
import { ROOT, sha256 } from './metadata.ts'

export const FIXED_DATE = '2000-01-01T00:00:00.000Z'
export async function createCorpus(directory = join(ROOT, 'bench', '.generated')): Promise<Corpus> {
  await mkdir(directory, { recursive: true })
  const manifest: Corpus = { schemaVersion: 1, generator: 'dsh-pdf-synthetic-v1', seed: 187, documents: [] }
  for (const spec of [
    { id: 'paper-12', pages: 12, annotations: 0 },
    { id: 'text-1000', pages: 1000, annotations: 0 },
    { id: 'annotations-1000', pages: 12, annotations: 1000 },
  ]) {
    const pdf = await PDFDocument.create()
    pdf.setCreationDate(new Date(FIXED_DATE)); pdf.setModificationDate(new Date(FIXED_DATE))
    pdf.setProducer('DSH PDF deterministic corpus v1'); pdf.setCreator('DSH PDF M0 benchmark')
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    for (let number = 1; number <= spec.pages; number++) {
      const page = pdf.addPage(number % 7 === 0 ? [640, 860] : [595, 842])
      page.drawText(`PDF benchmark page ${number} / ${spec.pages}`, { x: 40, y: 790, size: 16, font })
      for (let line = 0; line < 32; line++) page.drawText(`Lifestyle viewpoint test sentence ${line + 1}. Search target ${number}.`,
        { x: 40, y: 750 - line * 19, size: 10, font, color: rgb(0.1, 0.1, 0.1) })
    }
    let bytes: Uint8Array = await pdf.save({ useObjectStreams: false })
    if (spec.annotations) {
      const operations: PdfAnnotationOperation[] = Array.from({ length: spec.annotations }, (_, index) => ({
        type: 'add', annotation: { id: `corpus-note-${index}`, page: index % spec.pages + 1, subtype: 'Text',
          rect: [42 + index % 20, 50 + index % 500, 60 + index % 20, 68 + index % 500], contents: `Synthetic note ${index}` },
      }))
      bytes = (await applyPdfOperations(bytes, operations, operations.map(() => FIXED_DATE))).bytes
    }
    const file = `${spec.id}.pdf`
    await writeFile(join(directory, file), bytes)
    manifest.documents.push({ ...spec, file, sha256: sha256(bytes), bytes: bytes.byteLength,
      origin: 'synthetic', license: 'MIT', features: ['latin-text', 'mixed-page-sizes', ...(spec.annotations ? ['native-text-annotations'] : [])] })
  }
  corpusSchema.parse(manifest)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function ensureCorpus(directory: string) {
  try { return corpusSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return createCorpus(directory) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length && !(args.length === 2 && args[0] === '--out')) throw new Error('Usage: npm run bench:corpus -- [--out DIRECTORY]')
  const directory = args[1] ? resolve(args[1]) : join(ROOT, 'bench', '.generated')
  const corpus = await createCorpus(directory)
  console.log(JSON.stringify({ manifest: join(directory, 'manifest.json'), documents: corpus.documents.map(x => ({ id: x.id, sha256: x.sha256, bytes: x.bytes })) }))
}
