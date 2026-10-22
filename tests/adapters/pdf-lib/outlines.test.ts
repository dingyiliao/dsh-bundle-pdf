import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib'
import { applyPdfOperations, loadPdfDocument, type PdfOutlineItem } from '../../../src/adapters/host/pdf-lib/pdf-document.js'
import { applyOutlineOperations, inspectOutlines } from '../../../src/adapters/host/pdf-lib/outlines.js'
import { recoverableOutlineFixture } from '../../fixtures/recoverable-outline.ts'

const key = (name: string) => PDFName.of(name)
const objectId = (ref: PDFRef) => `pdf-outline:${ref.objectNumber}:${ref.generationNumber}`
const save = (doc: PDFDocument) => doc.save({ useObjectStreams: false, updateFieldAppearances: false })
function dictionary(doc: PDFDocument, ref: PDFRef) { return doc.context.lookup(ref, PDFDict) }
function flatten(items: readonly PdfOutlineItem[]): PdfOutlineItem[] { return items.flatMap(item => [item, ...flatten(item.children)]) }

async function fixture() {
  const doc = await PDFDocument.create()
  for (let i = 0; i < 4; i++) doc.addPage([400, 600])
  const root = doc.context.obj({ Type: key('Outlines'), Count: 3 })
  const rootRef = doc.context.register(root)
  const chapter = doc.context.obj({
    Title: PDFHexString.fromText('章节一'), Parent: rootRef, Count: -1,
    Dest: [doc.getPage(0).ref, key('XYZ'), 12, 540, 1.5],
    C: [0.2, 0.4, 0.6], F: 3, VendorValue: { Keep: PDFString.of('opaque data') },
  })
  const chapterRef = doc.context.register(chapter)
  const child = doc.context.obj({ Title: PDFHexString.fromText('命名位置'), Parent: chapterRef, Dest: PDFString.of('legacy-section') })
  const childRef = doc.context.register(child)
  chapter.set(key('First'), childRef)
  chapter.set(key('Last'), childRef)
  const external = doc.context.obj({
    Title: PDFString.of('External link'), Parent: rootRef, Prev: chapterRef,
    A: { S: key('URI'), URI: PDFString.of('https://example.com/document') }, C: [0.8, 0, 0], F: 2,
  })
  const externalRef = doc.context.register(external)
  const named = doc.context.obj({
    Title: PDFString.of('Named GoTo action'), Parent: rootRef, Prev: externalRef,
    A: { S: key('GoTo'), D: PDFHexString.fromText('tree-section'), VendorActionFlag: 17 },
  })
  const namedRef = doc.context.register(named)
  chapter.set(key('Next'), externalRef)
  external.set(key('Next'), namedRef)
  root.set(key('First'), chapterRef)
  root.set(key('Last'), namedRef)
  doc.catalog.set(key('Outlines'), rootRef)
  doc.catalog.set(key('Dests'), doc.context.obj({ 'legacy-section': { D: [doc.getPage(1).ref, key('FitH'), 550] } }))
  doc.catalog.set(key('Names'), doc.context.obj({ Dests: {
    Kids: [doc.context.register(doc.context.obj({ Names: [PDFHexString.fromText('tree-section'), [doc.getPage(2).ref, key('Fit')]] }))],
  } }))
  doc.catalog.set(key('UnrelatedData'), doc.context.obj({ Keep: PDFString.of('catalog sentinel') }))
  return { bytes: await save(doc), rootRef, chapterRef, childRef, externalRef, namedRef }
}

