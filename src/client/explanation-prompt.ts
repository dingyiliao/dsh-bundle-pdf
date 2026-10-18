import { explanationPages, type ExplanationExcerpt, type PromptContentPart } from './explain-mode.js'
import type { ImageUnderstandingApi } from './image-understanding-api.js'

export interface MixedExplanationPromptOptions {
  sessionId: string
  prepare: ImageUnderstandingApi['prepare']
  encode: (image: Blob, signal?: AbortSignal) => Promise<string>
  signal?: AbortSignal
}

/**
 * Build one user turn in excerpt order. Image routing is decided by the Host:
 * direct images reach only a visual Session, while a derived result is clearly
 * identified as untrusted OCR/auxiliary-model text, never as seen pixels.
 */
export async function buildMixedExplanationPrompt(
  path: string, excerpts: readonly ExplanationExcerpt[], t: (key: string) => string,
  options: MixedExplanationPromptOptions,
): Promise<PromptContentPart[]> {
  options.signal?.throwIfAborted()
  if (!excerpts.length) throw new Error('Cannot explain an empty set of PDF excerpts')
  if (!options.sessionId.trim()) throw new Error('Cannot explain a PDF region without an active Session')

  const parts: PromptContentPart[] = [{ type: 'text', text: [
    t('reader.explain.promptInstruction'),
    `${t('reader.explain.document')}: ${JSON.stringify(path)}`,
    t('reader.explain.regionSourceWarning'),
  ].join('\n\n') }]

  for (const [index, excerpt] of excerpts.entries()) {
    options.signal?.throwIfAborted()
    const question = excerpt.question.trim()
    if (!question) throw new Error('Cannot explain a PDF excerpt without a question')
    const location = `${t(excerpt.kind === 'text' ? 'reader.explain.excerpt' : 'reader.explain.region')} ${index + 1}`
      + ` (${t('reader.explain.pages')}: ${explanationPages(excerpt).join(', ')})`
    const questionLine = `${t(excerpt.kind === 'text'
      ? 'reader.explain.itemPromptQuestion' : 'reader.explain.regionQuestion')}: ${JSON.stringify(question)}`

    if (excerpt.kind === 'text') {
      parts.push({ type: 'text', text: `${location}:\n${JSON.stringify(excerpt.text)}\n${questionLine}` })
      continue
    }

    const data = await options.encode(excerpt.image.blob, options.signal)
    options.signal?.throwIfAborted()
    if (!data) throw new Error('Cannot explain an empty PDF image region')
    const prepared = await options.prepare({
      sessionId: options.sessionId,
      image: { mediaType: excerpt.image.mediaType, data, width: excerpt.image.width, height: excerpt.image.height },
      question,
    }, options.signal)
    options.signal?.throwIfAborted()

    if (prepared.kind === 'direct-image') {
      parts.push({ type: 'text', text: `${location}:\n${questionLine}\n`
        + t('reader.explain.regionSourceWarning') })
      parts.push({ type: 'image', mediaType: excerpt.image.mediaType, data })
      continue
    }

    const derived = prepared.text.trim()
    if (!derived) throw new Error('The image backend returned no usable text')
    const source = t(prepared.provenance.mode === 'ocr-text'
      ? 'reader.explain.derivedOcrWarning' : 'reader.explain.derivedAuxWarning')
    parts.push({ type: 'text', text: `${location}:\n${questionLine}\n`
      + `${t('reader.explain.derivedSource')} (${JSON.stringify(prepared.provenance.backendId)}, ${prepared.provenance.mode}`
      + `${prepared.provenance.model ? `, model ${JSON.stringify(prepared.provenance.model)}` : ''}): ${source}\n`
      + `${prepared.limitations ? `${t('reader.explain.derivedLimitation')}: ${JSON.stringify(prepared.limitations)}\n` : ''}`
      + `${t('reader.explain.regionSourceWarning')} ${JSON.stringify(derived)}` })
  }

  return parts
}
