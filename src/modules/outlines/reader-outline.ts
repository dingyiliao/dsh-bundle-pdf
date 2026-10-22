import type { PdfDocumentInfo, PdfOutlineItem } from '../../core/pdf-types.js'
import type { NativeOutlineItem } from '../../shared/native.js'

/** Project edits over original native destinations, retaining exact views and safe-link handling. */
export function projectedReaderOutline(document: PdfDocumentInfo, baseline: readonly PdfOutlineItem[] | undefined,
  native: NativeOutlineItem[] | null): NativeOutlineItem[] | null {
  if (!document.outline || document.outlineReadOnlyReason || !baseline) return native
  const originals = new Map<string, { item: NativeOutlineItem; page?: number }>()
  const pair = (source: readonly PdfOutlineItem[], items: readonly NativeOutlineItem[]) => {
    for (let index = 0; index < source.length; index++) {
      const entry = items[index]
      if (!entry) continue
      originals.set(source[index].id, { item: entry, page: source[index].page })
      pair(source[index].children, entry.items)
    }
  }
  pair(baseline, native ?? [])
  const project = (items: readonly PdfOutlineItem[]): NativeOutlineItem[] => items.map(item => {
    const original = originals.get(item.id)
    const unchangedTarget = original && !item.targetChanged && original.page === item.page
    return { id: item.id, title: item.title,
      ...(unchangedTarget ? { dest: original.item.dest, url: original.item.url }
        : item.page !== undefined ? { dest: [item.page - 1, { name: 'Fit' }] } : {}),
      items: project(item.children) }
  })
  return document.outline.length ? project(document.outline) : null
}