test('empty outlines accept nested Unicode bookmarks and keep caller identities after save and reopen', async () => {
  const source = await PDFDocument.create()
  source.addPage([400, 600]); source.addPage([400, 600])
  const bytes = await save(source)
  assert.deepEqual((await loadPdfDocument(bytes)).outline, [])
  const written = await applyPdfOperations(bytes, [
    { type: 'outline-add', id: 'chapter', title: '  中文章名 😀  ', page: 1 },
    { type: 'outline-add', id: 'child', title: '第二页', page: 2, parentId: 'chapter' },
    { type: 'outline-add', id: 'first', title: '序言', page: 1, index: 0 },
  ])
  const reopened = await loadPdfDocument(written.bytes)
  assert.deepEqual(reopened.outline, [
    { id: 'first', title: '序言', page: 1, children: [] },
    { id: 'chapter', title: '中文章名 😀', page: 1, children: [{ id: 'child', title: '第二页', page: 2, children: [] }] },
  ])
  assert.deepEqual(written.document.outline, reopened.outline)
  assert.equal(reopened.outlineReadOnlyReason, undefined)
  const doc = await PDFDocument.load(written.bytes)
  const root = doc.catalog.lookup(key('Outlines'), PDFDict)
  assert.equal(root.lookup(key('Count'), PDFNumber).asNumber(), 3)
  const first = root.lookup(key('First'), PDFDict)
  assert.equal(first.lookup(key('DSHPDFOutlineId'), PDFHexString).decodeText(), 'first')
  const dest = first.lookup(key('Dest'), PDFArray)
  assert.equal(dest.get(0).toString(), doc.getPage(0).ref.toString())
  assert.equal(dest.lookup(1, PDFName).decodeText(), 'Fit')
  const renamed = await applyPdfOperations(written.bytes, [{ type: 'outline-update', id: 'child', patch: { title: '保存后改名' } }])
  assert.equal((await loadPdfDocument(renamed.bytes)).outline![1].children[0].title, '保存后改名')
})

test('source object identities and original named destinations, external actions, styles and custom keys survive rename and moves', async () => {
  const f = await fixture()
  const before = await PDFDocument.load(f.bytes)
  const info = await loadPdfDocument(f.bytes)
  assert.equal(info.outlineReadOnlyReason, undefined)
  assert.deepEqual(info.outline!.map(item => [item.id, item.page]), [
    [objectId(f.chapterRef), 1], [objectId(f.externalRef), undefined], [objectId(f.namedRef), 3],
  ])
  assert.equal(info.outline![0].children[0].page, 2)
  const result = await applyPdfOperations(f.bytes, [
    { type: 'outline-update', id: objectId(f.chapterRef), patch: { title: '新的章节名称' } },
    { type: 'outline-move', id: objectId(f.childRef), parentId: objectId(f.externalRef), index: 0 },
    { type: 'outline-move', id: objectId(f.externalRef), index: 0 },
  ])
  const reopened = await loadPdfDocument(result.bytes)
  assert.deepEqual(reopened.outline!.map(item => item.id), [objectId(f.externalRef), objectId(f.chapterRef), objectId(f.namedRef)])
  assert.equal(reopened.outline![0].children[0].id, objectId(f.childRef))
  assert.equal(reopened.outline![1].title, '新的章节名称')
  const after = await PDFDocument.load(result.bytes)
  for (const [ref, fields] of [
    [f.chapterRef, ['Dest', 'C', 'F', 'VendorValue']],
    [f.childRef, ['Dest']],
    [f.externalRef, ['A', 'C', 'F']],
    [f.namedRef, ['A']],
  ] as const) {
    for (const field of fields) assert.equal(dictionary(after, ref).get(key(field))!.toString(), dictionary(before, ref).get(key(field))!.toString())
  }
  assert.equal(after.catalog.get(key('UnrelatedData'))!.toString(), before.catalog.get(key('UnrelatedData'))!.toString())
  assert.equal(dictionary(after, f.childRef).get(key('Parent'))!.toString(), f.externalRef.toString())
  assert.equal(dictionary(after, f.chapterRef).has(key('First')), false)
  assert.equal(dictionary(after, f.chapterRef).has(key('Last')), false)
  assert.equal(dictionary(after, f.chapterRef).has(key('Count')), false)
})

test('editing a destination replaces only its target with a local Fit destination', async () => {
  const f = await fixture()
  const result = await applyPdfOperations(f.bytes, [
    { type: 'outline-update', id: objectId(f.namedRef), patch: { page: 4 } },
    { type: 'outline-update', id: objectId(f.chapterRef), patch: { title: '保留XYZ目标' } },
  ])
  const reopened = await loadPdfDocument(result.bytes)
  assert.equal(reopened.outline![2].page, 4)
  const doc = await PDFDocument.load(result.bytes)
  const changed = dictionary(doc, f.namedRef)
  assert.equal(changed.has(key('A')), false)
  const dest = changed.lookup(key('Dest'), PDFArray)
  assert.equal(dest.get(0).toString(), doc.getPage(3).ref.toString())
  assert.equal(dest.lookup(1, PDFName).decodeText(), 'Fit')
  const unchanged = dictionary(doc, f.chapterRef).lookup(key('Dest'), PDFArray)
  assert.equal(unchanged.lookup(1, PDFName).decodeText(), 'XYZ')
  assert.equal(unchanged.lookup(4, PDFNumber).asNumber(), 1.5)
  assert.equal(dictionary(doc, f.chapterRef).lookup(key('Count'), PDFNumber).asNumber(), -1)
})

