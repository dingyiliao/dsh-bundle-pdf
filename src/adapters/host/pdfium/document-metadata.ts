import { createHash } from 'node:crypto'
import { PdfDocumentError, type PdfDocumentInfo, type PdfOutlineItem, type PdfPageInfo, type PdfRect } from '../../../core/pdf-types.js'
import { MAX_OUTLINE_DEPTH, MAX_OUTLINE_ITEMS } from '../../../modules/outlines/index.js'
import type { NativeReply, NativeRequest } from '../../../engine/protocol/commands.js'

type OutlineMetadata = Pick<PdfDocumentInfo, 'outline' | 'outlineReadOnlyReason'>
type DocumentMetadata = Omit<PdfDocumentInfo, 'annotations' | 'formFields'>
type FingerprintMetadata = Pick<PdfDocumentInfo, 'indexContentDigest' | 'indexPageDigests'>
type OutlineEdit = Extract<NativeRequest, { command: 'applyOutlines' }>['entries'][number]
type NativePage = NativeReply<'documentInfo'>['value']['pages'][number]
const batchSize = 512

const validBox = (box: PdfRect) => box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1]
const invalidGeometry = () => Object.assign(new Error('PDFium could not verify the document page geometry'), { code: 'pdf/native-document-info' })

function pageInfo(raw: NativePage): PdfPageInfo {
  const { page, mediaBox, cropBox, rotation, userUnit, visibleBox, boxSource, renderedWidth, renderedHeight } = raw
  if (userUnit !== null) {
    if (!validBox(mediaBox) || !validBox(cropBox) || !Number.isFinite(userUnit) || userUnit <= 0) throw invalidGeometry()
    return { page, mediaBox, cropBox, rotation, userUnit }
  }
  if (!validBox(visibleBox)) throw invalidGeometry()
  // Malformed page dictionaries can still expose reliable effective bounds.
  const width = visibleBox[2] - visibleBox[0], height = visibleBox[3] - visibleBox[1]
  const quarterTurn = rotation % 180 !== 0
  const scale = renderedWidth / (quarterTurn ? height : width)
  const projectedHeight = scale * (quarterTurn ? width : height)
  if (!Number.isFinite(scale) || scale <= 0 || Math.abs(projectedHeight - renderedHeight) > Math.max(0.01, renderedHeight * 0.00001)) {
    throw invalidGeometry()
  }
  return { page, cropBox: visibleBox, rotation, userUnit: scale,
    ...(boxSource === 'page-dictionary' && validBox(mediaBox) ? { mediaBox } : {}) }
}

function outlineInfo(result: NativeReply<'documentOutlines'>['value'], pageCount: number): OutlineMetadata {
  if ('readOnlyReason' in result) return { outlineReadOnlyReason: result.readOnlyReason }
  const invalid = { outlineReadOnlyReason: 'The PDF outline contains an invalid tree or destination.' }
  const outline: PdfOutlineItem[] = []
  const path: { index: number; item: PdfOutlineItem }[] = []
  const identities = new Set<string>()
  if (result.entries.length > MAX_OUTLINE_ITEMS) return invalid
  for (const [index, { id, title, parentIndex, pageIndex }] of result.entries.entries()) {
    while (path.length && path.at(-1)!.index !== parentIndex) path.pop()
    if ((parentIndex !== -1 && !path.length) || path.length >= MAX_OUTLINE_DEPTH || pageIndex >= pageCount
      || !id.trim() || id.includes('\0') || identities.has(id)) return invalid
    identities.add(id)
    const item: PdfOutlineItem = { id, title, ...(pageIndex >= 0 ? { page: pageIndex + 1 } : {}), children: [] }
    const siblings = path.at(-1)?.item.children ?? outline
    siblings.push(item)
    path.push({ index, item })
  }
  return { outline }
}

