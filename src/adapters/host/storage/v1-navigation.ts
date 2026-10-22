import { createHash } from 'node:crypto'
import type { NavigationStore, NavigationTable } from '../../../modules/navigation/index.js'

function normalizedPath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** Durable V1 path keying for reading positions. */
export function createV1NavigationStore<T>(table: NavigationTable<T>): NavigationStore<T> {
  return {
    get: key => table.get(key),
    put: (key, value) => table.put(key, value),
    delete: key => table.delete(key),
    key: path => createHash('sha256').update(normalizedPath(path)).digest('hex'),
    samePath: (left, right) => normalizedPath(left) === normalizedPath(right),
  }
}
