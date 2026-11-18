import { fixturePdfDocument } from './native-document.ts'
import { createV1DraftRepository } from '../../src/layers/document/working-copy/storage/v1-drafts.ts'
import { createV1NavigationStore } from '../../src/layers/facade/navigation/storage/v1-navigation.ts'
import { createWorkingCopyService, type V1DraftPort, type WorkingCopyFilePort } from '../../src/layers/document/working-copy/index.ts'
import { createReadingPositions, type NavigationTable, type ReadingPositionRecord } from '../../src/layers/facade/navigation/index.ts'

export type { HostWorkspaceSnapshot } from '../../src/layers/document/working-copy/index.ts'
export type { ReadingPositionRecord } from '../../src/layers/facade/navigation/index.ts'

export { fixturePdfDocument } from './native-document.ts'

export function createWorkspaces(files: WorkingCopyFilePort, drafts: V1DraftPort) {
  return createWorkingCopyService(files, createV1DraftRepository(drafts), fixturePdfDocument)
}

export function createReadingPositionService(
  workspaces: ReturnType<typeof createWorkspaces>, table: NavigationTable<ReadingPositionRecord>,
) {
  return createReadingPositions(workspaces, createV1NavigationStore(table))
}
