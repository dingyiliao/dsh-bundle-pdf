import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber,
  PDFObject, PDFRef, PDFString,
} from 'pdf-lib'
import { PdfDocumentError, type PdfDocumentInfo, type PdfOutlineItem, type PdfWorkingCopyOperation } from '../../../core/pdf-types.js'
import { MAX_OUTLINE_DEPTH, MAX_OUTLINE_ITEMS, projectOutlineOperations } from '../../../modules/outlines/index.js'

type OutlineOperation = Extract<PdfWorkingCopyOperation, {
  type: 'outline-add' | 'outline-update' | 'outline-delete' | 'outline-move'
}>
type OutlineInfo = Pick<PdfDocumentInfo, 'outline' | 'outlineReadOnlyReason'>
interface Entry { id: string; ref: PDFRef; dictionary: PDFDict; open: boolean }
interface Graph { root?: PDFDict; rootRef?: PDFRef; items: PdfOutlineItem[]; entries: Map<string, Entry>; needsRelink: boolean }

const privateId = PDFName.of('DSHPDFOutlineId')
const key = (name: string) => PDFName.of(name)
function absent(value: PDFObject | undefined) { return value === undefined || value === PDFNull }
function text(value: PDFObject | undefined): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined
}
function lookup(doc: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  return absent(value) ? undefined : doc.context.lookup(value)
}
function field(doc: PDFDocument, dictionary: PDFDict, name: string): PDFObject | undefined {
  return lookup(doc, dictionary.get(key(name)))
}
function invalid(message: string): never { throw new Error(message) }

/** Some exporters leave Last pointing to a duplicate of the actual last item.
 * Accept that alias only when every non-backlink field is identical, including
 * destinations, styles, vendor data and forward child/sibling references.
 */
function sameOutlinePayload(actual: PDFDict, expected: PDFDict | undefined): boolean {
  if (!expected) return false
  const backlinks = new Set(['/Parent', '/Prev', '/Last'])
  const entries = (dictionary: PDFDict) => dictionary.entries().filter(([name]) => !backlinks.has(name.toString()))
  const fields = entries(actual)
  return fields.length === entries(expected).length
    && fields.every(([name, value]) => value.toString() === expected.get(name)?.toString())
}

/** Resolve named local destinations for the editor without rewriting their original objects. */
function namedDestination(doc: PDFDocument, name: string): PDFObject | undefined {
  const legacy = field(doc, doc.catalog, 'Dests')
  if (legacy instanceof PDFDict) {
    const found = lookup(doc, legacy.get(key(name)))
    if (found !== undefined) return found
  }
  const names = field(doc, doc.catalog, 'Names')
  const root = names instanceof PDFDict ? field(doc, names, 'Dests') : undefined
  if (!(root instanceof PDFDict)) return undefined
  const visited = new Set<PDFDict>()
  const queue: PDFDict[] = [root]
  let budget = 0
  while (queue.length && ++budget <= MAX_OUTLINE_ITEMS) {
    const node = queue.pop()!
    if (visited.has(node)) continue
    visited.add(node)
    const entries = field(doc, node, 'Names')
    if (entries instanceof PDFArray) {
      for (let index = 0; index + 1 < entries.size(); index += 2) {
        if (++budget > MAX_OUTLINE_ITEMS) return undefined
        if (text(lookup(doc, entries.get(index))) === name) return lookup(doc, entries.get(index + 1))
      }
    }
    const children = field(doc, node, 'Kids')
    if (children instanceof PDFArray) {
      for (let index = 0; index < children.size(); index++) {
        if (++budget > MAX_OUTLINE_ITEMS) return undefined
        const child = lookup(doc, children.get(index))
        if (child instanceof PDFDict) queue.push(child)
      }
    }
  }
  return undefined
}