test('deleting a subtree updates the outline links and counts; an emptied tree remains editable', async () => {
  const f = await fixture()
  const written = await applyPdfOperations(f.bytes, [{ type: 'outline-delete', id: objectId(f.chapterRef) }])
  const reopened = await loadPdfDocument(written.bytes)
  assert.deepEqual(flatten(reopened.outline!).map(item => item.id), [objectId(f.externalRef), objectId(f.namedRef)])
  const doc = await PDFDocument.load(written.bytes)
  assert.equal(dictionary(doc, f.externalRef).has(key('Prev')), false)
  assert.equal(dictionary(doc, f.rootRef).get(key('First'))!.toString(), f.externalRef.toString())
  assert.equal(dictionary(doc, f.rootRef).lookup(key('Count'), PDFNumber).asNumber(), 2)
  const empty = await applyPdfOperations(written.bytes, [
    { type: 'outline-delete', id: objectId(f.externalRef) }, { type: 'outline-delete', id: objectId(f.namedRef) },
  ])
  assert.deepEqual((await loadPdfDocument(empty.bytes)).outline, [])
  const emptyDoc = await PDFDocument.load(empty.bytes)
  const root = emptyDoc.catalog.lookup(key('Outlines'), PDFDict)
  assert.equal(root.has(key('First')), false)
  assert.equal(root.has(key('Last')), false)
  assert.equal(root.lookup(key('Count'), PDFNumber).asNumber(), 0)
  const again = await applyPdfOperations(empty.bytes, [{ type: 'outline-add', id: 'again', title: '重新添加', page: 2 }])
  assert.equal((await loadPdfDocument(again.bytes)).outline![0].id, 'again')
})

test('structural edits preserve collapsed branches and recompute visible descendant counts', async () => {
  const f = await fixture()
  const result = await applyPdfOperations(f.bytes, [
    { type: 'outline-add', id: 'nested', title: 'Collapsed descendant', page: 3, parentId: objectId(f.childRef) },
  ])
  const doc = await PDFDocument.load(result.bytes)
  assert.equal(dictionary(doc, f.rootRef).lookup(key('Count'), PDFNumber).asNumber(), 3)
  assert.equal(dictionary(doc, f.chapterRef).lookup(key('Count'), PDFNumber).asNumber(), -2)
  assert.equal(dictionary(doc, f.childRef).lookup(key('Count'), PDFNumber).asNumber(), 1)
  assert.equal((await loadPdfDocument(result.bytes)).outline![0].children[0].children[0].id, 'nested')
})

test('outline edits share one materialization with annotations and form values', async () => {
  const source = await PDFDocument.create()
  const page = source.addPage([400, 600])
  const field = source.getForm().createTextField('name')
  field.setText('Original')
  field.addToPage(page, { x: 20, y: 400, width: 180, height: 25 })
  const result = await applyPdfOperations(await save(source), [
    { type: 'outline-add', id: 'section', title: 'Form section', page: 1 },
    { type: 'set-field', name: 'name', value: 'Alice' },
    { type: 'add', annotation: { id: 'note', page: 1, subtype: 'Text', rect: [10, 10, 30, 30], contents: 'Same save' } },
  ])
  const reopened = await loadPdfDocument(result.bytes)
  assert.equal(reopened.outline![0].id, 'section')
  assert.equal(reopened.formFields!.find(field => field.name === 'name')!.value, 'Alice')
  assert.equal(reopened.annotations.find(item => item.id === 'note')!.contents, 'Same save')
  assert.deepEqual(result.document.outline, reopened.outline)
  // Exercise the full metadata refresh branch again after reopening, with the
  // three kinds deliberately interleaved and an existing outline identity.
  const modified = await applyPdfOperations(result.bytes, [
    { type: 'set-field', name: 'name', value: 'Bob' },
    { type: 'outline-update', id: 'section', patch: { title: 'Renamed form section', page: 1 } },
    { type: 'delete', id: 'note' },
    { type: 'outline-add', id: 'child', title: 'New nested form bookmark', page: 1, parentId: 'section' },
  ])
  const reread = await loadPdfDocument(modified.bytes)
  assert.deepEqual(modified.document, reread)
  assert.equal(reread.outline![0].title, 'Renamed form section')
  assert.equal(reread.outline![0].children[0].id, 'child')
  assert.equal(reread.formFields!.find(field => field.name === 'name')!.value, 'Bob')
  assert.equal(reread.annotations.some(item => item.id === 'note'), false)
  assert.equal(reread.annotations.filter(item => item.subtype === 'Widget').length, 1)
  assert.equal(reread.outline![0].targetChanged, undefined)
})

