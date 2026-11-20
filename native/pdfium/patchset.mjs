import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const directory = dirname(fileURLToPath(import.meta.url))
const manifestPath = join(directory, 'patches/patchset.json')
const patchPathPattern = /^patches\/\d{4}-[a-z0-9-]+\.patch$/

export async function readPatchset() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.format !== 2 || typeof manifest.sourceRevision !== 'string'
      || !Array.isArray(manifest.steps) || !manifest.steps.length) {
    throw new Error('Invalid PDFium patchset manifest')
  }
  const ids = new Set()
  const paths = new Set()
  for (const step of manifest.steps) {
    if (!step || typeof step.id !== 'string' || ids.has(step.id)
        || typeof step.patch !== 'string' || !patchPathPattern.test(step.patch) || paths.has(step.patch)) {
      throw new Error('Invalid or duplicate PDFium patchset step')
    }
    ids.add(step.id)
    paths.add(step.patch)
    const patch = await readFile(join(directory, step.patch))
    if (!patch.toString('utf8').startsWith('diff --git a/')) {
      throw new Error('PDFium patch is not a unified git diff: ' + step.patch)
    }
  }
  return manifest
}

export async function patchsetDigest() {
  const manifest = await readPatchset()
  const hash = createHash('sha256')
  hash.update('format:' + manifest.format + '\nsourceRevision:' + manifest.sourceRevision + '\n')
  for (const step of manifest.steps) {
    hash.update('step:' + step.id + '\npatch:' + step.patch + '\n')
    hash.update(await readFile(join(directory, step.patch)))
    hash.update('\n')
  }
  return 'sha256:' + hash.digest('hex')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await readPatchset()
  const digest = await patchsetDigest()
  console.log(JSON.stringify({ ...manifest, digest }, null, 2))
}