function destinationPage(doc: PDFDocument, dictionary: PDFDict, pages: Map<PDFDict, number>): number | undefined {
  let destination = field(doc, dictionary, 'Dest')
  if (destination === undefined) {
    const action = field(doc, dictionary, 'A')
    if (action instanceof PDFDict && field(doc, action, 'S') === key('GoTo')) destination = field(doc, action, 'D')
  }
  const visited = new Set<PDFObject>()
  for (let depth = 0; destination !== undefined && depth < MAX_OUTLINE_DEPTH; depth++) {
    if (visited.has(destination)) return undefined
    visited.add(destination)
    if (destination instanceof PDFArray) {
      const page = lookup(doc, destination.get(0))
      return page instanceof PDFDict ? pages.get(page) : undefined
    }
    if (destination instanceof PDFDict) destination = field(doc, destination, 'D')
    else {
      const name = destination instanceof PDFName ? destination.decodeText() : text(destination)
      if (name === undefined) return undefined
      destination = namedDestination(doc, name)
    }
  }
  return undefined
}

/** First/Next define the tree, as in PDFium. Derived backlinks may be stale in
 * imported PDFs; recover them only if the complete forward graph is unambiguous.
 * Inspection never mutates objects. Cycles, shared/direct items and missing
 * forward links still disable editing; simplified native rows never drive writes.
 */
function readGraph(doc: PDFDocument): Graph {
  const rawRoot = doc.catalog.get(key('Outlines'))
  const root = lookup(doc, rawRoot)
  const entries = new Map<string, Entry>()
  if (root === undefined) return { items: [], entries, needsRelink: false }
  if (!(root instanceof PDFDict)) invalid('The PDF outline root is not a dictionary.')
  let needsRelink = false
  const visited = new Set<PDFDict>([root])
  const staleTargets: Array<{ actual: PDFDict; expected?: PDFDict }> = []
  const checkLink = (raw: PDFObject | undefined, expected: PDFDict | undefined) => {
    const actual = lookup(doc, raw)
    if (actual === expected && (expected !== undefined || absent(raw))) return
    needsRelink = true
    if (actual instanceof PDFDict) staleTargets.push({ actual, expected })
  }
  const pages = new Map<PDFDict, number>(doc.getPages().map((page, index) => [page.node, index + 1] as const))
  const walk = (parent: PDFDict, depth: number): PdfOutlineItem[] => {
    const first = parent.get(key('First'))
    const last = parent.get(key('Last'))
    if (absent(first)) {
      if (!absent(last)) invalid('The PDF outline has a last-item link but no first-item link.')
      return []
    }
    if (depth > MAX_OUTLINE_DEPTH) invalid('The PDF outline exceeds the supported nesting depth.')
    const result: PdfOutlineItem[] = []
    let current: PDFObject | undefined = first
    let previous: PDFDict | undefined
    while (!absent(current)) {
      if (!(current instanceof PDFRef)) invalid('The PDF outline contains a direct item without a stable object identity.')
      const dictionary = lookup(doc, current)
      if (!(dictionary instanceof PDFDict)) invalid('The PDF outline contains a missing or invalid item.')
      if (visited.has(dictionary)) invalid('The PDF outline contains a cycle or a shared item.')
      visited.add(dictionary)
      if (entries.size >= MAX_OUTLINE_ITEMS) invalid('The PDF outline exceeds the supported item count.')
      checkLink(dictionary.get(key('Parent')), parent)
      checkLink(dictionary.get(key('Prev')), previous)
      const stored = text(lookup(doc, dictionary.get(privateId)))
      const id = stored ?? `pdf-outline:${current.objectNumber}:${current.generationNumber}`
      if (!id.trim() || id.length > 512 || id.includes('\0') || entries.has(id)) invalid('The PDF outline has invalid or duplicate item identities.')
      const title = text(field(doc, dictionary, 'Title'))
      if (title === undefined) invalid('The PDF outline contains an invalid title.')
      const count = field(doc, dictionary, 'Count')
      entries.set(id, { id, ref: current, dictionary, open: !(count instanceof PDFNumber) || count.asNumber() >= 0 })
      const page = destinationPage(doc, dictionary, pages)
      const children = walk(dictionary, depth + 1)
      result.push({ id, title, ...(page !== undefined ? { page } : {}), children })
      previous = dictionary
      current = dictionary.get(key('Next'))
    }
    checkLink(last, previous)
    return result
  }
  const items = walk(root, 1)
  // A backlink to an unreachable real bookmark may be evidence of a broken
  // forward chain, not an expendable placeholder. Do not silently drop it.
  for (const { actual, expected } of staleTargets) {
    if (!visited.has(actual) && actual.has(key('Title')) && !sameOutlinePayload(actual, expected)) {
      invalid('The PDF outline links reference an item missing from its forward tree.')
    }
  }
  return { root, rootRef: rawRoot instanceof PDFRef ? rawRoot : undefined, items, entries, needsRelink }
}

