const localDateTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})
const listDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

function annotationDate(value: string): Date | undefined {
  if (!value.startsWith('D:')) {
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date : undefined
  }
  const parts = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([+\-Z])?(\d{2})?'?(\d{2})?'?$/.exec(value)
  if (!parts) return undefined
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00',
    sign = 'Z', offsetHour = '00', offsetMinute = '00'] = parts
  const offset = sign === 'Z' ? sign : `${sign}${offsetHour}:${offsetMinute}`
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`)
  return Number.isFinite(date.getTime()) ? date : undefined
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
