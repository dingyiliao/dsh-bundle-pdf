/** Page text is an optional asset; its precision follows the readable scale. */
export type TextFidelity = 'none' | 'run' | 'glyph'

/** Below this scale text is browse-only: no layer, no selection, no copy. */
export const TEXT_RUN_MIN_SCALE = 0.5
/** At and above this scale per-glyph selection is worth its layout cost. */
export const TEXT_GLYPH_MIN_SCALE = 0.9
/** Upper bound for pages that keep a DOM text layer at the same time. */
export const MAX_TEXT_PAGES = 3

export function textFidelityForScale(scale: number): TextFidelity {
  if (!(scale > 0) || !Number.isFinite(scale)) return 'none'
  if (scale >= TEXT_GLYPH_MIN_SCALE) return 'glyph'
  if (scale >= TEXT_RUN_MIN_SCALE) return 'run'
  return 'none'
}

export interface TextPageState {
  /** Page intersects the scrollport. */
  visible: boolean
  /** Page owns the reading probe (the page navigation would report). */
  current: boolean
  /** Page must keep its layer because a selection or navigation target lives there. */
  pinned: boolean
}

/**
 * Below the selection threshold text is browse-only. Above it, visible pages
 * use the scale-derived fidelity; current and pinned pages keep a layer even
 * when scrolled out. Pinning never changes fidelity, because replacing glyph
 * nodes would collapse the DOM Range the user is selecting.
 */
export function textFidelityForPage(scale: number, page: TextPageState): TextFidelity {
  const base = textFidelityForScale(scale)
  if (base === 'none') return 'none'
  if (page.pinned || page.current) return base
  return page.visible ? base : 'none'
}

export interface TextPageCandidate extends TextPageState {
  index: number
  scale: number
}

/**
 * Rank text candidates by how important their layer is, then cap the result.
 * The current page outranks plain visible pages; pinned pages outrank both.
 * Ties keep document order for stable DOM.
 */
export function selectTextPages(candidates: readonly TextPageCandidate[], limit = MAX_TEXT_PAGES): Map<number, TextFidelity> {
  const selected = new Map<number, TextFidelity>()
  const ranked = candidates.flatMap(candidate => {
    const fidelity = textFidelityForPage(candidate.scale, candidate)
    if (fidelity === 'none') return []
    const priority = candidate.pinned ? 3 : candidate.current ? 2 : 1
    return [{ index: candidate.index, fidelity, priority }]
  }).sort((a, b) => b.priority - a.priority || a.index - b.index)
  for (const page of ranked.slice(0, Math.max(0, limit))) selected.set(page.index, page.fidelity)
  return selected
}
