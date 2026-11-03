import { createHash } from 'node:crypto'
import { appendPageRepresentation, NATIVE_PAGE_CONTENT_EXTRACTION_VERSION, pageContentBlockId,
  parsePageContent, type PageContent } from '../../../modules/document/index.js'
import type { RetrievalCache } from '../../../modules/retrieval/index.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const pageContentAggregateKey = (pipeline: string, path: string, digest: string, page: number, extraction: string) =>
  `pagecontent_${hash([pipeline, path, digest, page, extraction])}`
interface LegacyContentTarget {
  pipeline: string
  path: string
  sourceDigest: string
  indexContentDigest: string
  pageRects: readonly (readonly number[])[]
  extractionIdentity: string
  indexIdentity: string
  scan: boolean
  describe: boolean
  ocr: { id: string; fingerprint?: string; reusable?: boolean; explicitModel: boolean }
  image: { id: string; fingerprint?: string; reusable?: boolean; explicitModel: boolean }
}

/** Recover the default pre-stable-identity engines without guessing another
 * file's ownership or changing a private third-party backend's sharing policy. */
export async function adoptLegacyPageContents(cache: RetrievalCache, target: LegacyContentTarget,
  check: () => void): Promise<void> {
  if (!cache.scan) return
  const marker = `pagecontent_adopted_${hash([target.path, target.indexContentDigest, target.indexIdentity])}`
  const done = await cache.get(marker); check()
  if (done && typeof done === 'object' && 'version' in done && done.version === 1) return
  const accepted = new Set<number>()
  // Aggregate keys begin with a hex digest; skip native/OCR/image layer records
  // before reading payloads. Sixteen disjoint ranges keep migration streaming.
  for (const digit of '0123456789abcdef') {
    let cursor: string | undefined
    do {
      const batch = await cache.scan(`pagecontent_${digit}`, cursor, 16); check()
      for (const [key, value] of batch.entries) {
        check()
        const page = parsePageContent(value)
        if (!page || page.indexContentDigest !== undefined || page.failure || accepted.has(page.page) || page.blocks.length !== 2
          || page.sourceDigest !== target.sourceDigest || page.page > target.pageRects.length
          || JSON.stringify(page.pageRect) !== JSON.stringify(target.pageRects[page.page - 1])
          || key !== pageContentAggregateKey(target.pipeline, target.path, target.sourceDigest, page.page, page.extractionIdentity)) continue
        const native = page.blocks.flatMap(block => block.representations).filter(rep => rep.kind === 'native-text')
        if (!native.length || native.some(rep => rep.producer.id !== 'pdf-native'
          || rep.producer.version !== NATIVE_PAGE_CONTENT_EXTRACTION_VERSION)) continue
        const neededOcr = target.scan && (!page.nativeText.text.trim() || native.some(rep => rep.status === 'partial'))
        const eligible = (kind: 'ocr' | 'image') => {
          const selected = target[kind]
          return page.blocks.flatMap(block => block.representations).filter(rep => rep.kind === (kind === 'ocr' ? 'ocr-text' : 'image-description')
            && rep.status === 'complete' && rep.producer.id === selected.id
            && (typeof selected.fingerprint === 'string' && !!selected.fingerprint
                && rep.producer.configurationIdentity === selected.fingerprint
              || selected.reusable && !selected.explicitModel
                && selected.id === (kind === 'ocr' ? 'session-llm' : 'dsh-vision')))
        }
        const ocr = neededOcr ? eligible('ocr') : [], image = target.describe ? eligible('image') : []
        if (neededOcr && !ocr.length || target.describe && !image.length) continue
        const identity = { ...page, indexContentDigest: target.indexContentDigest,
          extractionIdentity: NATIVE_PAGE_CONTENT_EXTRACTION_VERSION }
        let adopted: PageContent = { ...identity, extractionIdentity: target.extractionIdentity,
          blocks: page.blocks.map(block => ({ ...block,
            id: pageContentBlockId(identity, block.kind === 'visual-region' ? 'full-page-visual' : 'native-text'),
            representations: block.representations.filter(rep => rep.kind === 'native-text'),
          })) }
        const text = adopted.blocks.find(block => block.kind === 'text'), visual = adopted.blocks.find(block => block.kind === 'visual-region')
        if (!text || !visual) continue
        for (const representation of ocr) adopted = appendPageRepresentation(adopted,
          page.nativeText.text.trim() ? text.id : visual.id, representation)
        for (const representation of image) adopted = appendPageRepresentation(adopted, visual.id, representation)
        check()
        await cache.set(pageContentAggregateKey(target.pipeline, target.path, target.indexContentDigest, page.page, target.indexIdentity), adopted)
        check(); accepted.add(page.page)
      }
      if (batch.nextKey !== undefined && (!batch.nextKey.startsWith(`pagecontent_${digit}`)
        || cursor !== undefined && batch.nextKey <= cursor)) throw new Error('PDF content migration cursor did not advance')
      cursor = batch.nextKey
    } while (cursor !== undefined)
  }
  check(); await cache.set(marker, { version: 1 }); check()
}
