import { writeFile, rename, readFile } from 'node:fs/promises'
import type { BenchmarkRow } from './schema.ts'
import { readRows } from './report.ts'

/** Keep incremental crash evidence, then replace it atomically with the complete, checked run. */
export async function finalizeRows(path: string, rows: readonly BenchmarkRow[]) {
  const serialized = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
  const temporary = `${path}.complete`
  await writeFile(temporary, serialized, { flag: 'wx' })
  await rename(temporary, path)
  if (await readFile(path, 'utf8') !== serialized) throw new Error('Final benchmark file does not match measured rows')
  return readRows(path)
}