/** A broken outline disables only its editor; ordinary PDF reading and annotations remain available. */
export function inspectOutlines(doc: PDFDocument): OutlineInfo {
  try { return { outline: readGraph(doc).items } }
  catch (error) {
    return { outline: [], outlineReadOnlyReason: error instanceof Error ? error.message : 'The PDF outline could not be read safely.' }
  }
}

function setPage(doc: PDFDocument, dictionary: PDFDict, page: number) {
  dictionary.set(key('Dest'), doc.context.obj([doc.getPages()[page - 1].ref, key('Fit')]))
  dictionary.delete(key('A'))
}

/** Mutate original dictionaries in an isolated parse, preserving all untouched destination/action/style keys. */
export function applyOutlineOperations(doc: PDFDocument, document: PdfDocumentInfo,
  operations: readonly OutlineOperation[]): OutlineInfo {
  if (!operations.length) return { outline: document.outline, outlineReadOnlyReason: document.outlineReadOnlyReason }
  const projected = projectOutlineOperations(document, operations)
  let graph: Graph
  try { graph = readGraph(doc) }
  catch (error) { throw new PdfDocumentError('outline-read-only', error instanceof Error ? error.message : 'The PDF outline cannot be edited.') }
  // Even a title-only edit must leave recovered backlinks valid after save.
  // Unrelated annotation/form writes never enter this outline repair path.
  let structural = graph.needsRelink
  for (const operation of operations) {
    if (operation.type === 'outline-add') {
      structural = true
      const dictionary = doc.context.obj({ Title: PDFHexString.fromText(operation.title.trim()) })
      dictionary.set(privateId, PDFHexString.fromText(operation.id))
      setPage(doc, dictionary, operation.page)
      graph.entries.set(operation.id, { id: operation.id, ref: doc.context.register(dictionary), dictionary, open: true })
    } else if (operation.type === 'outline-update') {
      const entry = graph.entries.get(operation.id)!
      if (operation.patch.title !== undefined) entry.dictionary.set(key('Title'), PDFHexString.fromText(operation.patch.title.trim()))
      if (operation.patch.page !== undefined) setPage(doc, entry.dictionary, operation.patch.page)
    } else if (operation.type === 'outline-delete') {
      structural = true
      graph.entries.delete(operation.id)
    } else structural = true
  }
  if (structural) {
    const root = graph.root ?? doc.context.obj({ Type: key('Outlines') })
    const rootRef = graph.rootRef ?? doc.context.register(root)
    doc.catalog.set(key('Outlines'), rootRef)
    const link = (parent: PDFDict, parentRef: PDFRef, items: readonly PdfOutlineItem[]): number => {
      if (items.length) {
        parent.set(key('First'), graph.entries.get(items[0].id)!.ref)
        parent.set(key('Last'), graph.entries.get(items[items.length - 1].id)!.ref)
      } else {
        parent.delete(key('First'))
        parent.delete(key('Last'))
      }
      let visible = 0
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        const entry = graph.entries.get(item.id)!
        entry.dictionary.set(key('Parent'), parentRef)
        if (index) entry.dictionary.set(key('Prev'), graph.entries.get(items[index - 1].id)!.ref)
        else entry.dictionary.delete(key('Prev'))
        if (index + 1 < items.length) entry.dictionary.set(key('Next'), graph.entries.get(items[index + 1].id)!.ref)
        else entry.dictionary.delete(key('Next'))
        const descendants = link(entry.dictionary, entry.ref, item.children)
        if (descendants) entry.dictionary.set(key('Count'), PDFNumber.of(entry.open ? descendants : -descendants))
        else entry.dictionary.delete(key('Count'))
        visible += 1 + (entry.open ? descendants : 0)
      }
      return visible
    }
    root.set(key('Count'), PDFNumber.of(link(root, rootRef, projected.outline!)))
  }
  const inspected = inspectOutlines(doc)
  if (inspected.outlineReadOnlyReason) throw new PdfDocumentError('outline-read-only', inspected.outlineReadOnlyReason)
  return inspected
}
