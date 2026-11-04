import type { PdfImageEvidence, PdfTextEvidence, SavedTextRangeReference } from './reference-store.js'

export interface EvidenceCapabilities {
  source: 'native-text' | 'local-ocr' | 'mixed-text' | PdfImageEvidence['source']
  /** Exact refers to the PDF text layer; derived text is only a transcription/snapshot. */
  textMatching: 'exact' | 'derived' | 'none'
  navigation: 'page' | 'range'
  /** Eligibility only: current source, text and native glyph geometry still require Host validation. */
  exactAnnotate: boolean
  reason: string
}

type Evidence = PdfTextEvidence | PdfImageEvidence | SavedTextRangeReference['evidence']

/** Presentation of Host-owned provenance, never an authorization supplied by a caller.
 * Keep capabilities out of persisted records so old references retain their strict wire shape.
 */
export function describeEvidenceCapabilities(evidence: Evidence): EvidenceCapabilities {
  if (evidence.source === 'pdf-text-range') {
    const sources = new Set(evidence.pages.map(page => describeEvidenceCapabilities(page.evidence).source))
    if (sources.size === 1 && sources.has('native-text')) return nativeText(evidence.pages.some(page =>
      (page.evidence.quality?.unmappedCharacters ?? 0) > 0))
    return { source: sources.size === 1 && sources.has('local-ocr') ? 'local-ocr' : 'mixed-text',
      textMatching: 'derived', navigation: 'page', exactAnnotate: false,
      reason: 'This range includes derived OCR text. Its snapshot can be narrowed, but navigation identifies only a verified source page and cannot certify native text markup.' }
  }
  if (evidence.source === 'pdf-text') {
    if (!evidence.extraction) return nativeText((evidence.quality?.unmappedCharacters ?? 0) > 0)
    return { source: 'local-ocr', textMatching: 'derived', navigation: 'page', exactAnnotate: false,
      reason: 'Local OCR is a derived transcription. Quotes can narrow its snapshot; only the verified source page is navigable, and OCR coordinates cannot authorize native text markup.' }
  }
  return { source: evidence.source, textMatching: evidence.source === 'direct-image' ? 'none' : 'derived',
    navigation: 'page', exactAnnotate: false,
    reason: evidence.source === 'direct-image'
      ? 'Image evidence identifies a verified source page and contains no attested native text range.'
      : 'Image-derived text identifies a verified source page; its wording and coordinates cannot certify native text markup.' }
}

function nativeText(hasUnmappedCharacters = false): EvidenceCapabilities {
  return { source: 'native-text', textMatching: 'exact', navigation: 'range', exactAnnotate: !hasUnmappedCharacters,
    reason: hasUnmappedCharacters
      ? 'Native page text contains unmapped characters, so this reference is not currently eligible for exact annotation. Exact stored-text matching and narrowing remain available; Host must recheck the selected range\'s source, text and native glyph geometry before precise navigation or markup. Page-level decoding issues do not establish whether a selected subrange has valid geometry.'
      : 'Native text supports scoped quote matching; exact navigation and markup require current source, complete page text and native glyph geometry to be verified by Host.' }
}
