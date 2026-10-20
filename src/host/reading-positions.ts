/** Compatibility entrypoint for the Host reading-position service and V1 domain schema. */
import { createV1NavigationStore } from '../adapters/host/storage/v1-navigation.ts'
import { createReadingPositions, type NavigationTable, type NavigationWorkspaces,
  type ReadingPositionRecord } from '../modules/navigation/index.ts'

export { readingPositionRecordSchema } from '../modules/navigation/index.ts'
export type { ReadingPositionRecord, ReadingPositionStale, StoredReadingPosition } from '../modules/navigation/index.ts'

export function createReadingPositionService(
  workspaces: NavigationWorkspaces, table: NavigationTable<ReadingPositionRecord>,
) {
  return createReadingPositions(workspaces, createV1NavigationStore(table))
}
