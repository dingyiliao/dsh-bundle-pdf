import { explanationPages, type ExplanationExcerpt } from './model.js'
import { encodeExplanationImageBytes } from './image.js'
import { defaultExplanationPromptTemplate, explanationTemplateIssue,
  MAX_EXPLANATION_INSTRUCTION_LENGTH } from '../../shared/explanation-template.js'

export interface ExplanationGuidance {
  general?: string
  text?: string
  image?: string
}

export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png'; data: string }

export interface ExplanationImageReferenceRequest {
  sessionId: string
  documentId: string
  refId: string
  question: string
}

/** Host-verified reference preparation; pixels never originate in Client state. */
export type ExplanationImageReferencePreparation =
  | { kind: 'direct-image'; backendId: string;
    provenance: { backendId: string; mode: 'session-vision' };
    evidence: { refId: string; documentId: string };
    image: { mediaType: 'image/png'; data: Uint8Array; width: number; height: number } }
  | { kind: 'derived-text'; backendId: string; text: string;
    provenance: { backendId: string; mode: 'image-description'; model?: string };
    limitations?: string; evidence: { refId: string; documentId: string } }

export interface MixedExplanationPromptOptions {
  sessionId: string
  documentId: string
  /** {{items}} is inserted as ordered text/image parts, never flattened into a string. */
  template?: string
  /** Plain-language guidance; blank fields use the built-in prompt behavior. */
  guidance?: ExplanationGuidance
  prepareReference: (request: ExplanationImageReferenceRequest,
    signal?: AbortSignal) => Promise<ExplanationImageReferencePreparation>
  signal?: AbortSignal
}

const lineBreak = /\r\n|[\r\n\u2028\u2029]/g

function quoteSource(text: string): string {
  return `│ ${text.replace(lineBreak, '\n│ ')}`
}

/**
 * Build one user turn in excerpt order. Image routing is decided by the Host:
 * direct images reach only a visual Session using Host-verified bytes, while a
 * derived result is clearly identified as untrusted model-derived text,
 * never as seen pixels.
 */
export async function buildMixedExplanationPrompt(
  path: string, excerpts: readonly ExplanationExcerpt[], t: (key: string) => string,
  options: MixedExplanationPromptOptions,
): Promise<PromptContentPart[]> {
  options.signal?.throwIfAborted()
  if (!excerpts.length) throw new Error('Cannot explain an empty set of PDF excerpts')
  if (!options.sessionId.trim()) throw new Error('Cannot explain a PDF region without an active Session')
  const guidance = {
    general: options.guidance?.general?.trim() ?? '',
    text: options.guidance?.text?.trim() ?? '',
    image: options.guidance?.image?.trim() ?? '',
  }
  if (Object.values(guidance).some(value => value.length > MAX_EXPLANATION_INSTRUCTION_LENGTH)) {
    throw new Error('PDF explanation guidance is too long')
  }
  const hasGuidance = Object.values(guidance).some(Boolean)
  // A saved legacy layout remains effective until the user edits a split field.
  const template = hasGuidance ? defaultExplanationPromptTemplate
    : options.template ?? defaultExplanationPromptTemplate
  const issue = explanationTemplateIssue(template)
  if (issue) throw new Error(`Invalid PDF explanation prompt template: ${issue}`)
  const itemSlot = /{{\s*items\s*}}/.exec(template)!
  const values: Record<string, string> = {
    instruction: guidance.general || t('reader.explain.promptInstruction'),
    document: `${t('reader.explain.document')}: ${JSON.stringify(path)}`,
    count: String(excerpts.length),
  }
  const render = (fragment: string) => fragment.replace(/{{\s*(instruction|document|count)\s*}}/g,
    (_match, key: string) => values[key])
  const before = render(template.slice(0, itemSlot.index)).trim()
  const after = render(template.slice(itemSlot.index + itemSlot[0].length)).trim()

  // This source boundary stays outside the customizable template.
  const parts: PromptContentPart[] = [{ type: 'text', text: [before,
    t('reader.explain.promptSourceWarning')].filter(Boolean).join('\n\n') }]
  // DSH joins text parts verbatim, including those on either side of images.
  const appendSection = (lines: string[]) => {
    parts.push({ type: 'text', text: `\n\n${lines.filter(Boolean).join('\n')}` })
  }
  const evidenceLine = (refs: readonly string[]) => refs.length
    ? `${t('reader.explain.promptEvidence')}: ${refs.join(', ')}` : ''

  for (const [index, excerpt] of excerpts.entries()) {
    options.signal?.throwIfAborted()
    const question = excerpt.question.trim()
    if (!question) throw new Error('Cannot explain a PDF excerpt without a question')
    const pages = explanationPages(excerpt)
    const location = `${t(pages.length === 1 ? 'reader.explain.page' : 'reader.explain.pages')}: ${pages.join(', ')}`
      + (excerpt.kind === 'region' ? ` · ${t('reader.explain.region')}` : '')
    const questionLine = `${index + 1}. ${question.replace(lineBreak, '\n   ')}`

    if (excerpt.kind === 'text') {
      appendSection([questionLine, location, evidenceLine(excerpt.evidenceRefs ?? []), guidance.text,
        t('reader.explain.promptSourceText'), quoteSource(excerpt.text)])
      continue
    }

    const refId = excerpt.image.evidenceRefId
    if (!refId) throw new Error(t('reader.explain.imageReferenceMissing'))
    const prepared = await options.prepareReference({
      sessionId: options.sessionId, documentId: options.documentId, refId, question,
    }, options.signal)
    options.signal?.throwIfAborted()
    if (!prepared.evidence.refId || prepared.evidence.documentId !== options.documentId) {
      throw new Error('PDF image reference does not belong to this document')
    }
    const header = [questionLine, location, evidenceLine([prepared.evidence.refId]), guidance.image]

    if (prepared.kind === 'direct-image') {
      if (prepared.image.mediaType !== 'image/png') throw new Error('PDF image reference is not a PNG')
      const data = encodeExplanationImageBytes(prepared.image.data, options.signal)
      appendSection(header)
      parts.push({ type: 'image', mediaType: 'image/png', data })
      continue
    }

    const derived = prepared.text.trim()
    if (!derived) throw new Error('The image backend returned no usable text')
    const engine = [prepared.provenance.backendId, prepared.provenance.model]
      .filter(Boolean).map(value => JSON.stringify(value)).join(' / ')
    appendSection([...header, `${t('reader.explain.derivedSource')} (${engine})`,
      t('reader.explain.derivedImageWarning'), quoteSource(derived),
      prepared.limitations ? `${t('reader.explain.derivedLimitation')}\n${quoteSource(prepared.limitations)}` : ''])
  }

  if (after) appendSection([after])
  return parts
}