test('long imported titles are retained when moving an unrenamed original node', async () => {
  const f = await fixture()
  const source = await PDFDocument.load(f.bytes)
  const long = '原始'.repeat(800)
  dictionary(source, f.namedRef).set(key('Title'), PDFHexString.fromText(long))
  const result = await applyPdfOperations(await save(source), [
    { type: 'outline-move', id: objectId(f.namedRef), index: 0 },
  ])
  assert.equal((await loadPdfDocument(result.bytes)).outline![0].title, long)
})

test('broken cyclic outlines disable only outline editing, while normal PDF annotation writes preserve the original graph', async () => {
  const f = await fixture()
  const editableInfo = await loadPdfDocument(f.bytes)
  const source = await PDFDocument.load(f.bytes)
  dictionary(source, f.namedRef).set(key('Next'), f.chapterRef)
  const bytes = await save(source)
  const info = await loadPdfDocument(bytes)
  assert.equal(info.readOnly, false)
  assert.match(info.outlineReadOnlyReason!, /cycle|shared/)
  assert.deepEqual(info.outline, [])
  assert.throws(() => applyOutlineOperations(source, editableInfo, [{ type: 'outline-add', id: 'new', title: 'New', page: 1 }]),
    { code: 'outline-read-only' })
  await assert.rejects(applyPdfOperations(bytes, [{ type: 'outline-add', id: 'new', title: 'New', page: 1 }]), { code: 'outline-read-only' })
  const annotated = await applyPdfOperations(bytes, [{ type: 'add', annotation: {
    id: 'note', page: 1, subtype: 'Text', rect: [10, 10, 30, 30], contents: '普通批注仍可保存',
  } }])
  assert.equal(annotated.document.annotations[0].contents, '普通批注仍可保存')
  const written = await PDFDocument.load(annotated.bytes)
  assert.equal(dictionary(written, f.namedRef).get(key('Next'))!.toString(), f.chapterRef.toString())
  assert.match((await loadPdfDocument(annotated.bytes)).outlineReadOnlyReason!, /cycle|shared/)
})

test('direct nodes and duplicate persisted identities are reported without blocking the PDF', async () => {
  for (const kind of ['direct', 'identity'] as const) {
    const f = await fixture()
    const doc = await PDFDocument.load(f.bytes)
    if (kind === 'direct') dictionary(doc, f.rootRef).set(key('First'), dictionary(doc, f.chapterRef))
    else {
      dictionary(doc, f.chapterRef).set(key('DSHPDFOutlineId'), PDFString.of('duplicate'))
      dictionary(doc, f.namedRef).set(key('DSHPDFOutlineId'), PDFString.of('duplicate'))
    }
    const info = await loadPdfDocument(await save(doc))
    assert.equal(info.readOnly, false)
    assert.ok(info.outlineReadOnlyReason, kind)
  }
})

