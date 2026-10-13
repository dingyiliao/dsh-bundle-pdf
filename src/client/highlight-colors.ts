/** A small, user-editable set of highlight colors shared by PDF reader tabs. */
export const MAX_HIGHLIGHT_QUICK_COLORS = 5
export const HIGHLIGHT_QUICK_COLORS_KEY = 'dsh-pdf:highlight-quick-colors:v1'
export const DEFAULT_HIGHLIGHT_QUICK_COLORS = [
  '#ffff00', // yellow
  '#ff9f0a', // orange
  '#75d86a', // green
  '#80bfff', // blue
  '#d1a2ff', // purple
] as const

const hexColor = /^#[0-9a-f]{6}$/i

export function normalizeHighlightColor(value: string): string | null {
  return hexColor.test(value) ? value.toLowerCase() : null
}

/** Invalid or obsolete stored data must not prevent the reader from opening. */
export function parseHighlightQuickColors(stored: string | null): string[] {
  if (stored === null) return [...DEFAULT_HIGHLIGHT_QUICK_COLORS]
  try {
    const value: unknown = JSON.parse(stored)
    if (!Array.isArray(value) || value.length > MAX_HIGHLIGHT_QUICK_COLORS) throw new Error('Invalid quick colors')
    const colors = value.map((entry) => typeof entry === 'string' ? normalizeHighlightColor(entry) : null)
    if (colors.some((entry) => entry === null) || new Set(colors).size !== colors.length) throw new Error('Invalid quick colors')
    return colors as string[]
  } catch {
    return [...DEFAULT_HIGHLIGHT_QUICK_COLORS]
  }
}

export function readHighlightQuickColors(): string[] {
  try {
    return parseHighlightQuickColors(localStorage.getItem(HIGHLIGHT_QUICK_COLORS_KEY))
  } catch {
    return [...DEFAULT_HIGHLIGHT_QUICK_COLORS]
  }
}

export function addHighlightQuickColor(colors: readonly string[], value: string): string[] | null {
  const color = normalizeHighlightColor(value)
  if (!color || colors.length >= MAX_HIGHLIGHT_QUICK_COLORS || colors.includes(color)) return null
  return [...colors, color]
}

export function editHighlightQuickColor(colors: readonly string[], index: number, value: string): string[] | null {
  const color = normalizeHighlightColor(value)
  if (!color || !Number.isInteger(index) || index < 0 || index >= colors.length) return null
  if (colors.some((existing, position) => position !== index && existing === color)) return null
  return colors.map((existing, position) => position === index ? color : existing)
}

export function removeHighlightQuickColor(colors: readonly string[], index: number): string[] {
  return colors.filter((_, position) => position !== index)
}
