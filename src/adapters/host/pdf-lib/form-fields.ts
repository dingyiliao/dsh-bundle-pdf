import {
  PDFCheckBox, PDFDict, PDFDocument, PDFDropdown, PDFHexString, PDFName, PDFOptionList, PDFRadioGroup, PDFString, PDFTextField, StandardFonts,
  type PDFField,
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { PdfFormField, PdfFormWidget, PdfRect } from '../../../core/pdf-types.js'
import { resolveFormField, validateFormChanges, FormValidationError, type FormFieldTarget } from '../../../modules/forms/index.js'

export type PdfFormChange = FormFieldTarget & { value: string | boolean | string[] }

function fieldIdentity(field: PDFField): string {
  return `pdf-field:${field.ref.objectNumber}:${field.ref.generationNumber}`
}

function canonicalFields(document: PDFDocument): PDFField[] {
  return [...new Map(document.getForm().getFields().map(field => [fieldIdentity(field), field])).values()]
}

/** Apply a validated field change to the canonical field tree and its appearance. */
export async function applyFormChanges(document: PDFDocument, changes: readonly PdfFormChange[], fontBytes: Uint8Array): Promise<void> {
  if (!changes.length) return
  const form = document.getForm()
  const fields = canonicalFields(document).map(field => ({ id: fieldIdentity(field), name: field.getName(), field }))
  // History can touch one field repeatedly. Validate every value before any
  // canonical mutation, using the same rules as the Reader and model tools.
  const issues = validateFormChanges(inspectFormFields(document), changes, { allowRepeated: true })
  if (issues.length) throw new FormValidationError(issues)
  for (const change of changes) {
    const { field } = resolveFormField(fields, change), { value } = change
    if (field instanceof PDFTextField && typeof value === 'string') {
      field.setText(value)
      // pdf-lib removes /V for the empty string. If the field has /DV, readers
      // can then resurrect that default after reopening instead of preserving
      // the user's explicit clear. Keep an explicit empty /V in the field tree.
      if (value === '') field.acroField.setValue(PDFHexString.fromText(''))
    } else if (field instanceof PDFCheckBox && typeof value === 'boolean') {
      if (value) field.check(); else field.uncheck()
    } else if (field instanceof PDFRadioGroup && typeof value === 'string') {
      if (value === '') field.clear(); else field.select(value)
    } else if (field instanceof PDFDropdown && typeof value === 'string') {
      if (value === '') {
        field.clear()
        // As for text, an explicit empty /V must not fall back to an inherited/default value.
        field.acroField.dict.set(PDFName.of('V'), document.context.obj([]))
      } else field.select(value)
    } else if (field instanceof PDFOptionList && Array.isArray(value) && value.every(item => typeof item === 'string')) {
      field.select(value)
      if (!value.length) field.acroField.dict.set(PDFName.of('V'), document.context.obj([]))
    }
  }
  // Font choice belongs to the final appearance, not the edit history. Radio
  // export values are not painted text; option lists paint ALL options even
  // when cleared. An unused CJK font triggers fontkit's fatal empty-CFF bug.
  const hasText = fields.some(({ field }) => {
    if (!field.acroField.getWidgets().length || !field.needsAppearancesUpdate()) return false
    const text = field instanceof PDFTextField ? field.getText() ?? ''
      : field instanceof PDFDropdown ? field.getSelected()[0] ?? ''
        : field instanceof PDFOptionList ? field.getOptions().join('\n') : ''
    // Layout removes these controls or splits them into empty lines; retain
    // ordinary/Unicode spaces because they can still require font encoding.
    return /[^\b\n\f\r\v]/u.test(text)
  })
  const font = hasText
    ? (document.registerFontkit(fontkit), await document.embedFont(fontBytes, { subset: true }))
    : await document.embedFont(StandardFonts.Helvetica)
  form.updateFieldAppearances(font)
}

/** Resolve canonical fields to page widgets without modifying the source PDF. */
export function inspectFormFields(document: PDFDocument, documentReadOnly = false): PdfFormField[] {
  const pageByWidget = new Map<PDFDict, number>()
  document.getPages().forEach((page, index) => {
    const annotations = page.node.Annots()
    if (!annotations) return
    for (let position = 0; position < annotations.size(); position++) {
      const dictionary = document.context.lookup(annotations.get(position))
      if (dictionary instanceof PDFDict) pageByWidget.set(dictionary, index + 1)
    }
  })
  return canonicalFields(document).map(field => {
    const widgets: PdfFormWidget[] = field.acroField.getWidgets().flatMap((widget, index) => {
      // Hidden / NoView controls cannot be matched to a visible printed label.
      if (widget.getFlags() & (2 | 32)) return []
      const page = pageByWidget.get(widget.dict)
      if (!page) return []
      const { x, y, width, height } = widget.getRectangle()
      const rect: PdfRect = [x, y, x + width, y + height]
      if (!rect.every(Number.isFinite) || width <= 0 || height <= 0) return []
      return [{ page, rect, ...(field instanceof PDFRadioGroup ? { option: field.getOptions()[index] } : {}) }]
    })
    const hint = document.context.lookup(field.acroField.getInheritableAttribute(PDFName.of('TU')))
    const description = hint instanceof PDFString || hint instanceof PDFHexString ? hint.decodeText().slice(0, 256) : undefined
    const base = { id: fieldIdentity(field), name: field.getName(), widgets, readOnly: documentReadOnly || field.isReadOnly(),
      required: field.isRequired(), ...(description ? { description } : {}) }
    if (field instanceof PDFTextField) return { ...base, type: 'text', value: field.getText() ?? '',
      maxLength: field.getMaxLength(), multiline: field.isMultiline() } satisfies PdfFormField
    if (field instanceof PDFCheckBox) return { ...base, type: 'checkbox', value: field.isChecked() } satisfies PdfFormField
    if (field instanceof PDFRadioGroup) return { ...base, type: 'radio', value: field.getSelected() ?? '',
      options: field.getOptions() } satisfies PdfFormField
    if (field instanceof PDFDropdown) return { ...base, type: 'dropdown', value: field.getSelected(),
      options: field.getOptions() } satisfies PdfFormField
    if (field instanceof PDFOptionList) return { ...base, type: 'option-list', value: field.getSelected(),
      options: field.getOptions(), multiple: field.isMultiselect() } satisfies PdfFormField
    return { ...base, type: 'unsupported', value: '', readOnly: true } satisfies PdfFormField
  })
}
