import { TranslationError } from '../../../translation/index.js'

export interface TranslationSelectionIdentity {
  owner: number
  documentId: string
  contentVersion: string
}

/** Reject a captured selection after another reader or document takes over. */
export function currentTranslationSelection<T extends TranslationSelectionIdentity>(
  source: T | null | undefined,
  owner: number,
  document: { id: string; contentVersion: string } | null | undefined,
): T {
  if (!source || source.owner !== owner || document?.id !== source.documentId
      || document.contentVersion !== source.contentVersion) {
    throw new TranslationError('stale-result', 'The PDF selection is no longer current.')
  }
  return source
}