test('recoverable backlinks do not disable editing or mutate objects during inspection', async () => {
  const bytes = await recoverableOutlineFixture()
  const doc = await PDFDocument.load(bytes)
  const objects = () => doc.context.enumerateIndirectObjects().map(([ref, value]) => [ref.toString(), value.toString()])
  const before = objects()
  const info = inspectOutlines(doc)
  assert.equal(info.outlineReadOnlyReason, undefined)
  assert.deepEqual(info.outline!.map(item => [item.title, item.page]), [['Imported chapter', 1], ['Reference', undefined]])
  assert.deepEqual(info.outline![0].children.map(item => [item.title, item.page]), [['Imported section', 2]])
  assert.deepEqual(objects(), before, 'opening and inspection are read-only')

  // Ordinary annotation saves must not silently repair somebody else's outline.
  const annotated = await applyPdfOperations(bytes, [{ type: 'add', annotation: {
    id: 'note', page: 1, subtype: 'Text', rect: [10, 10, 30, 30], contents: 'Unrelated edit',
  } }])
  const after = await PDFDocument.load(annotated.bytes)
  for (const [ref, value] of doc.context.enumerateIndirectObjects()) {
    if (!(value instanceof PDFDict) || !value.has(key('Title')) && value !== doc.catalog.lookup(key('Outlines'))) continue
    assert.equal(after.context.lookup(ref)!.toString(), value.toString())
  }
})

test('a title-only outline edit repairs derived links and preserves exact destinations, style and collapse state', async () => {
  const bytes = await recoverableOutlineFixture()
  const original = await PDFDocument.load(bytes)
  const before = await loadPdfDocument(bytes)
  const chapter = before.outline![0], child = chapter.children[0], external = before.outline![1]
  const result = await applyPdfOperations(bytes, [{ type: 'outline-update', id: child.id, patch: { title: 'Renamed section' } }])
  const reopened = await loadPdfDocument(result.bytes)
  assert.equal(reopened.outlineReadOnlyReason, undefined)
  assert.deepEqual(flatten(reopened.outline!).map(item => item.id), flatten(before.outline!).map(item => item.id))
  assert.equal(reopened.outline![0].children[0].title, 'Renamed section')
  const doc = await PDFDocument.load(result.bytes)
  const rootRef = doc.catalog.get(key('Outlines'))!
  const root = doc.context.lookup(rootRef, PDFDict)
  const chapterRef = root.get(key('First')) as PDFRef
  const chapterDict = dictionary(doc, chapterRef)
  const childRef = chapterDict.get(key('First')) as PDFRef
  const externalRef = chapterDict.get(key('Next')) as PDFRef
  assert.equal(root.get(key('Last')), externalRef)
  assert.equal(root.lookup(key('Count'), PDFNumber).asNumber(), 2)
  assert.equal(chapterDict.get(key('Parent')), rootRef)
  assert.equal(chapterDict.has(key('Prev')), false)
  assert.equal(chapterDict.get(key('Last')), childRef)
  assert.equal(chapterDict.lookup(key('Count'), PDFNumber).asNumber(), -1)
  assert.equal(dictionary(doc, childRef).get(key('Parent')), chapterRef)
  assert.equal(dictionary(doc, childRef).has(key('Prev')), false)
  assert.equal(dictionary(doc, externalRef).get(key('Parent')), rootRef)
  assert.equal(dictionary(doc, externalRef).get(key('Prev')), chapterRef)
  for (const [ref, fields] of [[chapterRef, ['Dest', 'C', 'F']], [childRef, ['Dest']], [externalRef, ['A']]] as const) {
    for (const field of fields) assert.equal(dictionary(doc, ref).get(key(field))!.toString(), dictionary(original, ref).get(key(field))!.toString())
  }
  assert.equal(objectId(chapterRef), chapter.id)
  assert.equal(objectId(externalRef), external.id)
})

