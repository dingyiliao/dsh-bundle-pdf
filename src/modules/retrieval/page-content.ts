import { pageContentDigest, type PageContent } from '../document/index.js'
import type { RetrievalPage, RetrievalPageUnit } from './types.js'

/** Indexing is a projection of representations, not a second editable document. */
export function projectPageContent(content: PageContent): RetrievalPage {
  const units: RetrievalPageUnit[] = content.blocks.flatMap(block => block.representations.filter(rep => rep.text.trim()).map(rep => ({
    id: rep.id, blockId: block.id, kind: rep.kind, text: rep.text, digest: rep.digest,
    ...(rep.kind === 'native-text' && block.nativeRange ? { nativeRange: block.nativeRange,
      paragraphBreaks: content.nativeText.paragraphBreaks.filter(offset => offset > block.nativeRange!.startUtf16
        && offset < block.nativeRange!.endUtf16).map(offset => offset - block.nativeRange!.startUtf16) } : {}),
    ...(block.rectPdf ? { rectPdf: block.rectPdf } : {}), ...(rep.spans ? { spans: rep.spans } : {}),
    producer: rep.producer, ...(rep.inputDigest ? { inputDigest: rep.inputDigest } : {}),
  })))
  return { text: content.nativeText.text, source: 'pdf-text', paragraphBreaks: content.nativeText.paragraphBreaks, units,
    ...(content.failure ? { failure: content.failure } : {}),
    contentIdentity: pageContentDigest(JSON.stringify(units.map(unit => [unit.id, unit.digest]))),
    warnings: [...content.warnings, ...content.blocks.flatMap(block => block.representations.flatMap(rep => rep.warnings))]
      .filter((value, index, all) => all.indexOf(value) === index).slice(0, 20) }
}
