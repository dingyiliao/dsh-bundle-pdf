/** Working-copy fixtures exercise the document kernels directly. The Host's worker is tested separately. */
import { applyPdfOperations, loadPdfDocument } from '../../src/adapters/host/pdf-lib/pdf-document.ts'
import { createV1DraftRepository } from '../../src/adapters/host/storage/v1-drafts.ts'
import { createV1NavigationStore } from '../../src/adapters/host/storage/v1-navigation.ts'
import { createWorkingCopyService, type PdfDocumentPort, type V1DraftPort, type WorkingCopyFilePort } from '../../src/modules/working-copy/index.ts'
import { createReadingPositions, type NavigationTable, type ReadingPositionRecord } from '../../src/modules/navigation/index.ts'

export type { HostWorkspaceSnapshot } from '../../src/modules/working-copy/index.ts'
export type { ReadingPositionRecord } from '../../src/modules/navigation/index.ts'

export const inProcessPdfDocument: PdfDocumentPort = { inspect: loadPdfDocument, materialize: applyPdfOperations }

export function createWorkspaces(files: WorkingCopyFilePort, drafts: V1DraftPort) {
  return createWorkingCopyService(files, createV1DraftRepository(drafts), inProcessPdfDocument)
}

export function createReadingPositionService(
  workspaces: ReturnType<typeof createWorkspaces>, table: NavigationTable<ReadingPositionRecord>,
) {
  return createReadingPositions(workspaces, createV1NavigationStore(table))
}
