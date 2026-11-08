import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import test from 'node:test'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream,
  PDFRef, PDFString, degrees } from 'pdf-lib'
import { pdfIndexContentDigest, pdfIndexContentIdentity } from '../../../src/adapters/host/pdf-lib/content-identity.js'
import { applyPdfOperations, loadPdfDocument } from '../../../src/adapters/host/pdf-lib/pdf-document.js'

const name = PDFName.of
const pageProgram = 'q 0 0 1 rg 10 20 30 40 re f Q\n'

async function fixture(padding = 0) {
  const doc = await PDFDocument.create()
  for (let index = 0; index < padding; index++) doc.context.register(PDFString.of(`unreachable-${index}`))
  const page = doc.addPage([400, 600])
  const stream = doc.context.register(doc.context.stream(pageProgram))
  page.node.set(name('Contents'), stream)
  return { doc, page, stream }
}
const digest = (document: PDFDocument) => {
  const value = pdfIndexContentDigest(document)
  assert.match(value ?? '', /^sha256:[a-f0-9]{64}$/)
  return value!
}

test('annotation, comment, note and bookmark saves retain the same indexed page identity after reopening', async () => {
  const { doc } = await fixture()
  const bytes = await doc.save({ useObjectStreams: false })
  const original = await loadPdfDocument(bytes)
  assert.equal(original.indexContentDigest, 'sha256:2e39b05ccc7c3b6135b11c63ed53f9590c2a6807094c1c212687f6934a456e68')
  assert.match(original.indexPageDigests?.[0] ?? '', /^sha256:[a-f0-9]{64}$/)
  async function checkIdentity(saved: Uint8Array) {
    const reopened = await loadPdfDocument(saved)
    assert.equal(reopened.indexContentDigest, original.indexContentDigest)
    assert.deepEqual(reopened.indexPageDigests, original.indexPageDigests)
  }
  const added = await applyPdfOperations(bytes, [
    { type: 'add', annotation: { id: 'highlight', page: 1, subtype: 'Highlight', rect: [10, 20, 80, 40],
      quadPoints: [10, 40, 80, 40, 10, 20, 80, 20], contents: 'Comment one', color: [1, 1, 0] } },
    { type: 'add', annotation: { id: 'note', page: 1, subtype: 'Text', rect: [150, 150, 180, 180], contents: 'A note' } },
    { type: 'outline-add', id: 'chapter', title: 'Chapter one', page: 1 },
  ])
  assert.notEqual(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(added.bytes).digest('hex'))
  assert.equal(added.document.indexContentDigest, original.indexContentDigest)
  assert.deepEqual(added.document.indexPageDigests, original.indexPageDigests)
  await checkIdentity(added.bytes)
  const edited = await applyPdfOperations(added.bytes, [
    { type: 'update', id: 'highlight', patch: { contents: 'Revised comment', color: [0, 1, 0], commentPosition: [200, 200] } },
    { type: 'update', id: 'note', patch: { contents: 'Revised note', rect: [200, 100, 250, 150] } },
    { type: 'outline-update', id: 'chapter', patch: { title: 'Renamed chapter' } },
  ])
  await checkIdentity(edited.bytes)
  const removed = await applyPdfOperations(edited.bytes, [
    { type: 'delete', id: 'highlight' }, { type: 'delete', id: 'note' }, { type: 'outline-delete', id: 'chapter' },
  ])
  await checkIdentity(removed.bytes)
})

test('a saved page program change preserves other page digests and invalidates the document digest', async () => {
  const { doc, stream } = await fixture()
  const second = doc.addPage([400, 600])
  second.node.set(name('Contents'), stream)
  const original = await loadPdfDocument(await doc.save())
  assert.equal(original.indexPageDigests?.length, 2)
  assert.equal(original.indexPageDigests?.[0], original.indexPageDigests?.[1])

  second.node.set(name('Contents'), doc.context.register(doc.context.stream('q 1 0 0 rg 10 20 30 40 re f Q\n')))
  const edited = await loadPdfDocument(await doc.save())
  assert.equal(edited.indexPageDigests?.[0], original.indexPageDigests?.[0])
  assert.notEqual(edited.indexPageDigests?.[1], original.indexPageDigests?.[1])
  assert.notEqual(edited.indexContentDigest, original.indexContentDigest)
})

