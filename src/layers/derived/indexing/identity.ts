import type { RetrievalDocument, RetrievalEmbedding } from './types.js'

/** Stable validation and identity primitives shared by indexing and querying. */
export const isContentDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)

export const samePageDigests = (
  a: RetrievalDocument['indexPageDigests'],
  b: RetrievalDocument['indexPageDigests'],
): boolean => a === b || (!!a && !!b && a.length === b.length && a.every((value, index) => value === b[index]))

export const sameDocument = (a: RetrievalDocument, b: RetrievalDocument): boolean =>
  a.id === b.id && a.path === b.path && a.sourceDigest === b.sourceDigest &&
  a.contentVersion === b.contentVersion && a.pageCount === b.pageCount &&
  a.indexContentDigest === b.indexContentDigest && samePageDigests(a.indexPageDigests, b.indexPageDigests)

export const indexContentDigest = (document: RetrievalDocument): string =>
  document.indexContentDigest ?? document.sourceDigest

export const providerIdentity = (provider: RetrievalEmbedding | undefined): string => provider
  ? JSON.stringify([
    provider.fingerprint,
    provider.generation ?? '',
    provider.configurationIdentity ?? '',
    provider.dimensions,
    provider.maxBatchSize,
    provider.maxInputCharacters ?? null,
    ...(provider.documentFingerprint === undefined ? [] : [provider.documentFingerprint]),
  ])
  : 'none'

export const invalidDocumentIdentity = (provider: RetrievalEmbedding): boolean => {
  const value = provider.documentFingerprint
  if (value === undefined) return false
  return typeof value !== 'string' || !value || value.length > 512
}

