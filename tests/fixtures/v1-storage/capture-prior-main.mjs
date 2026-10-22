/**
 * Capture actual V1 writes from a pre-refactor checkout, not a hand-authored
 * approximation. This is a maintainer-only generator; it is not run in CI.
 *
 *   git archive 643a7c9512ff615d9d718b70b1f97c617b2b9abd | tar -x -C "$checkout"
 *   ln -s "$repo/node_modules" "$checkout/node_modules"
 *   node --import tsx tests/fixtures/v1-storage/capture-prior-main.mjs \
 *     "$checkout" tests/fixtures/v1-storage/source.pdf \
 *     tests/fixtures/v1-storage/prior-main-capture.json
 *
 * The capture contains random IDs and timestamps, so do not expect byte-for-
 * byte reproduction. Never regenerate it from the code under test.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [checkoutArgument, pdfArgument, outputArgument] = process.argv.slice(2)
if (!checkoutArgument || !pdfArgument) {
  throw new Error('Usage: capture-prior-main.mjs <pre-refactor-checkout> <source.pdf> [output.json]')
}

const checkout = resolve(checkoutArgument)
const pdf = resolve(pdfArgument)
const expectedSources = {
  'src/host/workspaces.ts': 'f2bf303b0a2552f67024747f581952c8e826147f01e1cca2c768fccb22961f38',
  'src/host/reading-positions.ts': '64296b4e965585c4dbe12597255a566f27e029f2df6b976e27db9d04bc1ce2ab',
  'src/host/validation.ts': 'c0a5d3bbfed759232ec58bb667b46051d6fca3f04eb0e3d7a04fca7ac13fa533',
}
for (const [file, expected] of Object.entries(expectedSources)) {
  const actual = createHash('sha256').update(await readFile(join(checkout, file))).digest('hex')
  if (actual !== expected) throw new Error(`Not the frozen pre-refactor main source: ${file}`)
}
const readOld = async file => import(pathToFileURL(join(checkout, file)).href)
const { createWorkspaces } = await readOld('src/host/workspaces.ts')
const { createReadingPositionService } = await readOld('src/host/reading-positions.ts')
const source = new Uint8Array(await readFile(pdf))
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const sessionId = 'v1-prior-main-capture'
const path = '/fixtures/prior-main.pdf'
const address = `dsh-resource://file/session/${sessionId}/${encodeURIComponent(path)}`
const agent = { session: { id: sessionId, header: { cwd: '/fixtures' } } }
const signal = new AbortController().signal
const draftRecords = new Map(), positionRecords = new Map()
const table = records => ({
  get: key => records.get(key),
  async put(key, record) { records.set(key, structuredClone(record)) },
  async delete(key) { records.delete(key) },
})
const files = {
  async resolvePath(_agent, requested) {
    if (requested !== path) throw new Error(`Unexpected path: ${requested}`)
    return path
  },
  async read() {
    return { path, bytes: source.slice(), version: digest(source),
      fsVersion: 'prior-main-source-1', size: source.length }
  },
  async save() { throw new Error('Capturing pre-save V1 records must not write the source PDF') },
}
const workspaces = createWorkspaces(files, table(draftRecords))
const positions = createReadingPositionService(workspaces, table(positionRecords))
const run = input => workspaces.execute(sessionId, { sessionId, ...input }, agent, signal)
const position = input => positions.dispatch(sessionId, { sessionId, ...input }, agent, signal)
const note = (id, x) => ({ type: 'add', annotation: { id, page: 1,
  subtype: 'Text', rect: [x, 40, x + 20, 60], contents: id } })

try {
  const opened = await run({ action: 'open', address })
  const first = await run({ action: 'change', id: opened.id, revision: opened.revision,
    operations: [note('old-main-note-a', 40)] })
  const second = await run({ action: 'change', id: first.id, revision: first.revision,
    operations: [note('old-main-note-b', 80)] })
  const undone = await run({ action: 'undo', id: second.id, revision: second.revision })
  const place = { page: 1, x: 40, y: 300, scale: 1.2,
    fit: 'custom', viewportAnchor: { x: 0.25, y: 0.5 } }
  await position({ action: 'set', id: undone.id, position: place })
  const records = entries => [...entries].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, record]) => ({ key, record }))
  const capture = {
    origin: { kind: 'pre-refactor-git-main-source',
      commit: '643a7c9512ff615d9d718b70b1f97c617b2b9abd',
      sourceSha256: digest(source) },
    sessionId, path, address,
    expected: { activeAnnotationIds: ['old-main-note-a'], redoAnnotationIds: ['old-main-note-a', 'old-main-note-b'],
      revision: undone.revision, sourceHash: digest(source), position: place },
    domains: {
      drafts: records(draftRecords),
      positions: records(positionRecords),
    },
  }
  const serialized = `${JSON.stringify(capture, null, 2)}\n`
  if (outputArgument) await writeFile(resolve(outputArgument), serialized, 'utf8')
  else process.stdout.write(serialized)
} finally {
  await positions.dispose()
  await workspaces.dispose()
}