test('page fingerprints include document-wide visibility and output-intent dependencies', async () => {
  const { doc } = await fixture()
  doc.addPage([400, 600])
  let previous = pdfIndexContentIdentity(doc).indexPageDigests!
  for (const [key, value] of [
    ['OCProperties', doc.context.obj({ D: { BaseState: 'OFF' } })],
    ['OutputIntents', doc.context.obj([{ S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('New output intent') }])],
  ] as const) {
    doc.catalog.set(name(key), value)
    const current = pdfIndexContentIdentity(doc).indexPageDigests!
    assert.equal(current.length, 2)
    for (const [index, value] of current.entries()) assert.notEqual(value, previous[index])
    previous = current
  }
  doc.catalog.set(name('OCProperties'), PDFRef.of(99999))
  assert.deepEqual(pdfIndexContentIdentity(doc), {})
})

test('an unverifiable page leaves a hole and unwinds resource traversal before later pages', async () => {
  const { doc, page, stream } = await fixture()
  const second = doc.addPage([400, 600])
  second.node.set(name('Contents'), stream)
  const shared = doc.context.register(doc.context.obj({ Inner: { Value: 42 } }))
  second.node.Resources()!.set(name('Properties'), doc.context.obj({ Resource: shared }))
  const verified = pdfIndexContentIdentity(doc).indexPageDigests?.[1]
  assert.match(verified ?? '', /^sha256:[a-f0-9]{64}$/)

  page.node.Resources()!.set(name('Properties'), doc.context.obj({ Wrapper: { Wrapper: { Resource: shared } } }))
  assert.deepEqual(pdfIndexContentIdentity(doc, { maxDepth: 5 }), { indexPageDigests: [null, verified] })
  page.node.Resources()!.delete(name('Properties'))
  page.node.set(name('Contents'), doc.context.register(PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), Buffer.from([1, 2, 3]))))
  assert.deepEqual(pdfIndexContentIdentity(doc), { indexPageDigests: [null, verified] })
})

test('independent pages can exceed 256 MiB of decoded data within the total work budget', async () => {
  const doc = await PDFDocument.create(), size = 16 * 1024 * 1024
  const contents = deflateSync(Buffer.alloc(size, 32))
  for (let index = 0; index < 17; index++) {
    const page = doc.addPage([400, 600])
    page.node.set(name('Contents'), doc.context.register(PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), contents)))
  }
  const identity = pdfIndexContentIdentity(doc)
  assert.match(identity.indexContentDigest ?? '', /^sha256:[a-f0-9]{64}$/)
  assert.equal(identity.indexPageDigests?.filter(Boolean).length, 17)

  const limited = pdfIndexContentIdentity(doc, { maxBytes: size * 4 })
  assert.equal(limited.indexContentDigest, undefined)
  assert.equal(limited.indexPageDigests?.[0], identity.indexPageDigests?.[0])
  assert.equal(limited.indexPageDigests?.[16], null)
})

test('an exhausted document aggregate budget keeps the proven individual page digests', async () => {
  const { doc, stream } = await fixture()
  doc.addPage([400, 600]).node.set(name('Contents'), stream)
  const complete = pdfIndexContentIdentity(doc)
  assert.match(complete.indexContentDigest ?? '', /^sha256:[a-f0-9]{64}$/)
  assert.equal(complete.indexPageDigests?.filter(Boolean).length, 2)

  const bounded = pdfIndexContentIdentity(doc, { maxBytes: 900 })
  assert.deepEqual(bounded, { indexPageDigests: complete.indexPageDigests })
})

test('external annotation and metadata rewrites do not invalidate the page identity', async () => {
  const { doc, page } = await fixture()
  const original = digest(doc)
  page.node.set(name('Annots'), doc.context.obj([doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: PDFString.of('External comment'),
  }))]))
  doc.setTitle('A different title'); doc.setModificationDate(new Date('2026-11-03T01:00:00Z'))
  doc.catalog.set(name('Metadata'), doc.context.register(doc.context.stream('<xmp>metadata only</xmp>')))
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of('abcd'), PDFHexString.of('ef01')])
  const reopened = await PDFDocument.load(await doc.save({ useObjectStreams: true }), { updateMetadata: false })
  assert.equal(digest(reopened), original)
})

