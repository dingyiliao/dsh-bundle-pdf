import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeOutlineEditRows, readNativeDocumentMetadata } from '../../../src/adapters/host/pdfium/document-metadata.js'
import type { NativeReply } from '../../../src/engine/protocol/commands.js'
import type { PdfOutlineItem } from '../../../src/core/pdf-types.js'

type Options = Parameters<typeof readNativeDocumentMetadata>[0]
const hash = (hex: string) => `sha256:${hex.repeat(64)}`
const page = (page: number): NativeReply<'documentInfo'>['value']['pages'][number] => ({
  page, mediaBox: [0, 0, 400, 600], cropBox: [10, 30, 380, 570], visibleBox: [10, 30, 380, 570],
  boxSource: 'page-dictionary', rotation: 90, renderedWidth: 540, renderedHeight: 370, userUnit: 2,
})

const defaults = (pageCount: number): Options => ({
  probe: { pageCount, formType: 0, signatureCount: 0, signatureStatus: 0 },
  async readDocumentInfo(offset, limit) {
    return { title: 'Native title', securityRevision: -1, permissions: 0xffffffff,
      pages: Array.from({ length: limit }, (_, index) => page(offset + index + 1)) }
  },
  async readFingerprints(_offset, limit) { return { digests: new Array<string>(limit).fill(hash('a')) } },
  async readOutlines() { return { entries: [] } },
})

function bookmark(id: string, title: string, page?: number, children: PdfOutlineItem[] = []): PdfOutlineItem {
  return { id, title, ...(page === undefined ? {} : { page }), children }
}

test('native document metadata preserves page dictionary geometry and bounds both IPC batches', async () => {
  const options = defaults(513)
  const geometry: number[][] = [], fingerprints: number[][] = []
  const document = await readNativeDocumentMetadata({ ...options,
    async readDocumentInfo(offset, limit) { geometry.push([offset, limit]); return options.readDocumentInfo(offset, limit) },
    async readFingerprints(offset, limit) { fingerprints.push([offset, limit]); return options.readFingerprints(offset, limit) },
  })
  assert.deepEqual(geometry, [[0, 512], [512, 1]])
  assert.deepEqual(fingerprints, geometry)
  assert.equal(document.pageCount, 513)
  assert.equal(document.title, 'Native title')
  assert.deepEqual(document.pages.at(-1), { page: 513, mediaBox: [0, 0, 400, 600], cropBox: [10, 30, 380, 570], rotation: 90, userUnit: 2 })
  assert.equal(document.readOnly, false)
  assert.deepEqual(document.outline, [])
  assert.equal(document.indexPageDigests?.length, 513)
  assert.match(document.indexContentDigest!, /^sha256:[a-f0-9]{64}$/)
  assert.equal(document.indexContentDigest, (await readNativeDocumentMetadata(options)).indexContentDigest)
})

test('effective geometry handles quarter turns and rejects malformed or out-of-sequence replies', async () => {
  const options = defaults(1)
  const effective = { ...page(1), userUnit: null, boxSource: 'effective-bounds' as const, renderedWidth: 810, renderedHeight: 555 }
  const read = async (item: typeof effective) => readNativeDocumentMetadata({ ...options,
    async readDocumentInfo() { return { permissions: 0, securityRevision: -1, pages: [item] } },
  })
  const document = await read(effective)
  assert.deepEqual(document.pages, [{ page: 1, cropBox: [10, 30, 380, 570], rotation: 90, userUnit: 1.5 }])
  await assert.rejects(read({ ...effective, renderedHeight: 400 }), { code: 'pdf/native-document-info' })
  await assert.rejects(read({ ...effective, page: 2 }), { code: 'pdf/native-document-info' })
})

test('geometry batches must attest to the same security state and contain all requested pages', async () => {
  const options = defaults(513)
  for (const fault of [{ pages: [] }, { securityRevision: 4 }, { permissions: 0x10 }]) {
    await assert.rejects(readNativeDocumentMetadata({
      ...options,
      async readDocumentInfo(offset, limit) {
        const reply = await options.readDocumentInfo(offset, limit)
        return offset === 0 ? reply : { ...reply, ...fault }
      },
      async readFingerprints() { throw new Error('An inconsistent document must not be indexed') },
    }), { code: 'pdf/native-document-info' })
  }
})

