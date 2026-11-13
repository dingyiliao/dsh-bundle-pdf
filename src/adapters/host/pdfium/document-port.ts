import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PdfDocumentError, type PdfAnnotation, type PdfDocumentInfo, type PdfFormOperation, type PdfOutlineItem } from '../../../core/pdf-types.js'
import { createNativeHandleLease } from '../../../engine/host/handle-lease.js'
import { isOutlineOperation } from '../../../modules/outlines/index.js'
import { projectWorkingCopyOperations, type PdfDocumentPort } from '../../../modules/working-copy/index.js'
import { measurePdfAsync } from '../../../shared/performance.js'
import { applyNativeAnnotations, readNativeAnnotations } from './document-annotations.js'
import { decodeFormFields, encodeFormEdits } from './document-forms.js'
import { nativeOutlineEditRows, readNativeDocumentMetadata } from './document-metadata.js'
import { readNativeSavedBytes } from './save-bytes.js'
import { NativeWorker, type NativeProcessRuntime } from '../../../engine/host/native-worker.js'
import type { NativeReply } from '../../../engine/protocol/commands.js'

type Probe = NativeReply<'open'>['value']

const formFont = new URL(import.meta.url.endsWith('.ts')
  ? '../../../../assets/fonts/NotoSansCJKsc-Regular.otf' : './assets/forms/NotoSansCJKsc-Regular.otf', import.meta.url)

/** A separate command loop keeps document scans and saves off the render queue. */
export function createNativeDocumentPort(executable: string, subprocess: NativeProcessRuntime):
  PdfDocumentPort & { dispose(): Promise<void> } {
  const worker = new NativeWorker(executable, subprocess, 120_000)
  const lease = createNativeHandleLease()
  const lifetime = new AbortController()
  const { signal } = lifetime
  let disposal: Promise<void> | undefined

  async function open<T>(bytes: Uint8Array, use: (id: string, probe: Probe) => Promise<T>): Promise<T> {
    const documentId = randomUUID()
    const generation = worker.generation
    let opened = false
    try {
      signal.throwIfAborted()
      const { value: probe } = await worker.openDocument(documentId, bytes, { metadataOnly: true })
      opened = true
      signal.throwIfAborted()
      return await use(documentId, probe)
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        if (error.code === 'pdf/password-required' || error.code === 'pdf/security-unsupported') {
          throw new PdfDocumentError('encrypted', error.message)
        }
        if (error.code === 'pdf/native-open') throw new PdfDocumentError('invalid-pdf', error.message)
      }
      throw error
    } finally {
      if (opened && !signal.aborted && worker.generation === generation) {
        await worker.closeDocument(documentId).catch(() => undefined)
      }
    }
  }

  async function requireExtensions(): Promise<void> {
    await worker.ready()
    if (!worker.documentExtensions) throw new Error('The configured PDFium helper does not expose document extensions')
  }

  async function readFormFields(documentId: string, readOnly: boolean): Promise<PdfDocumentInfo['formFields']> {
    const fields: NonNullable<PdfDocumentInfo['formFields']> = []
    const limit = 512
    let offset = 0
    for (;;) {
      const { value } = await worker.inspectFormFields({ documentId, offset, limit }, signal)
      const end = offset + value.fields.length
      if (value.fields.length > limit || (value.nextOffset !== null && (value.nextOffset !== end || end === offset))) {
        throw new Error('Invalid native form metadata cursor')
      }
      fields.push(...decodeFormFields(value.fields, readOnly))
      if (value.nextOffset === null) return fields
      if (end >= 100_000) throw Object.assign(new Error('The PDF form exceeds the supported field count'), { code: 'pdf/native-form' })
      offset = value.nextOffset
    }
  }

  async function describe(documentId: string, probe: Probe) {
    const security = (await worker.inspectSecurity({ documentId }, signal)).value
    if (security.securityRevision >= 0) throw new PdfDocumentError('encrypted', 'Open protected PDFs through the Reader.')
    const header = await readNativeDocumentMetadata({
      probe,
      readDocumentInfo: async (offset, limit) => (await worker.inspectDocument({ documentId, offset, limit }, signal)).value,
      readFingerprints: async (offset, limit) => (await worker.getPageFingerprints({ documentId, offset, limit }, signal)).value,
      readOutlines: async () => (await worker.readOutlines({ documentId }, signal)).value,
    })
    const annotations = await readNativeAnnotations(worker, documentId, header.pageCount, header.readOnlyReason, signal)
    let formFields: PdfDocumentInfo['formFields']
    if (header.formKind === 'acroform') {
      try {
        formFields = await readFormFields(documentId, header.readOnly)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'pdf/native-form')) throw error
      }
    }
    return { document: { ...header, annotations: annotations.annotations, formFields }, annotations }
  }

  // A working copy retains its exact source buffer. Reuse the inspection
  // with that identity, without retaining evicted PDF bytes or page handles.
  const inspections = new WeakMap<Uint8Array, Awaited<ReturnType<typeof describe>>>()
  async function inspectSource(bytes: Uint8Array) {
    const known = inspections.get(bytes)
    if (known) return known
    const loaded = await open(bytes, describe)
    inspections.set(bytes, loaded)
    return loaded
  }

  return {
    async inspect(bytes) {
      return measurePdfAsync('host.inspect', { inputBytes: bytes.byteLength }, () => lease.run(async () => {
        await requireExtensions()
        return (await inspectSource(bytes)).document
      }, signal))
    },
    async materialize(bytes, operations, dates) {
      return measurePdfAsync('host.materialize', { inputBytes: bytes.byteLength, operationCount: operations.length }, () => lease.run(async () => {
        await requireExtensions()
        const output = await open(bytes, async (documentId, probe) => {
          const baseline = inspections.get(bytes) ?? await describe(documentId, probe)
          const source = baseline.document
          if (source.readOnly) throw new PdfDocumentError('read-only', source.readOnlyReason ?? 'The PDF is read-only.')
          // Persisted history may edit a field again in a later undo group.
          const projected = projectWorkingCopyOperations(source, operations, dates, { allowRepeatedFormFields: true })
          const forms = operations.filter((operation): operation is PdfFormOperation => operation.type === 'set-field')
          if (!operations.length) return { bytes, document: source }
          if (operations.some(operation => operation.type === 'add' || operation.type === 'update' || operation.type === 'delete')) {
            await applyNativeAnnotations(worker, documentId, baseline.annotations, projected, signal)
          }
          if (operations.some(isOutlineOperation)) {
            await worker.writeOutlines({ documentId,
              entries: nativeOutlineEditRows(source.outline!, projected.outline!) }, signal)
          }
          if (forms.length) {
            const edits = encodeFormEdits(source.formFields ?? [], forms)
            // Choice export values and visible labels can differ, so let PDFium inspect the labels.
            const needsFont = edits.some(edit => edit.type === 'dropdown' || edit.type === 'option-list'
              || (edit.type === 'text' && /[^\x00-\x7f]/.test(edit.value)))
            const font = needsFont ? await readFile(formFont, { signal }) : undefined
            await worker.writeFormFields({ documentId, edits }, font ?? new Uint8Array(), signal)
          }
          return { bytes: await readNativeSavedBytes(worker, documentId, signal), projected }
        })
        if (output.document) return { bytes: output.bytes, document: output.document }
        const saved = await inspectSource(output.bytes)
        verifySave(output.projected, saved.document)
        return { bytes: output.bytes, document: saved.document }
      }, signal))
    },
    dispose() {
      if (disposal) return disposal
      const reason = new Error('PDF document engine is unloading')
      lifetime.abort(reason)
      lease.close(reason)
      disposal = worker.dispose()
      return disposal
    },
  }
}

