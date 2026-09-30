import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber,
  PDFObject, PDFRef, PDFString, ParseSpeeds,
} from 'pdf-lib'
import { setAnnotationAppearance } from './pdf-appearance.js'
import { measurePdfAsync } from '../shared/performance.js'
import {
  PdfDocumentError,
  type EditableAnnotationType, type NewPdfAnnotation, type PdfAnnotation,
  type PdfAnnotationOperation, type PdfColor, type PdfDocumentInfo, type PdfRect,
} from './pdf-types.js'

export * from './pdf-types.js'

const editableTypes = new Set<string>(['Highlight', 'Underline', 'StrikeOut', 'Text'])
const privateId = PDFName.of('DSHPDFId')
const defaultColor: PdfColor = [1, 0.85, 0]
const lockedFlags = 64 | 128 | 512 // ReadOnly (0x40), Locked, LockedContents; NoView (0x20) only controls visibility.

interface AnnotationEntry {
  value: PDFObject
  dictionary: PDFDict
  array: PDFArray
  model: PdfAnnotation
}

function readString(value: PDFObject | undefined): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined
}

function readNumber(value: PDFObject | undefined): number | undefined {
  return value instanceof PDFNumber && Number.isFinite(value.asNumber()) ? value.asNumber() : undefined
}

function readName(value: PDFObject | undefined): string | undefined {
  return value instanceof PDFName ? value.decodeText() : undefined
}

function get(doc: PDFDocument, dictionary: PDFDict, key: string): PDFObject | undefined {
  return doc.context.lookup(dictionary.get(PDFName.of(key)))
}

function numbers(value: PDFObject | undefined): number[] | undefined {
  if (!(value instanceof PDFArray)) return undefined
  const result: number[] = []
  for (let index = 0; index < value.size(); index++) {
    const item = readNumber(value.lookup(index))
    if (item === undefined) return undefined
    result.push(item)
  }
  return result
}

function readColor(value: PDFObject | undefined): PdfColor | undefined {
  const components = numbers(value)
  if (!components?.length) return undefined
  const clamp = (n: number) => Math.max(0, Math.min(1, n))
  if (components.length === 1) return [clamp(components[0]), clamp(components[0]), clamp(components[0])]
  if (components.length === 3) return components.map(clamp) as PdfColor
  if (components.length === 4) {
    const [c, m, y, k] = components.map(clamp)
    return [1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k)]
  }
  return undefined
}

function validRect(rect: unknown): rect is PdfRect {
  return Array.isArray(rect) && rect.length === 4 && rect.every((n) => typeof n === 'number' && Number.isFinite(n))
    && rect[2] > rect[0] && rect[3] > rect[1]
}

function validQuads(points: unknown): points is number[] {
  return Array.isArray(points) && points.length > 0 && points.length % 8 === 0
    && points.every((n) => typeof n === 'number' && Number.isFinite(n))
}

function normalizedRect(value: PDFObject | undefined): PdfRect | undefined {
  const raw = numbers(value)
  if (!raw || raw.length !== 4) return undefined
  const rect: PdfRect = [Math.min(raw[0], raw[2]), Math.min(raw[1], raw[3]), Math.max(raw[0], raw[2]), Math.max(raw[1], raw[3])]
  return validRect(rect) ? rect : undefined
}

/** Signature dictionaries can also be direct objects; do not rely only on AcroForm fields. */
function hasSignature(doc: PDFDocument): boolean {
  const visited = new Set<PDFObject>()
  const roots = doc.context.enumerateIndirectObjects()
  const queue: PDFObject[] = [doc.catalog]
  let rootIndex = 0
  while (queue.length || rootIndex < roots.length) {
    const object = doc.context.lookup(queue.length ? queue.pop() : roots[rootIndex++][1])
    if (!(object instanceof PDFDict || object instanceof PDFArray) || visited.has(object)) continue
    visited.add(object)
    if (object instanceof PDFDict) {
      if (readName(get(doc, object, 'Type')) === 'Sig') return true
      if (get(doc, object, 'ByteRange') instanceof PDFArray && get(doc, object, 'Contents')) return true
      if (object === doc.catalog) {
        const permissions = get(doc, object, 'Perms')
        if (permissions instanceof PDFDict && get(doc, permissions, 'DocMDP')) return true
      }
      // Indirect objects are already in roots. Visit only direct
      // containers here, avoiding every number/string in large annotation lists.
      for (const [, value] of object.entries()) {
        if (value instanceof PDFDict || value instanceof PDFArray) queue.push(value)
      }
    } else if (object instanceof PDFArray) {
      for (let index = 0; index < object.size(); index++) {
        const value = object.get(index)
        if (value instanceof PDFDict || value instanceof PDFArray) queue.push(value)
      }
    }
  }
  return false
}

