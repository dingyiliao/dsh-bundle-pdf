import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Discover both boundary tests and module-owned tests in stable order. */
export async function nodeTestFiles(root) {
  const testsRoot = join(root, 'tests')
  const files = []

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        files.push(relative(root, path).split(sep).join('/'))
      }
    }
  }

  await visit(testsRoot)
  return files.sort()
}