test('PDF object numbering and dictionary insertion order are not page content', async () => {
  const first = await fixture(), second = await fixture(17)
  assert.notEqual(first.stream.objectNumber, second.stream.objectNumber)
  for (const [index, value] of [first, second].entries()) {
    const entries = index ? [['B', 2], ['A', 1]] as const : [['A', 1], ['B', 2]] as const
    const properties = PDFDict.withContext(value.doc.context)
    for (const [key, number] of entries) properties.set(name(key), PDFNumber.of(number))
    value.page.node.Resources()!.set(name('Properties'), properties)
  }
  assert.equal(digest(first.doc), digest(second.doc))
})

test('uncompressed and differently compressed Flate page streams share one identity', async () => {
  const first = await fixture(), baseline = digest(first.doc)
  for (const level of [1, 9]) {
    const bytes = deflateSync(Buffer.from(pageProgram), { level })
    const stream = PDFRawStream.of(first.doc.context.obj({ Filter: 'FlateDecode', Length: bytes.length + 400 }), bytes)
    first.page.node.set(name('Contents'), first.doc.context.register(stream))
    assert.equal(digest(first.doc), baseline)
  }
  const arrayFilter = first.doc.context.flateStream(pageProgram, { Filter: ['FlateDecode'], DecodeParms: [null] })
  first.page.node.set(name('Contents'), first.doc.context.register(arrayFilter))
  assert.equal(digest(first.doc), baseline)
})

test('equivalent stream arrays, inherited resources and inherited geometry remain reusable', async () => {
  const { doc, page, stream } = await fixture(), original = digest(doc)
  page.node.set(name('Contents'), doc.context.obj([stream]))
  const resources = page.node.Resources()!, parent = page.node.Parent()!
  parent.set(name('Resources'), resources); page.node.delete(name('Resources'))
  parent.set(name('MediaBox'), page.node.get(name('MediaBox'))!); page.node.delete(name('MediaBox'))
  assert.equal(digest(doc), original)
  resources.set(name('Font'), doc.context.obj({})); resources.set(name('XObject'), doc.context.obj({}))
  resources.set(name('ExtGState'), doc.context.obj({})); resources.set(name('ProcSet'), doc.context.obj(['PDF', 'Text']))
  assert.equal(digest(doc), original)
})

test('external pdf-lib annotation normalization retains the indexed page program after save and reopen', async () => {
  const { doc } = await fixture()
  const initial = await doc.save({ useObjectStreams: false })
  const original = (await loadPdfDocument(initial)).indexContentDigest
  let bytes: Uint8Array = initial
  for (let edit = 0; edit < 3; edit++) {
    const external = await PDFDocument.load(bytes, { updateMetadata: false })
    const page = external.getPage(0)
    page.node.addAnnot(external.context.register(external.context.obj({
      Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: PDFString.of(`External note ${edit}`),
    })))
    const contents = page.node.Contents()
    assert.ok(contents instanceof PDFArray && contents.size() >= 3, 'the actual external API inserted graphics-state wrappers')
    bytes = await external.save({ useObjectStreams: edit % 2 === 0 })
    assert.equal((await loadPdfDocument(bytes)).indexContentDigest, original)
  }
})

test('outer graphics-state wrappers ignore q/Q in strings, names, hex strings, comments and containers', async () => {
  for (const program of [
    'BT (q Q) Tj ET\n',
    'BT (nested (q Q) and escaped \\(Q\\)) Tj ET\n',
    'BT <712051> Tj ET\n',
    '/q /Q /escaped#20Q MP\n',
    '% q Q\nq\nQ\n% Q at end of a comment',
    '[ (q Q) /Q << /nested [ /q (Q) ] >> ] TJ\n',
    '<< /ActualText (q Q) >> /Span BDC EMC\n',
    'q\n1 0 0 1 0 0 cm\nQ\n',
    '',
  ]) {
    const { doc, page } = await fixture()
    const body = doc.context.register(doc.context.stream(program))
    page.node.set(name('Contents'), body)
    const original = digest(doc)
    const opening = doc.context.register(doc.context.flateStream('q\n'))
    const closing = doc.context.register(doc.context.flateStream('Q\n'))
    page.node.set(name('Contents'), doc.context.obj([opening, body, closing]))
    assert.equal(digest(doc), original, program)
  }
})