test('verified page fingerprints remain usable with incomplete coverage', async () => {
  const read = async (digests: (string | null)[]) => readNativeDocumentMetadata({ ...defaults(2), async readFingerprints() { return { digests } } })
  const partial = await read([hash('a'), null])
  assert.deepEqual(partial.indexPageDigests, [hash('a'), null])
  assert.ok(Object.isFrozen(partial.indexPageDigests))
  assert.equal(partial.indexContentDigest, undefined)
  assert.equal((await read([null, null])).indexPageDigests, undefined)
  assert.notEqual((await read([hash('a'), hash('b')])).indexContentDigest, (await read([hash('b'), hash('a')])).indexContentDigest)
  await assert.rejects(read([hash('a')]), /incomplete page fingerprint batch/)
})

test('signature, unknown signature status and XFA remain protected by document metadata', async () => {
  const options = defaults(1)
  const read = async (probe: Partial<Options['probe']>) => readNativeDocumentMetadata({ ...options, probe: { ...options.probe, ...probe } })
  const blank = await read({ formType: 1, signatureCount: 1 })
  assert.equal(blank.formKind, 'acroform')
  assert.equal(blank.signed, false)
  assert.equal(blank.readOnly, false)
  for (const signatureStatus of [1, -1] as const) {
    const protectedDocument = await read({ signatureStatus })
    assert.equal(protectedDocument.signed, true)
    assert.equal(protectedDocument.readOnlyReason, 'signed-document')
  }
  const xfa = await read({ formType: 2 })
  assert.equal(xfa.formKind, 'xfa')
  assert.equal(xfa.readOnlyReason, 'xfa-document')
})

test('flat native bookmarks produce a tree without treating external actions as local destinations', async () => {
  const entries = [
    { id: 'parent', title: 'Parent', parentIndex: -1, pageIndex: 0 },
    { id: 'external', title: 'External', parentIndex: 0, pageIndex: -1 },
    { id: 'child', title: 'Child', parentIndex: 0, pageIndex: 1 },
    { id: 'second', title: 'Second', parentIndex: -1, pageIndex: 1 },
  ]
  const read = async (result: NativeReply<'documentOutlines'>['value']) => readNativeDocumentMetadata({
    ...defaults(2), async readOutlines() { return result },
  })
  assert.deepEqual((await read({ entries })).outline, [
    bookmark('parent', 'Parent', 1, [bookmark('external', 'External'), bookmark('child', 'Child', 2)]),
    bookmark('second', 'Second', 2),
  ])
  assert.equal((await read({ readOnlyReason: 'Cycle in source' })).outlineReadOnlyReason, 'Cycle in source')
  for (const bad of [{ ...entries[1]!, parentIndex: 0 }, { ...entries[0]!, parentIndex: -1 },
    { ...entries[1]!, id: 'future', parentIndex: 6 }, { ...entries[1]!, id: 'outside', parentIndex: -1, pageIndex: 2 }]) {
    const result = await read({ entries: [...entries, bad] })
    assert.equal(result.outline, undefined)
    assert.match(result.outlineReadOnlyReason!, /invalid tree or destination/)
  }
})

test('outline edit planning preserves untouched destinations and carries explicit same-page retargeting', () => {
  const remote = bookmark('remote', 'External source')
  const moved = bookmark('move', 'Movable', 2)
  const samePage = bookmark('same', 'Same page', 1)
  const current = [bookmark('root', 'Root', 1, [moved, remote]), samePage, bookmark('deleted', 'Deleted', 2)]
  const projected = [remote, { ...samePage, targetChanged: true as const },
    bookmark('root', 'Renamed root', 1, [bookmark('fresh', 'New child', 3), moved])]
  assert.deepEqual(nativeOutlineEditRows(current, projected), [
    { id: 'remote', parentIndex: -1, pageIndex: -1 },
    { id: 'same', parentIndex: -1, pageIndex: 0 },
    { id: 'root', parentIndex: -1, pageIndex: -1, title: 'Renamed root' },
    { id: 'fresh', parentIndex: 2, pageIndex: 2, title: 'New child' },
    { id: 'move', parentIndex: 2, pageIndex: -1 },
  ])
  assert.throws(() => nativeOutlineEditRows(current, [bookmark('new-with-no-destination', 'Invalid')]), { code: 'invalid-operation' })
})
