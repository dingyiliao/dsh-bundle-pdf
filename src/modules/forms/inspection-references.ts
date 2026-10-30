import { z } from 'zod'
import type { FormPageInspection } from './index.js'
import type { PdfDocumentInfo } from '../../core/pdf-types.js'
import { formFieldId } from './identity.js'

export const formControlReferenceSchema = z.object({ page: z.number().int().min(1).max(100000),
  label: z.string().regex(/^F(?:0[1-9]|[1-9][0-9]|100)$/) }).strict()
export type FormControlReference = z.infer<typeof formControlReferenceSchema>
export type FormInspectionIdentity = { sessionId: string; documentId: string; revision: number;
  contentVersion: string; sourceDigest: string }
export type FormInspectionTarget = FormControlReference & { fieldId: string; sharedFieldKey: string; option?: string }
type Record = { identity: FormInspectionIdentity; page: number; createdAt: number;
  validatedRevision: number; changedFieldIds: Set<string>; controls: Map<string, FormInspectionTarget> }
type Queue = { sessionId: string; active: boolean; tail: Promise<void> }

export class FormInspectionReferenceError extends Error {
  readonly code = 'pdf/form-inspection-required'
  constructor() { super('Inspect every referenced page again: the inspection is missing, expired, ambiguous or conflicts with the current document revision') }
}

const sameSource = (left: FormInspectionIdentity, right: FormInspectionIdentity) =>
  left.sessionId === right.sessionId && left.documentId === right.documentId
  && left.contentVersion === right.contentVersion && left.sourceDigest === right.sourceDigest
const sameInspection = (left: FormInspectionIdentity, right: FormInspectionIdentity) =>
  sameSource(left, right) && left.revision === right.revision

/** Canonical document order is shared by the private mapping and the public G<n> projection. */
function sharedFieldKeys(document: PdfDocumentInfo): Map<string, string> {
  const result = new Map<string, string>()
  for (const [index, field] of (document.formFields ?? []).entries()) {
    const id = formFieldId(field)
    if (result.has(id)) throw new FormInspectionReferenceError()
    result.set(id, `G${index + 1}`)
  }
  return result
}

