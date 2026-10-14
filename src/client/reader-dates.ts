import { parseDate } from 'pdf-lib'

const localDateTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})
const listDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

function annotationDate(value: string): Date | undefined {
  const date = value.startsWith('D:') ? parseDate(value) : new Date(value)
  return date && Number.isFinite(date.getTime()) ? date : undefined
}

/** PDF dates use D:YYYYMMDDHHmmSS with a UTC/offset suffix, not ISO syntax. */
export function formatAnnotationDate(value: string): string {
  const date = annotationDate(value)
  return date ? localDateTime.format(date) : '—'
}

export function formatAnnotationListDate(value: string): string | undefined {
  const date = annotationDate(value)
  return date ? listDate.format(date) : undefined
}
