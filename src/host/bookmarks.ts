/** Compatibility entrypoint for the Host bookmark service and V1 domain schema. */
import { createV1NavigationStore } from '../adapters/host/storage/v1-navigation.ts'
import { createBookmarks, type BookmarkRecord, type NavigationTable,
  type NavigationWorkspaces } from '../modules/navigation/index.ts'

export { bookmarkPositionSchema, bookmarkRecordSchema } from '../modules/navigation/index.ts'
export type { BookmarkRecord } from '../modules/navigation/index.ts'

export function createBookmarkService(workspaces: NavigationWorkspaces, table: NavigationTable<BookmarkRecord>) {
  return createBookmarks(workspaces, createV1NavigationStore(table))
}
