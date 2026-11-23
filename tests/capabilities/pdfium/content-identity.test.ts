import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { inspectFixturePdf, materializeFixturePdf } from '../../fixtures/native-document.ts'
import { classicPdf } from '../../fixtures/plain-pdf.ts'

const pageProgram = 'q 0 0 1 rg 10 20 30 40 re f Q\n'

function stream(program: string, options: { level?: number; filter?: string; params?: string } = {}) {
  const { level, filter, params } = options
  const bytes = level === undefined ? program : deflateSync(Buffer.from(program, 'latin1'), { level }).toString('latin1')
  const encoding = filter ?? (level === undefined ? '' : '/FlateDecode')
  return `<< /Length ${bytes.length}${encoding ? ` /Filter ${encoding}` : ''}${params ? ` /DecodeParms ${params}` : ''} >>\nstream\n${bytes}\nendstream`
}

interface Fixture {
  catalog?: string
  pages?: string[]
  inherited?: string
  objects?: string[]
  info?: number
}

function fixture({ catalog = '', pages = ['/Contents 4 0 R'], inherited = '', objects = [stream(pageProgram)],
  info }: Fixture = {}): Uint8Array {
  return classicPdf([
    `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${index + 3} 0 R`).join(' ')}] /Count ${pages.length} /MediaBox [0 0 400 600] ${inherited} >>`,
    ...pages.map(attributes => `<< /Type /Page /Parent 2 0 R ${attributes} >>`),
    ...objects,
  ], info)
}

async function identity(bytes: Uint8Array) {
  const { indexContentDigest, indexPageDigests } = await inspectFixturePdf(bytes)
  return { indexContentDigest, indexPageDigests }
}

test('annotation, comment, note and bookmark edits retain the same indexed page identity after reopening', async () => {
  const source = fixture(), original = await identity(source)
  assert.match(original.indexContentDigest!, /^sha256:[a-f0-9]{64}$/)
  assert.match(original.indexPageDigests![0]!, /^sha256:[a-f0-9]{64}$/)
  const added = await materializeFixturePdf(source, [
    { type: 'add', annotation: { id: 'highlight', page: 1, subtype: 'Highlight', rect: [10, 20, 80, 40],
      quadPoints: [10, 40, 80, 40, 10, 20, 80, 20], contents: 'Comment one', color: [1, 1, 0] } },
    { type: 'add', annotation: { id: 'note', page: 1, subtype: 'Text', rect: [150, 150, 180, 180], contents: 'A note' } },
    { type: 'outline-add', id: 'chapter', title: 'Chapter one', page: 1 },
  ])
  assert.notDeepEqual(added.bytes, source)
  assert.deepEqual(await identity(added.bytes), original)
  const edited = await materializeFixturePdf(added.bytes, [
    { type: 'update', id: 'highlight', patch: { contents: 'Revised', color: [0, 1, 0], commentPosition: [200, 200] } },
    { type: 'update', id: 'note', patch: { contents: 'Moved', rect: [200, 100, 250, 150] } },
    { type: 'outline-update', id: 'chapter', patch: { title: 'Renamed' } },
  ])
  assert.deepEqual(await identity(edited.bytes), original)
  const removed = await materializeFixturePdf(edited.bytes, [
    { type: 'delete', id: 'highlight' }, { type: 'delete', id: 'note' }, { type: 'outline-delete', id: 'chapter' },
  ])
  assert.deepEqual(await identity(removed.bytes), original)
})

test('program changes and unsafe resource graphs invalidate only their page fingerprint', async () => {
  const two = (second: string) => fixture({
    pages: ['/Contents 5 0 R', second],
    objects: [stream(pageProgram), stream('q 1 0 0 rg 10 20 30 40 re f Q\n'), '<< /Loop 7 0 R >>'],
  })
  const baseline = await identity(two('/Contents 5 0 R'))
  assert.equal(baseline.indexPageDigests![0], baseline.indexPageDigests![1])
  const changed = await identity(two('/Contents 6 0 R'))
  assert.equal(changed.indexPageDigests![0], baseline.indexPageDigests![0])
  assert.notEqual(changed.indexPageDigests![1], baseline.indexPageDigests![1])
  assert.notEqual(changed.indexContentDigest, baseline.indexContentDigest)
  assert.deepEqual(await identity(two('/Contents 5 0 R /Resources << /Properties << /Cycle 7 0 R >> >>')), {
    indexContentDigest: undefined, indexPageDigests: [baseline.indexPageDigests![0], null],
  })
})

test('rewritten metadata, external annotations and recompressed streams retain indexed content identity', async () => {
  const baseline = await identity(fixture())
  for (const level of [1, 9]) {
    const rewritten = fixture({
      pages: ['/Contents [5 0 R] /Annots [6 0 R]'],
      inherited: '/Resources << /Font << >> /ExtGState << >> /XObject << >> /ProcSet [/PDF /Text] >>',
      catalog: '/Metadata 7 0 R',
      objects: [
        '(unreachable)', stream(pageProgram, { level }),
        '<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (External comment) >>',
        stream('<xmp>external metadata</xmp>'), '<< /Title (Different title) >>',
      ],
      info: 8,
    })
    assert.deepEqual(await identity(rewritten), baseline)
  }
  assert.deepEqual(await identity(fixture({ objects: [stream(pageProgram, { level: 6, filter: '[/FlateDecode]', params: '[null]' })] })), baseline)
})

test('PDF page programs normalize only safe standalone outer q/Q wrapper streams', async () => {
  for (const program of [
    pageProgram,
    'BT (nested (q Q) and escaped \\(Q\\)) Tj ET\n',
    'BT <712051> Tj ET\n',
    '/q /Q /escaped#20Q MP\n',
    '% q Q\nq\nQ\n% terminated comment\n',
    '[(q Q) 5] TJ\n',
    '/Span << /ActualText (q Q) >> BDC EMC\n',
    '',
  ]) {
    const baseline = await identity(fixture({ objects: [stream(program)] }))
    const wrapped = fixture({ pages: ['/Contents [4 0 R 5 0 R 6 0 R]'],
      objects: [stream('q\n', { level: 9 }), stream(program), stream('Q\n', { level: 9 })] })
    assert.deepEqual(await identity(wrapped), baseline, program)
  }
})

test('unbalanced programs, malformed operands, inline images, unknown operators and trailing comments remain distinct', async () => {
  for (const program of [
    'Q\n', 'q\n', 'BI /W 1 /H 1 ID q Q EI\n', 'unknownOperator\n',
    'q Q % consumes Q', '(unclosed q', '(trailing escape \\', '<71', '<7z>', '[', '<<', '>', '[>>', '<< /x 1 >', '{', ')',
  ]) {
    const baseline = await identity(fixture({ objects: [stream(program)] }))
    const wrapped = fixture({ pages: ['/Contents [4 0 R 5 0 R 6 0 R]'],
      objects: [stream('q\n'), stream(program), stream('Q\n')] })
    assert.notEqual((await identity(wrapped)).indexContentDigest, baseline.indexContentDigest, program)
  }
  const baseline = await identity(fixture())
  for (const opening of [
    stream('q\n', { params: '<< /Predictor 2 >>' }),
    stream('q\n', { filter: '/UnknownFilter' }),
    stream(' '.repeat(200) + 'q\n'), stream('n\n'),
  ]) {
    const wrapped = fixture({ pages: ['/Contents [4 0 R 5 0 R 6 0 R]'],
      objects: [opening, stream(pageProgram), stream('Q\n')] })
    assert.notEqual((await identity(wrapped)).indexContentDigest, baseline.indexContentDigest)
  }
})

test('equal resource data remains reusable through object renumbering and literal/hex normalization', async () => {
  const first = fixture({ pages: ['/Contents 4 0 R /Resources << /Properties << /First 5 0 R /Second 5 0 R >> >>'],
    objects: [stream(pageProgram), '<< /Count 2 /Text (Hello) /Flag true >>'] })
  const second = fixture({ pages: ['/Contents 5 0 R /Resources << /Properties << /Second 6 0 R /First 7 0 R >> >>'],
    objects: ['(padding)', stream(pageProgram), '<< /Flag true /Text <48656c6c6f> /Count 2 >>',
      '<< /Count 2 /Flag true /Text (Hello) >>'] })
  assert.deepEqual(await identity(first), await identity(second))
})

test('geometry, resource, visibility and output-intent changes affect the expected page identities', async () => {
  const baseline = await identity(fixture())
  for (const attributes of ['/MediaBox [0 0 500 600]', '/CropBox [10 10 300 400]', '/Rotate 90', '/UserUnit 2',
    '/Group << /S /Transparency /I true >>', '/Resources << /Properties << /Custom (resource) >> >>']) {
    assert.notEqual((await identity(fixture({ pages: [`/Contents 4 0 R ${attributes}`] }))).indexContentDigest,
      baseline.indexContentDigest, attributes)
  }
  const pages = ['/Contents 5 0 R', '/Contents 5 0 R']
  const objects = [stream(pageProgram)]
  const both = await identity(fixture({ pages, objects }))
  for (const catalog of ['/OCProperties << /D << /BaseState /OFF >> >>',
    '/OutputIntents [<< /S /GTS_PDFA1 /OutputConditionIdentifier (New output intent) >>]']) {
    const changed = await identity(fixture({ catalog, pages, objects }))
    assert.equal(changed.indexPageDigests?.length, 2)
    assert.ok(changed.indexPageDigests?.every((digest, index) => digest && digest !== both.indexPageDigests?.[index]))
  }
})

test('identical optional-content dictionaries retain distinct visibility membership', async () => {
  const withGroup = (group: number, catalog = '/OCProperties << /OCGs [5 0 R 6 0 R] /D << /ON [5 0 R] /OFF [6 0 R] >> >>') =>
    fixture({ catalog, pages: [`/Contents 4 0 R /Resources << /Properties << /Layer ${group} 0 R >> >>`],
      objects: [stream('/OC /Layer BDC 0 0 10 10 re f EMC'), ...Array(2).fill('<< /Type /OCG /Name (Same label) >>')] })
  const visible = await identity(withGroup(5)), hidden = await identity(withGroup(6))
  assert.ok(visible.indexContentDigest && hidden.indexContentDigest)
  assert.notEqual(visible.indexContentDigest, hidden.indexContentDigest)
  assert.equal((await identity(withGroup(5, ''))).indexContentDigest, undefined)
})

test('opaque image filters retain bytes and decode parameters in their fingerprint', async () => {
  const image = (params: string) => fixture({
    pages: ['/Contents 4 0 R /Resources << /XObject << /Image 5 0 R >> >>'],
    objects: [stream('/Image Do'), stream('image data', { filter: '/DCTDecode', params })],
  })
  assert.notEqual((await identity(image('<< /ColorTransform 0 >>'))).indexContentDigest,
    (await identity(image('<< /ColorTransform 1 >>'))).indexContentDigest)
})

test('malformed Flate, unsupported resources, broken references and document backlinks fall back safely', async () => {
  for (const [reason, bytes] of [
    ['invalid compressed data', fixture({ objects: [stream('invalid compressed data', { filter: '/FlateDecode' })] })],
    ['unknown resource', fixture({ pages: ['/Contents 4 0 R /Resources << /Unknown (unsupported) >>'] })],
    ['broken reference', fixture({ pages: ['/Contents 4 0 R /Group 99999 0 R'] })],
    ['document backlink', fixture({ pages: ['/Contents 4 0 R /Resources << /Properties << /Backlink 1 0 R >> >>'] })],
  ] as const) {
    const info = await inspectFixturePdf(bytes)
    assert.equal(info.pageCount, 1)
    assert.equal(info.indexContentDigest, undefined, reason)
  }
})
