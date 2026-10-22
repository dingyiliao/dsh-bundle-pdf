import type { PdfDocumentInfo, PdfFormField, PdfRect } from '../../core/pdf-types.js'
import { NativeViewport } from '../../shared/geometry/native-viewport.js'
import { formFieldId } from './identity.js'
export { formFieldId, resolveFormField } from './identity.js'
export type { FormFieldIdentity, FormFieldTarget } from './identity.js'

export type FormControlMarker = {
  label: string
  fieldId: string
  rectPdf: PdfRect
  /** Top-left image pixels, not PDF coordinates. */
  rectImage: PdfRect
  labelRect: PdfRect
  option?: string
}

export type FormPageInspection = {
  page: number
  width: number
  height: number
  fields: Array<{
    fieldId: string
    name: string
    type: PdfFormField['type']
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
export function inspectFormPage(document: PdfDocumentInfo, page: number, width: number, height: number,
  includeValues = false): FormPageInspection {
  const geometry = document.pages[page - 1]
  if (!Number.isSafeInteger(page) || !geometry) fail('Page is outside this PDF')
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 1024 || height > 1024) fail('Invalid form inspection raster size')
  const viewport = new NativeViewport(geometry, 1)
  if (!(viewport.width > 0 && viewport.height > 0)) fail('Invalid PDF page geometry')
  const identities = new Set<string>()
  const result: FormPageInspection = { page, width, height, fields: [] }
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
      const rectImage: PdfRect = [Math.max(0, Math.min(points[0], points[2]) * width / viewport.width),
        Math.max(0, Math.min(points[1], points[3]) * height / viewport.height),
        Math.min(width, Math.max(points[0], points[2]) * width / viewport.width),
        Math.min(height, Math.max(points[1], points[3]) * height / viewport.height)]
      if (rectImage[2] <= rectImage[0] || rectImage[3] <= rectImage[1]) continue
      if (++count > 100) fail('More than 100 visible editable controls on this page; inspection is not truncated')
      const label = `F${String(count).padStart(2, '0')}`
      const labelWidth = label.length * 12 + 8, labelHeight = 20
      if (width < labelWidth || height < labelHeight) fail('The page is too narrow to label controls reliably')
      const left = Math.min(Math.max(0, rectImage[0]), Math.max(0, width - labelWidth))
      const top = rectImage[1] >= labelHeight + 2 ? rectImage[1] - labelHeight - 2
        : Math.min(rectImage[3] + 2, Math.max(0, height - labelHeight))
      controls.push({ label, fieldId, rectPdf: [...widget.rect], rectImage,
        labelRect: [left, top, left + labelWidth, top + labelHeight],
        ...(widget.option !== undefined ? { option: widget.option } : {}) })
    }
    if (!controls.length) continue
    if (fieldId.length > 2048 || field.name.length > 2048 || (field.options?.length ?? 0) > 1000
      || field.options?.some(option => option.length > 2048)) fail('Field metadata exceeds the model tool limits')
    result.fields.push({ fieldId, name: field.name, type: field.type, required: field.required, controls,
      ...(field.options ? { options: [...field.options] } : {}),
      ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
      ...(field.multiline !== undefined ? { multiline: field.multiline } : {}),
      ...(field.multiple !== undefined ? { multiple: field.multiple } : {}),
      ...(includeValues ? { value: Array.isArray(field.value) ? [...field.value] : field.value } : {}) })
  }
  if (JSON.stringify(result).length > 64_000) fail('Form metadata exceeds the model tool budget; no partial mapping was returned')
  return result
}
