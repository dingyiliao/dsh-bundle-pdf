import type { WorkingCopyReadPort, HostWorkspaceSnapshot } from '../working-copy/index.js'
import type { AgentPageReadPort } from './agent-page-read.js'
import type { EvidenceReferenceStore } from './reference-store.js'
import { createTextReferenceResolver } from './text-target.js'
import { evidenceSha256 } from './provenance.js'
import { assertFreshSource, type FreshSourceRead } from './source-freshness.js'

import { selectionRevalidationRequestSchema,
  type SelectionRevalidationRequest, type SelectionRevalidationResult } from '../../contracts/selection.js'

export { selectionRevalidationRequestSchema } from '../../contracts/selection.js'
export type { SelectionRevalidationRequest, SelectionRevalidationResult } from '../../contracts/selection.js'

function stale(): never {
  throw Object.assign(new Error('PDF changed while its saved selections were revalidated; retry from the current version'),
    { code: 'pdf/stale-reader' })
}

/** Old native-text refs may survive annotation edits; the entire read-only batch
 * still belongs to one current, source-checked working-copy revision. */
export async function revalidateTextSelectionEvidence(workspaces: WorkingCopyReadPort, pages: AgentPageReadPort,
  references: EvidenceReferenceStore, raw: SelectionRevalidationRequest, signal: AbortSignal,
  readSource: FreshSourceRead): Promise<SelectionRevalidationResult> {
  signal.throwIfAborted()
  const input = selectionRevalidationRequestSchema.parse(raw)
  const snapshot = workspaces.readSnapshot(input.sessionId, input.documentId)
  const initial = { documentId: snapshot.id, sourcePath: snapshot.path, sourceDigest: evidenceSha256(snapshot.bytes),
    sourceVersion: snapshot.sourceVersion, contentVersion: snapshot.contentVersion, revision: snapshot.revision }
  const assertSnapshot = (current: HostWorkspaceSnapshot) => {
    signal.throwIfAborted()
    if (current.conflict || current.id !== initial.documentId || current.path !== initial.sourcePath
      || current.revision !== initial.revision || current.contentVersion !== initial.contentVersion
      || current.sourceVersion !== initial.sourceVersion || evidenceSha256(current.bytes) !== initial.sourceDigest) stale()
  }
  const assertCurrent = () => assertSnapshot(workspaces.readSnapshot(input.sessionId, input.documentId))
  if (initial.documentId !== input.documentId || initial.revision !== input.expectedRevision
    || initial.contentVersion !== input.expectedContentVersion) stale()
  assertSnapshot(snapshot)
  await assertFreshSource(input.sessionId, snapshot, readSource, signal)
  assertCurrent()
  const resolver = createTextReferenceResolver(workspaces, pages, references)
  const selections: SelectionRevalidationResult['selections'] = []
  for (const selection of input.selections) {
    const fragments: SelectionRevalidationResult['selections'][number]['fragments'] = [], texts: string[] = []
    let previousPage = 0
    for (const refId of selection.refIds) {
      assertCurrent()
      const resolved = await resolver.resolve(input.sessionId, input.documentId, refId, signal, readSource)
      assertCurrent()
      if (resolved.documentId !== initial.documentId || resolved.revision !== initial.revision
        || resolved.contentVersion !== initial.contentVersion || resolved.sourceVersion !== initial.sourceVersion
        || resolved.sourceDigest !== initial.sourceDigest) stale()
      if (resolved.page <= previousPage) {
        throw Object.assign(new Error('Saved selection references must have distinct, increasing page numbers'),
          { code: 'pdf/invalid-selection' })
      }
      previousPage = resolved.page
      texts.push(resolved.text)
      fragments.push({ page: resolved.page, rect: [...resolved.rectPdf], quadPoints: [...resolved.quadPoints] })
    }
    const text = texts.join('\n')
    if (text.length > 8000) {
      throw Object.assign(new Error('Saved selection exceeds the text evidence limit'), { code: 'pdf/selection-too-large' })
    }
    selections.push({ id: selection.id, text, fragments, evidenceRefs: [...selection.refIds] })
  }
  assertCurrent()
  await assertFreshSource(input.sessionId, snapshot, readSource, signal)
  assertCurrent()
  // No reference is minted or rewritten: original evidence remains immutable.
  return { ...initial, selections }
}