function annotationEntries(doc: PDFDocument, documentReadOnly = false): AnnotationEntry[] {
  const entries: AnnotationEntry[] = []
  const usedIds = new Set<string>()
  doc.getPages().forEach((page, pageIndex) => {
    const array = get(doc, page.node, 'Annots')
    if (!(array instanceof PDFArray)) return
    for (let index = 0; index < array.size(); index++) {
      const value = array.get(index)
      const dictionary = doc.context.lookup(value)
      if (!(dictionary instanceof PDFDict)) continue
      const savedId = readString(doc.context.lookup(dictionary.get(privateId)))
      const referenceId = value instanceof PDFRef ? `ref:${value.objectNumber}:${value.generationNumber}` : `direct:${pageIndex + 1}:${index}`
      // Untrusted PDFs may duplicate names/IDs: never allow an ambiguous editing target.
      const candidate = savedId || referenceId
      const id = usedIds.has(candidate) ? `${candidate}@${referenceId}:${index}` : candidate
      usedIds.add(id)
      const subtype = readName(get(doc, dictionary, 'Subtype')) ?? 'Unknown'
      const rect = normalizedRect(get(doc, dictionary, 'Rect'))
      const rawQuads = numbers(get(doc, dictionary, 'QuadPoints'))
      const quadPoints = validQuads(rawQuads) ? rawQuads : undefined
      const flags = readNumber(get(doc, dictionary, 'F')) ?? 0
      const supported = editableTypes.has(subtype)
      let readOnlyReason: string | undefined
      if (documentReadOnly) readOnlyReason = 'signed-document'
      else if (!supported) readOnlyReason = 'unsupported-annotation-type'
      else if (flags & lockedFlags) readOnlyReason = 'annotation-locked'
      else if (!rect || (subtype !== 'Text' && !quadPoints)) readOnlyReason = 'invalid-annotation-geometry'
      const model: PdfAnnotation = {
        id, page: pageIndex + 1, subtype, rect, quadPoints,
        color: readColor(get(doc, dictionary, 'C')),
        opacity: readNumber(get(doc, dictionary, 'CA')),
        contents: readString(get(doc, dictionary, 'Contents')),
        author: readString(get(doc, dictionary, 'T')),
        createdAt: readString(get(doc, dictionary, 'CreationDate')),
        modifiedAt: readString(get(doc, dictionary, 'M')),
        flags, supported, editable: !readOnlyReason, readOnlyReason,
      }
      if (subtype === 'Link') {
        const action = get(doc, dictionary, 'A')
        if (action instanceof PDFDict && readName(get(doc, action, 'S')) === 'Named') {
          const named = readName(get(doc, action, 'N'))
          if (named && ['FirstPage', 'LastPage', 'NextPage', 'PrevPage'].includes(named)) model.linkAction = named
        }
      }
      entries.push({ value, dictionary, array, model })
    }
  })
  // P0 preserves reply chains intact, including the parent of each reply.
  const threaded = new Set<PDFDict>()
  for (const entry of entries) {
    const parent = get(doc, entry.dictionary, 'IRT')
    if (parent instanceof PDFDict) {
      threaded.add(parent)
      threaded.add(entry.dictionary)
    }
  }
  for (const entry of entries) {
    if (threaded.has(entry.dictionary) && entry.model.editable) {
      entry.model.editable = false
      entry.model.readOnlyReason = 'reply-chain'
    }
  }
  const objectIds = new Map<PDFDict, string>()
  for (const entry of entries) {
    if (!objectIds.has(entry.dictionary)) objectIds.set(entry.dictionary, `pdf-existing:${objectIds.size}`)
  }
  for (const entry of entries) {
    entry.model.sourceObjectId = objectIds.get(entry.dictionary)
    const popup = get(doc, entry.dictionary, 'Popup')
    if (popup instanceof PDFDict) entry.model.popupObjectId = objectIds.get(popup)
  }
  return entries
}