function equalNumbers(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
  return left === right || !!left && !!right && left.length === right.length
    && left.every((value, index) => Math.abs(value - right[index]) <= Math.max(0.004, Math.abs(value) * 0.000001))
}

function equalAnnotation(expected: PdfAnnotation, actual: PdfAnnotation): boolean {
  const defaultOpacity = expected.subtype === 'Highlight' ? 0.4 : 1
  return expected.page === actual.page && expected.subtype === actual.subtype && expected.flags === actual.flags
    && (!expected.sourceObjectId?.startsWith('dsh-new:') || expected.id === actual.id)
    && (expected.contents ?? '') === (actual.contents ?? '') && (expected.author ?? '') === (actual.author ?? '')
    && expected.createdAt === actual.createdAt && expected.modifiedAt === actual.modifiedAt
    && Math.abs((expected.opacity ?? defaultOpacity) - (actual.opacity ?? defaultOpacity)) <= 0.004
    && expected.hasRichText === actual.hasRichText && equalNumbers(expected.rect, actual.rect)
    && equalNumbers(expected.quadPoints, actual.quadPoints) && equalNumbers(expected.color, actual.color)
    && equalNumbers(expected.commentPosition, actual.commentPosition)
}

function comparableOutline(items: readonly PdfOutlineItem[] | undefined): unknown {
  return items?.map(({ id, title, page, children }) => [id, title, page, comparableOutline(children)])
}

function comparableValue(value: unknown): string | undefined {
  return JSON.stringify(Array.isArray(value) ? [...value].sort() : value)
}

function verifySave(expected: PdfDocumentInfo, saved: PdfDocumentInfo): void {
  const annotations = new Map(expected.annotations.map((item, index) => [item.id, index]))
  const actual = new Map(saved.annotations.map((item, index) => [item.id, index]))
  const values = new Map(saved.formFields?.map(field => [field.id, field.value]))
  const requireMatch = (matches: boolean, section: string) => {
    if (!matches) throw new Error(`The PDF reopened with different ${section} after the native save`)
  }
  requireMatch(!saved.encrypted && !saved.readOnly && saved.pageCount === expected.pageCount
    && saved.formKind === expected.formKind, 'document capabilities')
  requireMatch(expected.pages.every((page, index) => equalNumbers(page.cropBox, saved.pages[index].cropBox)
    && page.rotation === saved.pages[index].rotation && page.userUnit === saved.pages[index].userUnit), 'page geometry')
  requireMatch(expected.annotations.length === saved.annotations.length, 'annotation count')
  requireMatch(expected.annotations.every((item, index) => equalAnnotation(item, saved.annotations[index])
    && annotations.get(item.replyToId ?? '') === actual.get(saved.annotations[index].replyToId ?? '')), 'annotation data')
  requireMatch(expected.formFields?.every(field => comparableValue(field.value) === comparableValue(values.get(field.id)))
    ?? true, 'form values')
  requireMatch(JSON.stringify(comparableOutline(expected.outline)) === JSON.stringify(comparableOutline(saved.outline)), 'bookmarks')
}
