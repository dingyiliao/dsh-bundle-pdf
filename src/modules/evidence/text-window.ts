function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'pdf/invalid-window' })
}

/** UTF-16 and UTF-8-bounded text window that never splits a surrogate pair. */
export function textWindow(text: string, offset: number, maxChars: number, maxAllowed: number): {
  text: string; offset: number; nextOffset: number | null; totalChars: number; truncated: boolean
} {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length
    || !Number.isSafeInteger(maxChars) || maxChars < 2 || maxChars > maxAllowed) {
    invalid('Invalid PDF text window')
  }
  const low = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff
  const high = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
  if (offset > 0 && offset < text.length && low(text.charCodeAt(offset)) && high(text.charCodeAt(offset - 1))) {
    invalid('Offset splits a Unicode character')
  }
  let end = offset, bytes = 0
  for (const character of text.slice(offset)) {
    const byteLength = Buffer.byteLength(character, 'utf8')
    if (end - offset + character.length > maxChars || bytes + byteLength > 16_000) break
    end += character.length
    bytes += byteLength
  }
  return { text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null,
    totalChars: text.length, truncated: end < text.length }
}

/** Legacy text-window contract; offsets are UTF-16 and each window is byte-bounded. */
export function windowPageText(text: string, offset = 0, maxChars = 6000) {
  return textWindow(text, offset, maxChars, 8000)
}
