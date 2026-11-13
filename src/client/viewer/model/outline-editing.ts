import type { PdfOutlineItem, PdfOutlineOperation } from '../../../core/pdf-types.js'

export interface OutlineLocation { item: PdfOutlineItem; parentId?: string; index: number }
export type OutlineLocations = ReadonlyMap<string, OutlineLocation>
export type OutlinePlacement = 'before' | 'inside' | 'after'

export function outlineLocations(items: readonly PdfOutlineItem[]): OutlineLocations {
  const result = new Map<string, OutlineLocation>()
  const pending = items.map((item, index) => ({ item, index, parentId: undefined as string | undefined }))
  while (pending.length) {
    const row = pending.pop()!
    result.set(row.item.id, row)
    row.item.children.forEach((item, index) => pending.push({ item, index, parentId: row.item.id }))
  }
  return result
}

/** The domain move index is measured AFTER removing the source from its siblings. */
export function outlineDrop(locations: OutlineLocations, sourceId: string, targetId: string,
  placement: OutlinePlacement): Extract<PdfOutlineOperation, { type: 'outline-move' }> | undefined {
  const source = locations.get(sourceId), target = locations.get(targetId)
  if (!source || !target || sourceId === targetId) return
  let ancestor: string | undefined = targetId
  while (ancestor !== undefined) {
    if (ancestor === sourceId) return
    ancestor = locations.get(ancestor)?.parentId
  }
  const parentId = placement === 'inside' ? targetId : target.parentId
  let index = placement === 'inside' ? target.item.children.length : target.index + (placement === 'after' ? 1 : 0)
  if (parentId === source.parentId && source.index < index) index--
  if (parentId === source.parentId && source.index === index) return
  return { type: 'outline-move', id: sourceId, parentId, index }
}

export function outlineKeyboardMove(locations: OutlineLocations, items: readonly PdfOutlineItem[], id: string,
  direction: 'up' | 'down' | 'indent' | 'outdent'): Extract<PdfOutlineOperation, { type: 'outline-move' }> | undefined {
  const row = locations.get(id)
  if (!row) return
  const siblings = row.parentId ? locations.get(row.parentId)?.item.children : items
  if (!siblings) return
  if (direction === 'outdent') return row.parentId ? outlineDrop(locations, id, row.parentId, 'after') : undefined
  const other = siblings[row.index + (direction === 'down' ? 1 : -1)]
  if (!other) return
  return outlineDrop(locations, id, other.id, direction === 'indent' ? 'inside' : direction === 'down' ? 'after' : 'before')
}
