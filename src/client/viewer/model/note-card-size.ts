/** Note-card dimensions are local reader presentation state, not the PDF note's marker rectangle. */
export interface NoteCardSize { width: number; height: number }
export const MIN_NOTE_CARD_WIDTH = 220
export const MIN_NOTE_CARD_HEIGHT = 200

export function noteCardSizeStorageKey(identity: string): string {
  return `dsh-pdf:note-card-size:v1:${identity}`
}

export function parseNoteCardSize(stored: string | null): NoteCardSize | null {
  if (!stored) return null
  try {
    const value: unknown = JSON.parse(stored)
    if (!value || typeof value !== 'object') return null
    const { width, height } = value as Record<string, unknown>
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)
      || width < MIN_NOTE_CARD_WIDTH || height < MIN_NOTE_CARD_HEIGHT || width > 10000 || height > 10000) return null
    return { width, height }
  } catch { return null }
}

export function readNoteCardSize(identity?: string): NoteCardSize | null {
  if (!identity) return null
  try { return parseNoteCardSize(localStorage.getItem(noteCardSizeStorageKey(identity))) }
  catch { return null }
}

export function saveNoteCardSize(identity: string, size: NoteCardSize): void {
  try { localStorage.setItem(noteCardSizeStorageKey(identity), JSON.stringify(size)) }
  catch { /* Private-mode storage may be unavailable. */ }
}
