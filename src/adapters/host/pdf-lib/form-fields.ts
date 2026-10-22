import {
  PDFCheckBox, PDFDict, PDFDocument, PDFDropdown, PDFHexString, PDFOptionList, PDFRadioGroup, PDFTextField, StandardFonts,
  type PDFField,
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { PdfFormField, PdfFormWidget, PdfRect } from '../../../core/pdf-types.js'
import { PdfDocumentError } from '../../../core/pdf-types.js'
import { resolveFormField, type FormFieldTarget } from '../../../modules/forms/index.js'

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
  for (const change of changes) {
    const { field, name } = resolveFormField(fields, change), { value } = change
    if (field.isReadOnly()) throw new PdfDocumentError('read-only', `Form field is read only: ${name}`)
    if (field instanceof PDFTextField && typeof value === 'string') {
      const maxLength = field.getMaxLength()
      if (maxLength !== undefined && [...value].length > maxLength) {
        throw new PdfDocumentError('invalid-operation', `Form field exceeds its maximum length: ${name}`)
      }
      field.setText(value)
      // pdf-lib removes /V for the empty string. If the field has /DV, readers
      // can then resurrect that default after reopening instead of preserving
      // the user's explicit clear. Keep an explicit empty /V in the field tree.
      if (value === '') field.acroField.setValue(PDFHexString.fromText(''))
    } else if (field instanceof PDFCheckBox && typeof value === 'boolean') {
      if (value) field.check(); else field.uncheck()
    } else if (field instanceof PDFRadioGroup && typeof value === 'string') {
      if (!field.getOptions().includes(value)) throw new PdfDocumentError('invalid-operation', `Invalid radio option: ${name}`)
      field.select(value)
    } else if (field instanceof PDFDropdown && typeof value === 'string') {
      if (!field.getOptions().includes(value)) throw new PdfDocumentError('invalid-operation', `Invalid dropdown option: ${name}`)
      field.select(value)
    } else if (field instanceof PDFOptionList && Array.isArray(value) && value.every(item => typeof item === 'string')) {
      if (!field.isMultiselect() && value.length > 1) throw new PdfDocumentError('invalid-operation', `List does not allow multiple selections: ${name}`)
      if (value.some(item => !field.getOptions().includes(item))) {
        throw new PdfDocumentError('invalid-operation', `Invalid list option: ${name}`)
      }
      field.select(value)
    } else throw new PdfDocumentError('invalid-operation', `Unsupported value or form field type: ${name}`)
  }
  // fontkit's CFF subsetter can throw an out-of-bounds RangeError when asked
  // to subset the bundled OpenType CJK font with no glyphs (for example, a
  // clear-only edit or checkbox-only change). A standard font is sufficient
  // for empty appearances; embed the CJK font only when a non-empty value is
  // being painted.
  const hasText = changes.some(({ value }) => typeof value === 'string' ? value.length > 0
    : Array.isArray(value) && value.some(item => item.length > 0))
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
    const base = { id: fieldIdentity(field), name: field.getName(), widgets, readOnly: documentReadOnly || field.isReadOnly(),
      required: field.isRequired() }
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
