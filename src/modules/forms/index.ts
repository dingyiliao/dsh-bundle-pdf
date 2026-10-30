import type { PdfDocumentInfo, PdfFormField, PdfRect } from '../../core/pdf-types.js'
import { NativeViewport } from '../../shared/geometry/native-viewport.js'
import { formFieldId } from './identity.js'
import { layoutFormInspection } from './inspection-layout.js'
export { formFieldId, resolveFormField } from './identity.js'
export { formConditionSchema, formRuleEvidenceSchema, checkFormConditions, FormConditionError } from './conditions.js'
export type { FormCondition, FormConditionIssue } from './conditions.js'
export { formChoiceGroupSchema, checkFormChoiceGroups, FormChoiceError } from './choice-groups.js'
export type { FormChoiceGroup, FormChoiceIssue } from './choice-groups.js'
export type { FormFieldIdentity, FormFieldTarget } from './identity.js'
export { createFormInspectionRegistry, FormInspectionReferenceError, formControlReferenceSchema,
  modelFormInspectionFields } from './inspection-references.js'
export type { FormInspectionRegistry, FormInspectionIdentity, FormControlReference,
  FormInspectionTarget } from './inspection-references.js'
export { formValueType, validateFormChanges, projectedFormValue, FormValidationError } from './validation.js'
export type { FormValueType, FormValidationIssue } from './validation.js'
import { formValueType, type FormValueType } from './validation.js'

export type FormControlMarker = {
  label: string
  fieldId: string
  rectPdf: PdfRect
  /** Top-left image pixels, not PDF coordinates. */
  rectImage: PdfRect
  /** Small ID glyph bounds inside rectImage, in the same image coordinates. */
  labelRect: PdfRect
  option?: string
}

export type FormPageInspection = {
  page: number
  width: number
  height: number
  /** Full page bounds; inspection adds no margins. */
  pageRect: PdfRect
  fields: Array<{
    fieldId: string
    name: string
    type: PdfFormField['type']
    valueType: FormValueType
    required: boolean
    options?: string[]
    maxLength?: number
    multiline?: boolean
    multiple?: boolean
    value?: PdfFormField['value']
    controls: FormControlMarker[]
  }>
}

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: 'pdf/form-inspection-unavailable' })
}

/** One mapping owns both the numbered raster and the model's exact field IDs. */
export function inspectFormPage(document: PdfDocumentInfo, page: number, maxEdge = 2048,
  includeValues = false): FormPageInspection {
  const geometry = document.pages[page - 1]
  if (!Number.isSafeInteger(page) || !geometry) fail('Page is outside this PDF')
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 256 || maxEdge > 2048) fail('Invalid form inspection raster size: use 256–2048')
  const viewport = new NativeViewport(geometry, 1)
  if (![viewport.width, viewport.height].every(Number.isFinite) || !(viewport.width > 0 && viewport.height > 0)) fail('Invalid PDF page geometry')
  const identities = new Set<string>()
  const result: FormPageInspection = { page, width: 0, height: 0, pageRect: [0, 0, 0, 0], fields: [] }
  let count = 0
  for (const field of document.formFields ?? []) {
    const fieldId = formFieldId(field)
    if (identities.has(fieldId)) fail('Duplicate form field IDs prevent safe inspection')
    identities.add(fieldId)
    if (document.readOnly || field.readOnly || field.type === 'unsupported') continue
    const controls: FormControlMarker[] = []
    for (const widget of field.widgets.filter(item => item.page === page)) {
      if (!widget.rect.every(Number.isFinite)) fail('Invalid form widget geometry')
      const points = viewport.convertToViewportRectangle(widget.rect)
      const rectImage: PdfRect = [Math.max(0, Math.min(points[0], points[2])), Math.max(0, Math.min(points[1], points[3])),
        Math.min(viewport.width, Math.max(points[0], points[2])), Math.min(viewport.height, Math.max(points[1], points[3]))]
      if (rectImage[2] <= rectImage[0] || rectImage[3] <= rectImage[1]) continue
      if (++count > 100) fail('More than 100 visible editable controls on this page; inspection is not truncated')
      const label = `F${String(count).padStart(2, '0')}`
      controls.push({ label, fieldId, rectPdf: [...widget.rect], rectImage,
        labelRect: [0, 0, 0, 0],
        ...(widget.option !== undefined ? { option: widget.option } : {}) })
    }
    if (!controls.length) continue
    if (fieldId.length > 2048 || field.name.length > 2048 || (field.options?.length ?? 0) > 1000
      || field.options?.some(option => option.length > 2048)) fail('Field metadata exceeds the model tool limits')
    result.fields.push({ fieldId, name: field.name, type: field.type, valueType: formValueType(field), required: field.required, controls,
      ...(field.options ? { options: [...field.options] } : {}),
      ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
      ...(field.multiline !== undefined ? { multiline: field.multiline } : {}),
      ...(field.multiple !== undefined ? { multiple: field.multiple } : {}),
      ...(includeValues ? { value: Array.isArray(field.value) ? [...field.value] : field.value } : {}) })
  }
  Object.assign(result, layoutFormInspection(viewport, result.fields.flatMap(field => field.controls), maxEdge))
  if (JSON.stringify(result).length > 64_000) fail('Form metadata exceeds the model tool budget; no partial mapping was returned')
  return result
}