test('missing derived links are recoverable but incomplete forward trees, shared nodes and invalid references are not', async () => {
  for (const kind of ['parent', 'prev', 'last', 'first', 'shared', 'missing-next', 'broken-next', 'orphan-prev', 'ambiguous-last'] as const) {
    const f = await fixture()
    const doc = await PDFDocument.load(f.bytes)
    if (kind === 'parent') dictionary(doc, f.childRef).delete(key('Parent'))
    if (kind === 'prev') dictionary(doc, f.externalRef).delete(key('Prev'))
    if (kind === 'last') dictionary(doc, f.chapterRef).delete(key('Last'))
    if (kind === 'first') dictionary(doc, f.chapterRef).delete(key('First'))
    if (kind === 'shared') {
      dictionary(doc, f.namedRef).set(key('First'), f.childRef)
      dictionary(doc, f.namedRef).set(key('Last'), f.childRef)
    }
    if (kind === 'missing-next') dictionary(doc, f.namedRef).set(key('Next'), PDFRef.of(100000))
    if (kind === 'broken-next') dictionary(doc, f.chapterRef).delete(key('Next'))
    if (kind === 'orphan-prev') dictionary(doc, f.chapterRef).set(key('Prev'), doc.context.register(doc.context.obj({ Title: PDFString.of('Unreachable bookmark') })))
    if (kind === 'ambiguous-last') {
      const alias = dictionary(doc, f.childRef).clone()
      alias.set(key('Dest'), doc.context.obj([doc.getPage(3).ref, key('Fit')]))
      dictionary(doc, f.chapterRef).set(key('Last'), doc.context.register(alias))
    }
    const bytes = await save(doc)
    const info = await loadPdfDocument(bytes)
    assert.equal(info.readOnly, false)
    if (kind === 'parent' || kind === 'prev' || kind === 'last') {
      assert.equal(info.outlineReadOnlyReason, undefined, kind)
      const written = await applyPdfOperations(bytes, [{ type: 'outline-add', id: 'new', title: 'New child', page: 2, parentId: objectId(f.chapterRef) }])
      assert.equal((await loadPdfDocument(written.bytes)).outline![0].children.length, 2)
    } else {
      assert.ok(info.outlineReadOnlyReason, kind)
      await assert.rejects(applyPdfOperations(bytes, [{ type: 'outline-add', id: 'new', title: 'New', page: 1 }]), { code: 'outline-read-only' })
    }
  }
})

test('an unreachable duplicate is recoverable only when all payload and forward-link fields match', async () => {
  for (const changed of [undefined, 'Title', 'Dest', 'C', 'F', 'VendorValue', 'First', 'Next'] as const) {
    const f = await fixture(), doc = await PDFDocument.load(f.bytes)
    const last = dictionary(doc, f.namedRef)
    // Include a real child link so comparing just title/destination is not enough.
    const child = doc.context.register(doc.context.obj({ Title: PDFString.of('Nested'), Parent: f.namedRef,
      Dest: [doc.getPage(3).ref, key('Fit')] }))
    last.set(key('First'), child); last.set(key('Last'), child); last.set(key('Count'), PDFNumber.of(1))
    const duplicate = last.clone()
    if (changed) duplicate.set(key(changed), PDFString.of('different payload'))
    dictionary(doc, f.rootRef).set(key('Last'), doc.context.register(duplicate))
    const bytes = await save(doc), info = await loadPdfDocument(bytes)
    if (changed) assert.match(info.outlineReadOnlyReason!, /missing from its forward tree/, changed)
    else {
      assert.equal(info.outlineReadOnlyReason, undefined)
      const written = await applyPdfOperations(bytes, [{ type: 'outline-update', id: objectId(f.namedRef), patch: { title: 'Repaired' } }])
      const reopened = await PDFDocument.load(written.bytes)
      assert.equal(dictionary(reopened, f.rootRef).get(key('Last'))!.toString(), f.namedRef.toString())
      assert.equal((await loadPdfDocument(written.bytes)).outline![2].children[0].title, 'Nested')
    }
  }
})

test('a rejected outline batch does not mutate the source and deleted identities may be freshly re-added', async () => {
  const f = await fixture()
  const baseline = f.bytes.slice()
  await assert.rejects(applyPdfOperations(f.bytes, [
    { type: 'outline-update', id: objectId(f.chapterRef), patch: { title: 'Must not escape' } },
    { type: 'outline-update', id: 'missing', patch: { title: 'Invalid' } },
  ]), { code: 'unknown-outline' })
  assert.deepEqual(f.bytes, baseline)
  assert.equal((await loadPdfDocument(f.bytes)).outline![0].title, '章节一')
  const replaced = await applyPdfOperations(f.bytes, [
    { type: 'outline-delete', id: objectId(f.chapterRef) },
    { type: 'outline-add', id: objectId(f.chapterRef), title: 'New item with former identity', page: 4 },
  ])
  const reopened = await loadPdfDocument(replaced.bytes)
  assert.equal(reopened.outline![2].id, objectId(f.chapterRef))
  assert.equal(reopened.outline![2].page, 4)
  assert.deepEqual(reopened.outline![2].children, [])
})
