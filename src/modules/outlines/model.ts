import {
  PdfDocumentError, type PdfDocumentInfo, type PdfOutlineItem, type PdfOutlineOperation,
  type PdfWorkingCopyOperation,
} from '../../core/pdf-types.js'

export const MAX_OUTLINE_ITEMS = 5000
export const MAX_OUTLINE_DEPTH = 64
export const MAX_OUTLINE_TITLE_LENGTH = 1024

export function isOutlineOperation(operation: PdfWorkingCopyOperation): operation is PdfOutlineOperation {
  return operation.type === 'outline-add' || operation.type === 'outline-update'
    || operation.type === 'outline-delete' || operation.type === 'outline-move'
}

function invalid(message: string): never { throw new PdfDocumentError('invalid-operation', message) }
function readOnly(message: string): never { throw new PdfDocumentError('outline-read-only', message) }

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !value.includes('\0')
}

function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_OUTLINE_TITLE_LENGTH) {
    invalid(`PDF bookmark titles must contain 1–${MAX_OUTLINE_TITLE_LENGTH} characters.`)
  }
  return value.trim()
}

function page(value: unknown, pageCount: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > pageCount) {
    invalid('PDF bookmark destination page is outside the document.')
  }
  return value
}

interface Entry { item: PdfOutlineItem; parentId?: string }

/** Clone and validate once, so rejected batches never mutate a published snapshot. */
function editableTree(items: readonly PdfOutlineItem[], pageCount: number) {
  const roots: PdfOutlineItem[] = []
  const entries = new Map<string, Entry>()
  const objects = new Set<PdfOutlineItem>()
  const pending = items.map(item => ({ item, output: roots, parentId: undefined as string | undefined, depth: 1 })).reverse()
  while (pending.length) {
    const { item, output, parentId, depth } = pending.pop()!
    if (!item || typeof item !== 'object' || objects.has(item) || !validId(item.id)
      || entries.has(item.id) || typeof item.title !== 'string' || !Array.isArray(item.children)
      || item.page !== undefined && (!Number.isInteger(item.page) || item.page < 1 || item.page > pageCount)) {
      readOnly('The PDF bookmark tree is damaged or has duplicate identities.')
    }
    if (depth > MAX_OUTLINE_DEPTH || entries.size >= MAX_OUTLINE_ITEMS) {
      readOnly('The PDF bookmark tree exceeds the supported editing limit.')
    }
    objects.add(item)
    const copy: PdfOutlineItem = { ...item, children: [] }
    output.push(copy)
    entries.set(item.id, { item: copy, parentId })
    for (let index = item.children.length - 1; index >= 0; index--) {
      pending.push({ item: item.children[index]!, output: copy.children, parentId: item.id, depth: depth + 1 })
    }
  }
  return { roots, entries }
}

/** Pure outline edits shared by draft projection and PDF serialization. */
export function projectOutlineOperations(document: PdfDocumentInfo, operations: readonly PdfOutlineOperation[]): PdfDocumentInfo {
  if (!operations.length) return document
  if (document.readOnly || document.outlineReadOnlyReason || !Array.isArray(document.outline)) {
    readOnly(document.outlineReadOnlyReason ?? document.readOnlyReason ?? 'PDF bookmark editing is unavailable for this document.')
  }
  const { roots, entries } = editableTree(document.outline, document.pageCount)
  const entry = (id: string): Entry => {
    if (!validId(id)) invalid('Invalid PDF bookmark identity.')
    const found = entries.get(id)
    if (!found) throw new PdfDocumentError('unknown-outline', 'This PDF bookmark no longer exists.')
    return found
  }
  const siblings = (parentId: string | undefined): PdfOutlineItem[] => parentId === undefined ? roots : entry(parentId).item.children
  const depthOf = (parentId: string | undefined): number => {
    let depth = 0
    while (parentId !== undefined) { depth++; parentId = entry(parentId).parentId }
    return depth
  }
  const indexIn = (value: number | undefined, size: number): number => {
    const index = value === undefined ? size : value
    if (!Number.isInteger(index) || index < 0 || index > size) invalid('PDF bookmark insertion index is outside its parent.')
    return index
  }

  for (const operation of operations) {
    switch (operation.type) {
      case 'outline-add': {
        if (!validId(operation.id) || entries.has(operation.id)) invalid('PDF bookmark identity must be unique.')
        if (entries.size >= MAX_OUTLINE_ITEMS) invalid('This PDF has reached the bookmark editing limit.')
        const target = siblings(operation.parentId)
        if (depthOf(operation.parentId) + 1 > MAX_OUTLINE_DEPTH) invalid('PDF bookmarks cannot be nested any deeper.')
        const item: PdfOutlineItem = { id: operation.id, title: title(operation.title),
          page: page(operation.page, document.pageCount), targetChanged: true, children: [] }
        target.splice(indexIn(operation.index, target.length), 0, item)
        entries.set(item.id, { item, parentId: operation.parentId })
        break
      }
      case 'outline-update': {
        const { item } = entry(operation.id)
        const patch = operation.patch
        if (!patch || !Object.keys(patch).length || Object.keys(patch).some(key => key !== 'title' && key !== 'page')
          || patch.title === undefined && patch.page === undefined) invalid('A PDF bookmark update needs a title or destination page.')
        if (patch.title !== undefined) item.title = title(patch.title)
        if (patch.page !== undefined) { item.page = page(patch.page, document.pageCount); item.targetChanged = true }
        break
      }
      case 'outline-delete': {
        const current = entry(operation.id)
        const parent = siblings(current.parentId)
        parent.splice(parent.indexOf(current.item), 1)
        const pending = [current.item]
        while (pending.length) {
          const item = pending.pop()!
          pending.push(...item.children)
          entries.delete(item.id)
        }
        break
      }
      case 'outline-move': {
        const current = entry(operation.id)
        const target = siblings(operation.parentId)
        let ancestor = operation.parentId
        while (ancestor !== undefined) {
          if (ancestor === operation.id) invalid('A PDF bookmark cannot be moved into itself or its descendants.')
          ancestor = entry(ancestor).parentId
        }
        const pending = [{ item: current.item, depth: 1 }]
        let subtreeDepth = 1
        while (pending.length) {
          const { item, depth } = pending.pop()!
          subtreeDepth = Math.max(subtreeDepth, depth)
          for (const child of item.children) pending.push({ item: child, depth: depth + 1 })
        }
        if (depthOf(operation.parentId) + subtreeDepth > MAX_OUTLINE_DEPTH) invalid('PDF bookmarks cannot be nested any deeper.')
        const source = siblings(current.parentId)
        source.splice(source.indexOf(current.item), 1)
        target.splice(indexIn(operation.index, target.length), 0, current.item)
        current.parentId = operation.parentId
        break
      }
      default: invalid('Unknown PDF bookmark operation.')
    }
  }
  return { ...document, outline: roots }
}