function documentInfo(doc: PDFDocument, known?: { signed: boolean; annotations: PdfAnnotation[] }): PdfDocumentInfo {
  const signed = known?.signed ?? hasSignature(doc)
  return {
    pageCount: doc.getPageCount(),
    pages: doc.getPages().map((page, index) => {
      const box = (value: { x: number; y: number; width: number; height: number }): PdfRect =>
        [value.x, value.y, value.x + value.width, value.y + value.height]
      return {
        page: index + 1, mediaBox: box(page.getMediaBox()), cropBox: box(page.getCropBox()),
        rotation: page.getRotation().angle,
        userUnit: readNumber(get(doc, page.node, 'UserUnit')) ?? 1,
      }
    }),
    annotations: known?.annotations ?? annotationEntries(doc, signed).map((entry) => entry.model),
    title: doc.getTitle(), signed, encrypted: false, readOnly: signed,
    readOnlyReason: signed ? 'signed-document' : undefined,
  }
}

async function parse(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    // Metadata and AcroForm appearances are not rewritten as a side effect of opening.
    const doc = await PDFDocument.load(bytes, {
      updateMetadata: false, throwOnInvalidObject: true, parseSpeed: ParseSpeeds.Medium,
    })
    if (doc.isEncrypted) throw new PdfDocumentError('encrypted', 'Encrypted PDFs cannot be edited in this version.')
    return doc
  } catch (error) {
    if (error instanceof PdfDocumentError) throw error
    if (error instanceof Error && /encrypted/i.test(error.name + error.message)) {
      throw new PdfDocumentError('encrypted', 'This PDF is encrypted. Password unlocking and encrypted saving are not supported.')
    }
    throw new PdfDocumentError('invalid-pdf', error instanceof Error ? error.message : 'The PDF could not be parsed.')
  }
}

export async function loadPdfDocument(bytes: Uint8Array): Promise<PdfDocumentInfo> {
  return measurePdfAsync('host.inspect', { inputBytes: bytes.byteLength }, async () => documentInfo(await parse(bytes)))
}

function fail(message: string): never {
  throw new PdfDocumentError('invalid-operation', message)
}

function validateColor(color: unknown) {
  if (!Array.isArray(color) || color.length !== 3 || color.some((c) => typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1)) {
    fail('Annotation color must contain three numbers between zero and one.')
  }
}

function validateNew(annotation: NewPdfAnnotation, doc: PDFDocument) {
  if (!annotation || typeof annotation.id !== 'string' || !annotation.id.trim() || annotation.id.length > 200) fail('An annotation requires a unique ID.')
  if (!Number.isInteger(annotation.page) || annotation.page < 1 || annotation.page > doc.getPageCount()) fail('Annotation page is outside this document.')
  if (!editableTypes.has(annotation.subtype)) fail('Unsupported annotation type.')
  if (!validRect(annotation.rect)) fail('Annotation rectangle must have a positive width and height.')
  if (annotation.subtype !== 'Text' && !validQuads(annotation.quadPoints)) fail('Text markup requires quadrilateral coordinates.')
  if (annotation.quadPoints !== undefined) {
    if (!validQuads(annotation.quadPoints)) fail('Invalid quadrilateral coordinates.')
    const [left, bottom, right, top] = annotation.rect
    annotation.quadPoints.forEach((n, index) => {
      if (n < (index % 2 ? bottom : left) - 0.01 || n > (index % 2 ? top : right) + 0.01) fail('Quadrilateral extends outside the annotation rectangle.')
    })
    for (let i = 0; i < annotation.quadPoints.length; i += 8) {
      const q = annotation.quadPoints.slice(i, i + 8)
      const area = Math.abs((q[2] - q[0]) * (q[5] - q[1]) - (q[3] - q[1]) * (q[4] - q[0]))
      if (area < 0.000001) fail('Annotation quadrilaterals must have a positive area.')
    }
  }
  if (annotation.color !== undefined) validateColor(annotation.color)
  if (annotation.contents !== undefined && typeof annotation.contents !== 'string') fail('Annotation contents must be text.')
  if (annotation.author !== undefined && typeof annotation.author !== 'string') fail('Annotation author must be text.')
}

function setContents(dictionary: PDFDict, contents: string) {
  dictionary.set(PDFName.of('Contents'), PDFHexString.fromText(contents))
  // Rich text may contain a different copy of the comment; retaining it would show stale text.
  dictionary.delete(PDFName.of('RC'))
}

