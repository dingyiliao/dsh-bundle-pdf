import { createHash } from 'node:crypto'
import { encodePdfBaseline } from '../../../modules/document/index.js'
import type { DraftRecord, V1DraftPort, WorkingCopyDraftPort } from '../../../modules/working-copy/index.js'

function normalizedPath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** V1 keys and write order are deliberately unchanged for old-release rollback. */
export function createV1DraftRepository(table: V1DraftPort): WorkingCopyDraftPort {
  const key = (sessionId: string, path: string) =>
    createHash('sha256').update(JSON.stringify([sessionId, normalizedPath(path)])).digest('hex')
  const samePath = (left: string, right: string) => normalizedPath(left) === normalizedPath(right)
  const deleteBaseline = async (record: DraftRecord): Promise<void> => {
    if (record.baseKey) await table.delete(record.baseKey)
  }
  return {
    // Dispatch through the live table: Storage Domain adapters can be replaced
    // during tests or controlled teardown without pinning stale method closures.
    get: key => table.get(key),
    put: (key, record) => table.put(key, record),
    delete: key => table.delete(key),
    key, samePath, deleteBaseline,
    hydrate(saved) {
      const baseline = saved.original ? saved : saved.baseKey ? table.get(saved.baseKey) : undefined
      if (!baseline?.original || baseline.sourceHash !== saved.sourceHash
        || baseline.sessionId !== saved.sessionId || !samePath(baseline.path, saved.path)) {
        throw Object.assign(new Error('Saved draft baseline is missing or does not belong to this file'),
          { code: 'pdf/draft-damaged' })
      }
      return { ...saved, original: baseline.original,
        groupDates: saved.groupDates ?? saved.groups.map(() => new Date().toISOString()) }
    },
    async persist(record, sourceKey, baselineBytes, materializedHash) {
      if (!record.groups.length) {
        await table.delete(sourceKey)
        return record
      }
      const baseKey = record.baseKey ?? `base_${key(record.sessionId, record.path)}_${record.sourceHash.slice(7)}`
      if (!record.baseKey) {
        const base: DraftRecord = {
          ...record, original: record.original ?? encodePdfBaseline(baselineBytes), baseKey: undefined,
          groups: [], groupDates: [], cursor: 0, renderedHash: undefined,
        }
        await table.put(baseKey, base)
      }
      const persisted: DraftRecord = {
        ...record, original: undefined, baseKey, renderedHash: materializedHash,
      }
      await table.put(sourceKey, persisted)
      return { ...record, original: undefined, baseKey, renderedHash: materializedHash }
    },
  }
}