test('unbalanced, inline-image, unknown and malformed programs do not get wrapper equivalence', async () => {
  for (const program of [
    'Q\n', 'q\n', 'BI /W 1 /H 1 ID q Q EI\n', 'unknownOperator\n',
    '(unclosed q', '(trailing escape \\', '<71', '<7z>', '[', '<<', '>', '[>>', '<< /x 1 >', '{', ')',
  ]) {
    const { doc, page } = await fixture()
    const body = doc.context.register(doc.context.stream(program))
    page.node.set(name('Contents'), body)
    const original = digest(doc)
    page.node.set(name('Contents'), doc.context.obj([
      doc.context.register(doc.context.stream('q\n')), body, doc.context.register(doc.context.stream('Q\n')),
    ]))
    assert.notEqual(digest(doc), original, program)
  }
})

test('wrapper decoding is bounded and does not mistake arbitrary streams or predictor data for wrappers', async () => {
  const { doc, page, stream } = await fixture(), original = digest(doc)
  const closing = doc.context.register(doc.context.stream('Q\n'))
  for (const opening of [
    doc.context.stream('q\n', { DecodeParms: { Predictor: 2 } }),
    doc.context.stream('q\n', { Filter: 'UnknownFilter' }),
    doc.context.stream(' '.repeat(200) + 'q\n'),
    doc.context.stream('n\n'),
  ]) {
    page.node.set(name('Contents'), doc.context.obj([doc.context.register(opening), stream, closing]))
    assert.notEqual(digest(doc), original)
  }
  page.node.set(name('Contents'), doc.context.obj([PDFNumber.of(1), stream, closing]))
  assert.notEqual(digest(doc), original)
  page.node.set(name('Contents'), doc.context.obj([
    doc.context.register(doc.context.stream('q\n')),
    doc.context.register(doc.context.stream('x'.repeat(1000))), closing,
  ]))
  assert.match(pdfIndexContentDigest(doc, { maxStreamBytes: 1200 }) ?? '', /^sha256:/)
})

test('sharing or copying identical acyclic resources does not invalidate an index', async () => {
  const first = await fixture(), second = await fixture(11)
  const shared = first.doc.context.obj({ Count: 2, Flag: true, Tag: 'Example' })
  first.page.node.Resources()!.set(name('Properties'), first.doc.context.obj({ First: shared, Second: shared }))
  second.page.node.Resources()!.set(name('Properties'), second.doc.context.obj({
    First: { Count: 2, Flag: true, Tag: 'Example' }, Second: { Count: 2, Flag: true, Tag: 'Example' },
  }))
  assert.equal(digest(first.doc), digest(second.doc))
  shared.set(name('Count'), PDFNumber.of(3))
  assert.notEqual(digest(first.doc), digest(second.doc))
})

test('cyclic resources and document-container backlinks take the conservative fallback path', async () => {
  const first = await fixture(), second = await fixture(11)
  for (const { doc, page } of [first, second]) {
    const resources = page.node.Resources()!, properties = doc.context.obj({ Count: 2, Flag: true, Tag: 'Example' })
    const ref = doc.context.register(properties)
    properties.set(name('Self'), ref)
    resources.set(name('Properties'), properties)
  }
  assert.equal(pdfIndexContentDigest(first.doc), undefined)
  assert.equal(pdfIndexContentDigest(second.doc), undefined)
  for (const pointer of [first.page.ref, first.page.node.Parent()!, first.doc.catalog]) {
    first.page.node.Resources()!.set(name('Properties'), first.doc.context.obj({ Backlink: pointer }))
    assert.equal(pdfIndexContentDigest(first.doc), undefined)
  }
})

test('identical optional-content groups retain their distinct visibility membership', async () => {
  const { doc, page } = await fixture()
  const first = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Same label') }))
  const second = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Same label') }))
  doc.catalog.set(name('OCProperties'), doc.context.obj({ OCGs: [first, second], D: { ON: [first], OFF: [second] } }))
  const properties = doc.context.obj({ VisibleLayer: first })
  page.node.Resources()!.set(name('Properties'), properties)
  const original = digest(doc)
  properties.set(name('VisibleLayer'), second)
  assert.notEqual(digest(doc), original, 'pointing the same page at the hidden group changes its content')
  const groups = doc.context.lookup(doc.catalog.lookup(name('OCProperties'), PDFDict).get(name('OCGs')), PDFArray)
  groups.push(first)
  assert.equal(pdfIndexContentDigest(doc), undefined)
  doc.catalog.delete(name('OCProperties'))
  assert.equal(pdfIndexContentDigest(doc), undefined, 'an unregistered group has no trustworthy visibility identity')
})