function addAnnotation(doc: PDFDocument, annotation: NewPdfAnnotation, when: Date): AnnotationEntry {
  validateNew(annotation, doc)
  const page = doc.getPage(annotation.page - 1)
  const color = annotation.color ?? defaultColor
  const timestamp = PDFString.fromDate(when)
  const dictionary = doc.context.obj({
    Type: 'Annot', Subtype: annotation.subtype, P: page.ref,
    Rect: annotation.rect, C: color, F: 4,
    NM: PDFHexString.fromText(annotation.id), DSHPDFId: PDFHexString.fromText(annotation.id),
    CreationDate: timestamp, M: timestamp,
  })
  if (annotation.quadPoints) dictionary.set(PDFName.of('QuadPoints'), doc.context.obj(annotation.quadPoints))
  if (annotation.subtype === 'Text') dictionary.set(PDFName.of('Name'), PDFName.of('Comment'))
  if (annotation.contents !== undefined) setContents(dictionary, annotation.contents)
  if (annotation.author !== undefined) dictionary.set(PDFName.of('T'), PDFHexString.fromText(annotation.author))
  const value = doc.context.register(dictionary)
  const existingArray = get(doc, page.node, 'Annots')
  const array = existingArray instanceof PDFArray ? existingArray : doc.context.obj([])
  if (!(existingArray instanceof PDFArray)) {
    page.node.set(PDFName.of('Annots'), array)
  }
  array.push(value)
  return {
    value, dictionary, array,
    model: {
      ...annotation, rect: [...annotation.rect], quadPoints: annotation.quadPoints?.slice(), color: [...color],
      createdAt: timestamp.decodeText(), modifiedAt: timestamp.decodeText(),
      flags: 4, supported: true, editable: true, sourceObjectId: `dsh-new:${annotation.id}`,
    },
  }
}

/** Compact each changed Annots array once; repeated splice operations copy its tail. */
function removeQueuedAnnotations(doc: PDFDocument, removals: Map<PDFArray, Set<PDFDict>>) {
  for (const [array, dictionaries] of removals) {
    const length = array.size()
    let writeIndex = 0
    for (let readIndex = 0; readIndex < length; readIndex++) {
      const value = array.get(readIndex)
      const dictionary = doc.context.lookup(value)
      if (dictionary instanceof PDFDict && dictionaries.has(dictionary)) continue
      if (writeIndex !== readIndex) array.set(writeIndex, value)
      writeIndex++
    }
    // Remove only the compacted tail: each splice now removes the final element.
    while (array.size() > writeIndex) array.remove(array.size() - 1)
  }
}

/**
 * Apply a batch to an isolated parse. Failures never mutate caller bytes or return a partial batch.
 * Keep baseline bytes + operation history for undo/redo. Rebase the baseline after manual save.
 */
export async function applyPdfOperations(
  bytes: Uint8Array,
  operations: readonly PdfAnnotationOperation[],
  operationDates?: readonly string[],
): Promise<{ bytes: Uint8Array; document: PdfDocumentInfo }> {
  return measurePdfAsync('host.materialize', { inputBytes: bytes.byteLength, operationCount: Array.isArray(operations) ? operations.length : 0 },
    () => applyPdfOperationsImpl(bytes, operations, operationDates))
}