/** Ephemeral control aliases, never form values or images; not file authorization. */
export function createFormInspectionRegistry({ limit = 128, now = Date.now }:
  { limit?: number; now?: () => number } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new RangeError('Invalid form inspection limit')
  const records = new Map<string, Record>()
  const queues = new Map<string, Queue>()
  let disposed = false
  const expired = (record: Record) => now() - record.createdAt >= 10 * 60_000
  const baseValid = (record: Record, identity: FormInspectionIdentity) => !disposed
    && !expired(record) && sameSource(record.identity, identity) && record.validatedRevision === identity.revision
  return {
    issue(identity: FormInspectionIdentity, inspection: FormPageInspection, document: PdfDocumentInfo): string {
      if (disposed) throw new FormInspectionReferenceError()
      const keys = sharedFieldKeys(document)
      const controls = new Map<string, FormInspectionTarget>()
      for (const field of inspection.fields) for (const control of field.controls) {
        const sharedFieldKey = keys.get(field.fieldId)
        if (!sharedFieldKey || control.fieldId !== field.fieldId || controls.has(control.label)) {
          throw new FormInspectionReferenceError()
        }
        controls.set(control.label, { page: inspection.page, label: control.label, fieldId: control.fieldId,
          sharedFieldKey,
          ...(control.option !== undefined ? { option: control.option } : {}) })
      }
      const id = `form-inspect_${crypto.randomUUID()}`
      for (const [key, record] of records) if (expired(record)) records.delete(key)
      records.set(id, { identity: { ...identity }, page: inspection.page, createdAt: now(), controls,
        validatedRevision: identity.revision, changedFieldIds: new Set() })
      while (records.size > limit) records.delete(records.keys().next().value!)
      return id
    },
    resolve(inspectionId: string, currentIdentity: FormInspectionIdentity, expectedRevision: number) {
      const identity = { ...currentIdentity }
      const primary = records.get(inspectionId)
      const assertPrimary = () => {
        if (!primary || records.get(inspectionId) !== primary || !baseValid(primary, identity) || primary.changedFieldIds.size > 0
          || primary.identity.revision !== expectedRevision) throw new FormInspectionReferenceError()
      }
      assertPrimary()
      const controls = new Map([...primary!.controls].map(([label, target]) => [label, { ...target }]))
      const resolvedShared = new Map<string, FormInspectionTarget>()
      return {
        page: primary!.page,
        get(label: string): FormInspectionTarget {
          const target = controls.get(label)
          if (!target) throw new FormInspectionReferenceError()
          return { ...target }
        },
        getShared(sharedFieldKey: string): FormInspectionTarget {
          const cached = resolvedShared.get(sharedFieldKey)
          if (cached) return { ...cached }
          assertPrimary()
          // A dependency needs proof for this field, not an unchanged surrounding page.
          for (const record of [primary!, ...records.values()]) {
            if (!sameInspection(record.identity, primary!.identity) || !baseValid(record, identity)) continue
            for (const target of record.controls.values()) if (target.sharedFieldKey === sharedFieldKey
              && !record.changedFieldIds.has(target.fieldId)) {
              resolvedShared.set(sharedFieldKey, { ...target })
              return { ...target }
            }
          }
          throw new FormInspectionReferenceError()
        },
        reference(fieldId: string): FormInspectionTarget | undefined {
          for (const target of [...controls.values(), ...resolvedShared.values()]) {
            if (target.fieldId === fieldId) return { ...target }
          }
          return undefined
        },
      }
    },
    /** Only a known successful form write may rebase inspections; UI edits, undo and source changes never do. */
    advance(before: FormInspectionIdentity, newRevision: number, changedFieldIds: readonly string[]): void {
      // This bookkeeping runs after the durable commit. Unload has already
      // revoked every record, and must not turn a committed write into a false failure.
      if (disposed) return
      if (!Number.isSafeInteger(newRevision) || newRevision !== before.revision + 1) {
        throw new FormInspectionReferenceError()
      }
      const changed = new Set(changedFieldIds)
      for (const record of records.values()) {
        if (!baseValid(record, before)) continue
        for (const target of record.controls.values()) if (changed.has(target.fieldId)) record.changedFieldIds.add(target.fieldId)
        record.validatedRevision = newRevision
      }
    },
    enqueue<T>(sessionId: string, documentId: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
      if (disposed) return Promise.reject(new FormInspectionReferenceError())
      const key = JSON.stringify([sessionId, documentId])
      let queue = queues.get(key)
      if (!queue) {
        queue = { sessionId, active: true, tail: Promise.resolve() }
        queues.set(key, queue)
      }
      const lane = queue
      const result = lane.tail.then(() => {
        signal?.throwIfAborted()
        if (disposed || !lane.active) throw new FormInspectionReferenceError()
        return task()
      })
      // A failure or cancellation belongs to one caller, not to the queue's next write.
      const tail = result.then(() => undefined, () => undefined)
      lane.tail = tail
      void tail.then(() => { if (queues.get(key) === lane && lane.tail === tail) queues.delete(key) })
      return result
    },
    deleteSession(sessionId: string): void {
      for (const [id, record] of records) if (record.identity.sessionId === sessionId) records.delete(id)
      for (const [key, queue] of queues) if (queue.sessionId === sessionId) {
        queue.active = false
        queues.delete(key)
      }
    },
    dispose(): void {
      disposed = true
      records.clear()
      for (const queue of queues.values()) queue.active = false
      queues.clear()
    },
  }
}
export type FormInspectionRegistry = ReturnType<typeof createFormInspectionRegistry>

function modelFieldValue(field: FormPageInspection['fields'][number]) {
  if (field.type !== 'dropdown' || field.value === undefined) return field.value
  const value = Array.isArray(field.value) && field.value.length <= 1 ? field.value[0] ?? '' : field.value
  if (typeof value !== 'string' || value !== '' && !field.options?.includes(value)) {
    throw Object.assign(new Error('Dropdown value cannot be represented as one exact option string'),
      { code: 'pdf/form-inspection-unavailable' })
  }
  return value
}

/** Explicit model boundary: keep native identities, geometry and author hints inside the Host. */
export function modelFormInspectionFields(inspection: FormPageInspection, document: PdfDocumentInfo) {
  const keys = sharedFieldKeys(document)
  return inspection.fields.map(field => {
    const sharedFieldKey = keys.get(field.fieldId)
    if (!sharedFieldKey) throw new FormInspectionReferenceError()
    // Draft/native dropdowns store selected options as an array; model reads and writes one string.
    const value = modelFieldValue(field)
    return {
      sharedFieldKey,
      type: field.type,
      valueType: field.valueType,
      required: field.required,
      ...(field.options !== undefined ? { options: [...field.options] } : {}),
      ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
      ...(field.multiline !== undefined ? { multiline: field.multiline } : {}),
      ...(field.multiple !== undefined ? { multiple: field.multiple } : {}),
      ...(value !== undefined ? { value: Array.isArray(value) ? [...value] : value } : {}),
      controls: field.controls.map(control => ({ label: control.label,
        ...(field.type === 'radio' && control.option !== undefined ? { option: control.option } : {}) })),
    }
  })
}
