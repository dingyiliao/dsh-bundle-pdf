import React from 'react'
import type { PdfFormField } from '../../../core/pdf-types.js'
import { formFieldId } from '../../forms/index.js'
import { pdfRectToViewport, type PageViewport } from '../model/reader-selection.js'

export interface FormWidgetsProps {
  page: number
  viewport: PageViewport
  fields: readonly PdfFormField[]
  onChange(fieldId: string, value: string | boolean | string[]): Promise<void>
}

/** Native PDF remains the source of appearance; these controls expose only editable AcroForm widgets. */
export function FormWidgets({ page, viewport, fields, onChange }: FormWidgetsProps) {
  return <div className="dsh-pdf-form-widgets" onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}>
    {fields.flatMap(field => field.readOnly ? [] : field.widgets.flatMap((widget, index) => {
      if (widget.page !== page || field.type === 'unsupported') return []
      const [left, top, right, bottom] = pdfRectToViewport(viewport, widget.rect)
      const style: React.CSSProperties = { left, top, width: right - left, height: bottom - top,
        fontSize: Math.max(10, Math.min(18, (bottom - top) * 0.63)) }
      const id = formFieldId(field), key = `${id}:${index}`
      const title = field.name
      if (field.type === 'text') {
        const value = typeof field.value === 'string' ? field.value : ''
        const common = { style, defaultValue: value, 'aria-label': title,
          maxLength: field.maxLength, required: field.required,
          onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            if (event.currentTarget.value !== value) void onChange(id, event.currentTarget.value)
          },
          onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            if (!field.multiline && event.key === 'Enter') event.currentTarget.blur()
          } }
        return [field.multiline
          ? <textarea key={`${key}:${value}`} {...common} className="dsh-pdf-form-control dsh-pdf-form-text" />
          : <input key={`${key}:${value}`} {...common} type="text" className="dsh-pdf-form-control dsh-pdf-form-text" />]
      }
      if (field.type === 'checkbox') return [<input key={key} type="checkbox" style={style}
        className="dsh-pdf-form-control dsh-pdf-form-check" aria-label={title}
        checked={field.value === true} onChange={event => { void onChange(id, event.currentTarget.checked) }} />]
      if (field.type === 'radio') return [<input key={key} type="radio" name={id} style={style}
        className="dsh-pdf-form-control dsh-pdf-form-check" aria-label={`${title}: ${widget.option ?? index + 1}`}
        checked={field.value === widget.option} onChange={() => {
          if (widget.option !== undefined) void onChange(id, widget.option)
        }} />]
      if (field.type === 'dropdown') return [<select key={key} style={style}
        className="dsh-pdf-form-control dsh-pdf-form-select" aria-label={title}
        value={Array.isArray(field.value) ? field.value[0] ?? '' : String(field.value)}
        onChange={event => { void onChange(id, event.currentTarget.value) }}>
        <option value="" disabled>{title}</option>
        {field.options?.map(option => <option key={option} value={option}>{option}</option>)}
      </select>]
      if (field.type === 'option-list') return [<select key={key} multiple={field.multiple !== false} style={style}
        className="dsh-pdf-form-control dsh-pdf-form-select" aria-label={title}
        value={field.multiple === false ? (Array.isArray(field.value) ? field.value[0] ?? '' : String(field.value))
          : Array.isArray(field.value) ? field.value : []}
        onChange={event => { void onChange(id, Array.from(event.currentTarget.selectedOptions, option => option.value)) }}>
        {field.options?.map(option => <option key={option} value={option}>{option}</option>)}
      </select>]
      return []
    }))}
  </div>
}
