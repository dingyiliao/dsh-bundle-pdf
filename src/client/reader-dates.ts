import { PDFDateString } from 'pdfjs-dist'

const localDateTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

/** PDF dates use D:YYYYMMDDHHmmSS with a UTC/offset suffix, not ISO syntax. */
export function formatAnnotationDate(value: string): string {
  const date = value.startsWith('D:') ? PDFDateString.toDateObject(value) : new Date(value)
  return date && Number.isFinite(date.getTime()) ? localDateTime.format(date) : '—'
}
