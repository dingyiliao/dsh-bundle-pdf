import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const directory = dirname(fileURLToPath(import.meta.url))
const manifestPath = join(directory, 'patches/patchset.json')

export async function readPatchset() {
  return JSON.parse(await readFile(manifestPath, 'utf8'))
}

export async function patchsetDigest() {
  const manifest = await readPatchset()
  const hash = createHash('sha256')
  hash.update(`format:${manifest.format}\nsourceRevision:${manifest.sourceRevision}\n`)
  for (const step of manifest.steps) {
    hash.update(`step:${step.id}\nentry:${step.entry}\n`)
    for (const source of step.sources) {
      hash.update(`file:${source}\n`)
      hash.update(await readFile(join(directory, source)))
      hash.update('\n')
    }
  }
  return `sha256:${hash.digest('hex')}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await readPatchset()
  const digest = await patchsetDigest()
  console.log(JSON.stringify({ ...manifest, digest }, null, 2))
}
