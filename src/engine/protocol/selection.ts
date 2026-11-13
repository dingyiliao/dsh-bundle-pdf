import { z } from 'zod'

const maxCharacters = 200_000
export const selectionGeometryChunkLimit = 2048
const characterIndex = z.number().int().min(0).max(maxCharacters)
const coordinate = z.number()
const quad = z.tuple([coordinate, coordinate, coordinate, coordinate, coordinate, coordinate, coordinate, coordinate])

/** PDFium character indices, not offsets into a JavaScript string. */
export const selectionGeometryChunkSchema = z.object({
  offset: characterIndex,
  charCount: characterIndex,
  nextOffset: characterIndex.nullable(),
  unmapped: characterIndex,
  glyphs: z.array(z.object({
    index: characterIndex,
    end: characterIndex,
    text: z.string().min(1).max(2),
    line: characterIndex,
    quad: quad.nullable(),
  })).max(selectionGeometryChunkLimit),
}).refine(({ offset, charCount, nextOffset, unmapped, glyphs }) => {
  const end = nextOffset ?? charCount
  if (offset > end || end > charCount || unmapped > end - offset
    || nextOffset !== null && (nextOffset === offset || nextOffset === charCount)) return false
  let previous = offset
  for (const glyph of glyphs) {
    if (glyph.index < previous || glyph.end <= glyph.index || glyph.end > end) return false
    previous = glyph.end
  }
  return true
}, 'Invalid native selection character range')

export type SelectionGeometryChunk = z.infer<typeof selectionGeometryChunkSchema>