async function applyPdfOperationsImpl(
  bytes: Uint8Array,
  operations: readonly PdfAnnotationOperation[],
  operationDates?: readonly string[],
): Promise<{ bytes: Uint8Array; document: PdfDocumentInfo }> {
  if (!Array.isArray(operations)) fail('An annotation operation list is required.')
  if (operationDates && operationDates.length !== operations.length) fail('Operation dates do not match the operation list.')
  const doc = await parse(bytes)
  if (hasSignature(doc)) throw new PdfDocumentError('read-only', 'Digitally signed PDFs are read only in this version.')
  const initialEntries = annotationEntries(doc)
  const info = documentInfo(doc, { signed: false, annotations: initialEntries.map((entry) => entry.model) })
  if (operations.length === 0) return { bytes: bytes.slice(), document: info }
  const entries = new Map(initialEntries.map((entry) => [entry.model.id, entry]))
  const byDictionary = new Map<PDFDict, AnnotationEntry[]>()
  const appearances = new Map<PDFDict, AnnotationEntry>()
  const removals = new Map<PDFArray, Set<PDFDict>>()
  const removedPopups = new Set<PDFDict>()
  const queueRemoval = (entry: AnnotationEntry) => {
    let dictionaries = removals.get(entry.array)
    if (!dictionaries) { dictionaries = new Set(); removals.set(entry.array, dictionaries) }
    dictionaries.add(entry.dictionary)
    entries.delete(entry.model.id)
  }
  let reindexAnnotations = false
  for (const entry of initialEntries) {
    const aliases = byDictionary.get(entry.dictionary)
    if (aliases) { aliases.push(entry); reindexAnnotations = true }
    else byDictionary.set(entry.dictionary, [entry])
  }
  // Direct dictionaries have no object reference identity. Persist their current
  // IDs before deleting anything can shift another annotation's array index.
  for (const entry of entries.values()) {
    if (entry.model.editable && !(entry.value instanceof PDFRef)) {
      entry.dictionary.set(privateId, PDFHexString.fromText(entry.model.id))
    }
  }
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex++) {
    const operation = operations[operationIndex]
    const when = operationDates ? new Date(operationDates[operationIndex]) : new Date()
    if (!Number.isFinite(when.getTime())) fail('An operation has an invalid date.')
    if (!operation || !['add', 'update', 'delete'].includes(operation.type)) fail('Unsupported annotation operation.')
    if (operation.type === 'add') {
      const existing = entries.get(operation.annotation?.id)
      if (existing && !removals.get(existing.array)?.has(existing.dictionary)) fail('Annotation ID already exists.')
      const added = addAnnotation(doc, operation.annotation, when)
      entries.set(added.model.id, added)
      byDictionary.set(added.dictionary, [added])
      appearances.set(added.dictionary, added)
      continue
    }
    const entry = entries.get(operation.id)
    if (!entry || removals.get(entry.array)?.has(entry.dictionary)) {
      throw new PdfDocumentError('unknown-annotation', `Annotation not found: ${operation.id}`)
    }
    if (!entry.model.editable) throw new PdfDocumentError('annotation-read-only', `Annotation cannot be edited: ${entry.model.readOnlyReason}`)
    if (operation.type === 'delete') {
      reindexAnnotations = true
      appearances.delete(entry.dictionary)
      const popup = get(doc, entry.dictionary, 'Popup')
      if (popup instanceof PDFDict && !removedPopups.has(popup)) {
        removedPopups.add(popup)
        for (const associated of byDictionary.get(popup) ?? []) {
          if (associated.model.subtype === 'Popup') queueRemoval(associated)
        }
      }
      // A dictionary may be referenced from several Annots arrays. Removing
      // only the selected entry would leave the same visible annotation behind.
      for (const alias of byDictionary.get(entry.dictionary) ?? [entry]) queueRemoval(alias)
      continue
    }
    const patch = operation.patch
    if (!patch || Object.keys(patch).some((key) => key !== 'contents' && key !== 'color')) fail('Only annotation color and contents can be changed.')
    if (patch.contents !== undefined) {
      if (typeof patch.contents !== 'string') fail('Annotation contents must be text.')
      setContents(entry.dictionary, patch.contents)
      for (const alias of byDictionary.get(entry.dictionary) ?? [entry]) alias.model.contents = patch.contents
    }
    if (patch.color !== undefined) {
      validateColor(patch.color)
      const unchanged = entry.model.color?.every((value, index) => value === patch.color![index])
      if (!unchanged) {
        entry.dictionary.set(PDFName.of('C'), doc.context.obj(patch.color))
        const color: PdfColor = [patch.color[0], patch.color[1], patch.color[2]]
        for (const alias of byDictionary.get(entry.dictionary) ?? [entry]) alias.model.color = color
        appearances.set(entry.dictionary, entry)
      }
    }
    // A modified direct dictionary gets a persistent ID before array positions can change.
    if (!(entry.value instanceof PDFRef)) entry.dictionary.set(privateId, PDFHexString.fromText(entry.model.id))
    const timestamp = PDFString.fromDate(when)
    entry.dictionary.set(PDFName.of('M'), timestamp)
    for (const alias of byDictionary.get(entry.dictionary) ?? [entry]) alias.model.modifiedAt = timestamp.decodeText()
  }
  removeQueuedAnnotations(doc, removals)
  // Recovery can replay many edits of the same highlight. Only its final visible
  // appearance needs a stream, and deleted annotations need no new appearance.
  for (const entry of appearances.values()) {
    setAnnotationAppearance(doc, entry.dictionary, entry.model.subtype as EditableAnnotationType,
      entry.model.rect!, entry.model.quadPoints, entry.model.color ?? defaultColor)
  }
  const saved = await doc.save({
    useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 500,
  })
  // pdf-lib preserves object references during serialization. Derive metadata
  // from the graph we just wrote instead of parsing the entire PDF a second time.
  // Deletion can shift unsupported direct annotations, so recompute only their
  // enumeration/identities when the annotation graph's membership changed.
  const annotations = reindexAnnotations
    ? annotationEntries(doc).map((entry) => entry.model)
    : [...entries.values()].map((entry) => entry.model).sort((left, right) => left.page - right.page)
  return { bytes: saved, document: { ...info, annotations } }
}
