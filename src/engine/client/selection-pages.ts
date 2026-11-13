import type { PdfRect } from '../../core/pdf-types.js'
import { ByteCache } from '../../shared/cache/index.js'
import type { SelectionGeometryChunk } from '../protocol/selection.js'
import { createSelectionPage, type SelectionPage } from './selection.js'

/** Cache geometry within the owning reader's memory budget. */
export function createSelectionPages(options: {
  read(page: number, offset: number, signal: AbortSignal): Promise<SelectionGeometryChunk>
  cropBox(page: number): PdfRect | undefined
  signal: AbortSignal
}) {
  const pages = new ByteCache<SelectionPage>(8 * 1024 * 1024)
  const unavailable = new Set<number>()
  const pending = new Map<number, Promise<SelectionPage | null>>()
  options.signal.addEventListener('abort', () => {
    pages.clear()
    unavailable.clear()
  }, { once: true })

  async function readPage(page: number): Promise<SelectionPage | null> {
    const crop = options.cropBox(page)
    if (!crop) return null
    const glyphs: SelectionGeometryChunk['glyphs'] = []
    let offset = 0
    let count: number | undefined
    do {
      options.signal.throwIfAborted()
      const chunk = await options.read(page, offset, options.signal)
      options.signal.throwIfAborted()
      if (chunk.offset !== offset || (count !== undefined && chunk.charCount !== count)) {
        throw new Error('PDF selection geometry changed while reading the page')
      }
      // The preview does not build a large spatial index on the UI thread.
      if (chunk.unmapped || chunk.charCount > 24_000) {
        unavailable.add(page)
        return null
      }
      count = chunk.charCount
      glyphs.push(...chunk.glyphs)
      if (chunk.nextOffset === null) break
      offset = chunk.nextOffset
    } while (offset < count)
    const data = createSelectionPage(page, glyphs, crop)
    if (data.hasUnpositionedText) {
      unavailable.add(page)
      return null
    }
    // Include the objects, spatial index, offsets, and copied text in the estimate.
    pages.set(String(page), data, 512 + glyphs.length * 320 + data.text.length * 2)
    return data
  }

  return {
    get: (page: number) => pages.get(String(page)),
    load(page: number) {
      options.signal.throwIfAborted()
      const cached = pages.get(String(page))
      if (cached || unavailable.has(page)) return Promise.resolve(cached ?? null)
      const existing = pending.get(page)
      if (existing) return existing
      const task = readPage(page).finally(() => pending.delete(page))
      pending.set(page, task)
      return task
    },
  }
}
