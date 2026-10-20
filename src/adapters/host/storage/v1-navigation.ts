import { createHash } from 'node:crypto'
import type { NavigationStore, NavigationTable } from '../../../modules/navigation/index.js'

function normalizedPath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** Shared V1 keying for bookmarks and reading positions; records stay in separate domains. */
export function createV1NavigationStore<T>(table: NavigationTable<T>): NavigationStore<T> {
  return {
    get: key => table.get(key),
    put: (key, value) => table.put(key, value),
    delete: key => table.delete(key),
    key: path => createHash('sha256').update(normalizedPath(path)).digest('hex'),
    samePath: (left, right) => normalizedPath(left) === normalizedPath(right),
  }
}