function fingerprintInfo(digests: (string | null)[]): FingerprintMetadata {
  if (!digests.some(Boolean)) return {}
  const indexPageDigests = Object.freeze(digests)
  if (digests.includes(null)) return { indexPageDigests }
  // Delimit this version from legacy identities. Fixed-length digests preserve page order.
  const hash = createHash('sha256').update('dsh-pdfium-index-content-v1\0')
  for (const digest of digests) hash.update(digest!)
  return { indexPageDigests, indexContentDigest: `sha256:${hash.digest('hex')}` }
}

export async function readNativeDocumentMetadata(options: {
  probe: NativeReply<'open'>['value']
  readDocumentInfo(offset: number, limit: number): Promise<NativeReply<'documentInfo'>['value']>
  readFingerprints(offset: number, limit: number): Promise<NativeReply<'fingerprints'>['value']>
  readOutlines(): Promise<NativeReply<'documentOutlines'>['value']>
}): Promise<DocumentMetadata> {
  const { probe, readDocumentInfo, readFingerprints, readOutlines } = options
  const pages: PdfPageInfo[] = []
  let header: Pick<NativeReply<'documentInfo'>['value'], 'title' | 'permissions' | 'securityRevision'> | undefined
  for (let offset = 0; offset < probe.pageCount; offset += batchSize) {
    const limit = Math.min(batchSize, probe.pageCount - offset)
    const reply = await readDocumentInfo(offset, limit)
    header ??= { title: reply.title, permissions: reply.permissions, securityRevision: reply.securityRevision }
    if (reply.pages.length !== limit || reply.securityRevision !== header.securityRevision || reply.permissions !== header.permissions) {
      throw invalidGeometry()
    }
    for (const raw of reply.pages) {
      if (raw.page !== pages.length + 1) throw invalidGeometry()
      pages.push(pageInfo(raw))
    }
  }
  if (!header) throw invalidGeometry()
  const encrypted = header.securityRevision >= 0
  const signed = probe.signatureStatus === undefined ? probe.signatureCount !== 0 : probe.signatureStatus !== 0
  const formKind = probe.formType === 1 ? 'acroform' : probe.formType === 2 || probe.formType === 3 ? 'xfa' : undefined
  const readOnlyReason = encrypted ? 'encrypted-document' : signed ? 'signed-document' : formKind === 'xfa' ? 'xfa-document' : undefined
  const digests: (string | null)[] = []
  if (!encrypted) for (let offset = 0; offset < pages.length; offset += batchSize) {
    const limit = Math.min(batchSize, pages.length - offset)
    const { digests: batch } = await readFingerprints(offset, limit)
    if (batch.length !== limit) throw new Error('PDFium returned an incomplete page fingerprint batch')
    digests.push(...batch)
  }
  return { pageCount: probe.pageCount, pages, title: header.title, signed, encrypted, formKind,
    readOnly: !!readOnlyReason, readOnlyReason,
    ...(encrypted ? { allowTextExtraction: (header.permissions & 0x10) !== 0 } : {}),
    ...fingerprintInfo(digests), ...outlineInfo(await readOutlines(), pages.length) }
}

/** Preserve a source item's style and destination unless an operation changed that field. */
export function nativeOutlineEditRows(current: readonly PdfOutlineItem[], projected: readonly PdfOutlineItem[]): OutlineEdit[] {
  const prior = new Map<string, PdfOutlineItem>()
  const pending = [...current]
  while (pending.length) {
    const item = pending.pop()!
    prior.set(item.id, item)
    pending.push(...item.children)
  }
  const result: OutlineEdit[] = []
  function append(items: readonly PdfOutlineItem[], parentIndex: number) {
    for (const item of items) {
      const old = prior.get(item.id)
      const index = result.length
      const retarget = !old || item.targetChanged || old.page !== item.page
      if (retarget && item.page === undefined) throw new PdfDocumentError('invalid-operation', 'A new PDF bookmark destination is required.')
      result.push({ id: item.id, parentIndex, pageIndex: retarget ? item.page! - 1 : -1,
        ...(!old || old.title !== item.title ? { title: item.title } : {}) })
      append(item.children, index)
    }
  }
  append(projected, -1)
  return result
}