test('real page program, resource, geometry and visibility changes invalidate the identity', async () => {
  for (const mutate of [
    ({ doc, page }: Awaited<ReturnType<typeof fixture>>) => page.node.set(name('Contents'), doc.context.register(doc.context.stream('q 1 0 0 rg 10 20 30 40 re f Q'))),
    ({ doc, page }: Awaited<ReturnType<typeof fixture>>) => page.node.Resources()!.set(name('XObject'), doc.context.obj({ Image: doc.context.register(doc.context.stream('changed pixels', { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2 })) })),
    ({ page }: Awaited<ReturnType<typeof fixture>>) => page.setMediaBox(0, 0, 500, 600),
    ({ page }: Awaited<ReturnType<typeof fixture>>) => page.setCropBox(10, 10, 300, 400),
    ({ page }: Awaited<ReturnType<typeof fixture>>) => page.setRotation(degrees(90)),
    ({ page }: Awaited<ReturnType<typeof fixture>>) => page.node.set(name('UserUnit'), PDFNumber.of(2)),
    ({ doc, page }: Awaited<ReturnType<typeof fixture>>) => page.node.set(name('Group'), doc.context.obj({ S: 'Transparency', I: true })),
    ({ doc }: Awaited<ReturnType<typeof fixture>>) => doc.catalog.set(name('OCProperties'), doc.context.obj({ D: { BaseState: 'OFF' } })),
    ({ doc }: Awaited<ReturnType<typeof fixture>>) => doc.catalog.set(name('OutputIntents'), doc.context.obj([{ S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('Different color output') }])),
  ]) {
    const value = await fixture(), original = digest(value.doc)
    mutate(value); assert.notEqual(digest(value.doc), original)
  }
})

test('literal and hexadecimal resource strings use their decoded byte value', async () => {
  const first = await fixture(), second = await fixture()
  first.page.node.Resources()!.set(name('Properties'), first.doc.context.obj({ Text: PDFString.of('Hello') }))
  second.page.node.Resources()!.set(name('Properties'), second.doc.context.obj({ Text: PDFHexString.of('48656c6c6f') }))
  assert.equal(digest(first.doc), digest(second.doc))
})

test('opaque image filters retain bytes and decode parameters in their identity', async () => {
  const { doc, page } = await fixture()
  const image = PDFRawStream.of(doc.context.obj({ Type: 'XObject', Subtype: 'Image', Filter: 'DCTDecode' }), new Uint8Array([1, 2, 3]))
  page.node.Resources()!.set(name('XObject'), doc.context.obj({ Image: doc.context.register(image) }))
  const original = digest(doc)
  image.dict.set(name('DecodeParms'), doc.context.obj({ ColorTransform: 0 }))
  assert.notEqual(digest(doc), original)
})

test('traversal, allocation and decompression failures safely leave byte-hash fallback available', async () => {
  const { doc, page } = await fixture()
  for (const limits of [{ maxObjects: 0 }, { maxBytes: 1 }, { maxDepth: 0 }, { maxStreamBytes: 2 }]) {
    assert.equal(pdfIndexContentDigest(doc, limits), undefined)
  }
  const invalid = PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), new Uint8Array([1, 2, 3]))
  page.node.set(name('Contents'), doc.context.register(invalid))
  assert.equal(pdfIndexContentDigest(doc), undefined)
  const bomb = doc.context.flateStream('a'.repeat(2000))
  page.node.set(name('Contents'), doc.context.register(bomb))
  assert.equal(pdfIndexContentDigest(doc, { maxStreamBytes: 128 }), undefined)
  page.node.set(name('Contents'), doc.context.register(doc.context.stream('a'.repeat(2000))))
  assert.equal(pdfIndexContentDigest(doc, { maxBytes: 512 }), undefined)
  await assert.doesNotReject(doc.save())
})

test('missing references and unsupported content objects do not mint an unsafe reusable identity', async () => {
  const { doc, page } = await fixture()
  page.node.set(name('Group'), PDFRef.of(99999))
  assert.equal(pdfIndexContentDigest(doc), undefined)
  page.node.delete(name('Group'))
  page.node.Resources()!.set(name('Unknown'), PDFString.of('An unsupported resource category'))
  assert.equal(pdfIndexContentDigest(doc), undefined)
  page.node.Resources()!.delete(name('Unknown'))
  const properties = doc.context.obj({})
  properties.set(name('Unknown'), { clone() { return this }, toString() { return 'unknown' } } as never)
  page.node.Resources()!.set(name('Properties'), properties)
  assert.equal(pdfIndexContentDigest(doc), undefined)
})
