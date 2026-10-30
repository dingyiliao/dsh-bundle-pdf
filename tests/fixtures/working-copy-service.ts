/** Test composition using the same document and V1 storage adapters as the Host. */
import { pdfLibDocumentAdapter } from '../../src/adapters/host/pdf-lib/document-adapter.ts'
import { createV1DraftRepository } from '../../src/adapters/host/storage/v1-drafts.ts'
import { createV1NavigationStore } from '../../src/adapters/host/storage/v1-navigation.ts'
import { createWorkingCopyService, type V1DraftPort, type WorkingCopyFilePort } from '../../src/modules/working-copy/index.ts'
import { createReadingPositions, type NavigationTable, type ReadingPositionRecord } from '../../src/modules/navigation/index.ts'

export type { HostWorkspaceSnapshot } from '../../src/modules/working-copy/index.ts'
export type { ReadingPositionRecord } from '../../src/modules/navigation/index.ts'

export function createWorkspaces(files: WorkingCopyFilePort, drafts: V1DraftPort) {
  return createWorkingCopyService(files, createV1DraftRepository(drafts), pdfLibDocumentAdapter)
}

export function createReadingPositionService(
  workspaces: ReturnType<typeof createWorkspaces>, table: NavigationTable<ReadingPositionRecord>,
) {
  return createReadingPositions(workspaces, createV1NavigationStore(table))
}
