import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createNativeDocumentPort } from '../src/adapters/host/pdfium/document-port.js'
import { NativeWorker } from '../src/engine/host/native-worker.js'
import { readNativeSavedBytes } from '../src/adapters/host/pdfium/save-bytes.js'
import type { PdfWorkingCopyOperation } from '../src/core/pdf-types.js'
import { NativeTestSubprocess } from './native-test-subprocess.js'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const required = process.env.DSH_PDF_REQUIRE_NATIVE_EXTENSIONS === '1'
const skip = !required && !existsSync(executable)

async function nativeWorker(t: TestContext) {
  const worker = new NativeWorker(executable, new NativeTestSubprocess())
  t.after(() => worker.dispose())
  await worker.ready()
  if (!worker.documentExtensions && !required) {
    t.skip('Native helper does not expose PDFium extensions')
    return undefined
  }
  assert.equal(worker.documentExtensions, true)
  return worker
}

type PdfObject = readonly [generation: number, body: string]
type XrefKind = 'table' | 'stream'

function fixture(objects: readonly PdfObject[], trailer: string, xrefKind: XrefKind = 'table'): Buffer {
  let pdf = '%PDF-1.7\n'
  const entries = [{ offset: 0, generation: 65535 }]
  for (const [index, [generation, body]] of objects.entries()) {
    entries.push({ offset: pdf.length, generation })
    pdf += `${index + 1} ${generation} obj\n${body}\nendobj\n`
  }
  const startXref = pdf.length
  if (xrefKind === 'table') {
    pdf += `xref\n0 ${entries.length}\n0000000000 65535 f \n`
    for (const { offset, generation } of entries.slice(1)) {
      pdf += `${String(offset).padStart(10, '0')} ${String(generation).padStart(5, '0')} n \n`
    }
    pdf += `trailer\n<< /Size ${entries.length} ${trailer} >>\n`
  } else {
    const xrefNumber = entries.length
    entries.push({ offset: startXref, generation: 0 })
    const data = Buffer.alloc(entries.length * 7)
    for (const [number, { offset, generation }] of entries.entries()) {
      const index = number * 7
      data.writeUInt8(number === 0 ? 0 : 1, index)
      data.writeUInt32BE(offset, index + 1)
      data.writeUInt16BE(generation, index + 5)
    }
    pdf += `${xrefNumber} 0 obj\n<< /Type /XRef /W [1 4 2] /Size ${entries.length} /Length ${data.length} ${trailer} >>\n`
    pdf += `stream\n${data.toString('latin1')}\nendstream\nendobj\n`
  }
  return Buffer.from(`${pdf}startxref\n${startXref}\n%%EOF\n`, 'latin1')
}

function assertSavedGenerations(bytes: Uint8Array, expected: ReadonlyMap<number, number>): string {
  const pdf = Buffer.from(bytes).toString('latin1')
  const startXref = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(pdf)
  assert.ok(startXref)
  const xref = pdf.slice(Number(startXref[1])).split(/\r?\n/)
  assert.equal(xref.shift(), 'xref')
  const found = new Map<number, number>()
  let index = 0
  while (xref[index] !== 'trailer') {
    const section = /^(\d+)\s+(\d+)$/.exec(xref[index++] ?? '')
    assert.ok(section, 'valid xref subsection')
    const start = Number(section[1])
    for (let offset = 0; offset < Number(section[2]); offset++) {
      const row = /^(\d{10}) (\d{5}) ([fn])\s*$/.exec(xref[index++] ?? '')
      assert.ok(row, 'valid xref entry')
      if (row[3] === 'f') continue
      const objectNumber = start + offset
      const generation = Number(row[2])
      assert.ok(pdf.slice(Number(row[1])).startsWith(`${objectNumber} ${generation} obj`),
        `xref points to the header for object ${objectNumber} generation ${generation}`)
      found.set(objectNumber, generation)
    }
  }
  for (const [objectNumber, generation] of expected) {
    assert.equal(found.get(objectNumber), generation, `retains generation of object ${objectNumber}`)
  }
  return pdf
}

const mixedObjects: readonly PdfObject[] = [
  [11, '<< /Type /Catalog /Pages 2 7 R /Outlines 4 12 R /AcroForm 6 28 R >>'],
  [7, '<< /Type /Pages /Kids [3 5 R] /Count 1 >>'],
  [5, '<< /Type /Page /Parent 2 7 R /MediaBox [0 0 200 300] /Annots [7 513 R 8 17 R] >>'],
  [12, '<< /Type /Outlines /First 5 233 R /Last 5 233 R /Count 1 >>'],
  [233, '<< /Title (Imported) /Parent 4 12 R /Dest [3 5 R /Fit] >>'],
  [28, '<< /Fields [7 513 R] /DR << /Font << /Helv 9 0 R >> >> /DA (/Helv 12 Tf 0 g) >>'],
  [513, '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /V (Before) /P 3 5 R /Rect [20 100 180 126] /DA (/Helv 12 Tf 0 g) /F 4 >>'],
  [17, '<< /Type /Annot /Subtype /Text /Rect [20 10 40 30] /P 3 5 R /Contents (Original) /C [1 1 0] /F 4 >>'],
  [0, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'],
  [256, '<< /Title (Object generations) >>'],
]
const mixedGenerations = new Map(mixedObjects.map(([generation], index) => [index + 1, generation]))

for (const xrefKind of ['table', 'stream'] as const) {
  test(`native full save preserves nonzero field, outline and annotation generations from an xref ${xrefKind}`, { skip }, async t => {
    if (!await nativeWorker(t)) return
    const port = createNativeDocumentPort(executable, new NativeTestSubprocess())
    t.after(() => port.dispose())
    const source = fixture(mixedObjects, '/Root 1 11 R /Info 10 256 R', xrefKind)
    const before = await port.inspect(source)
    const bookmark = 'pdf-outline:5:233'
    const field = 'pdf-field:7:513'
    const note = 'ref:8:17'
    assert.equal(before.outline?.[0]?.id, bookmark)
    assert.equal(before.formFields?.find(item => item.id === field)?.value, 'Before')
    assert.equal(before.annotations.find(item => item.id === note)?.contents, 'Original')

    const operations: PdfWorkingCopyOperation[] = [
      { type: 'outline-add', id: 'child', parentId: bookmark, title: 'Child', page: 1 },
      { type: 'set-field', fieldId: field, value: 'After' },
      { type: 'add', annotation: { id: 'reply', replyToId: note, page: 1, subtype: 'Text',
        rect: [45, 10, 65, 30], contents: 'Attached' } },
    ]
    const saved = await port.materialize(source, operations, operations.map(() => '2026-11-09T00:00:00Z'))
    const reopened = await port.inspect(saved.bytes)
    assert.deepEqual(reopened, saved.document)
    assert.equal(reopened.title, 'Object generations')
    assert.equal(reopened.outline?.[0]?.id, bookmark)
    assert.equal(reopened.outline?.[0]?.children[0]?.title, 'Child')
    assert.equal(reopened.formFields?.find(item => item.id === field)?.value, 'After')
    assert.equal(reopened.annotations.find(item => item.id === 'reply')?.replyToId, note)

    const pdf = assertSavedGenerations(saved.bytes, mixedGenerations)
    assert.match(pdf, /\/Root\s+1\s+11\s+R/)
    assert.match(pdf, /\/Info\s+10\s+256\s+R/)
    assert.match(pdf, /\/Parent\s+5\s+233\s+R/)
    assert.match(pdf, /\/IRT\s+8\s+17\s+R/)
  })
}

// Both RC4 and AES-128 include the object's generation in its encryption key.
const passwordPadding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex')
const password = 'fixture-password'
const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest()
const padded = (value: string) => Buffer.concat([Buffer.from(value, 'latin1'), passwordPadding]).subarray(0, 32)
const hex = (value: Buffer) => `<${value.toString('hex')}>`

function rc4(key: Uint8Array, value: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index)
  function swap(i: number, j: number) {
    const first = state[i]!
    state[i] = state[j]!
    state[j] = first
  }
  let j = 0
  for (let i = 0; i < state.length; i++) {
    j = (j + state[i]! + key[i % key.length]!) % state.length
    swap(i, j)
  }
  j = 0
  const result = Buffer.alloc(value.length)
  for (let index = 0; index < value.length; index++) {
    const i = (index + 1) % state.length
    j = (j + state[i]!) % state.length
    swap(i, j)
    result[index] = value[index]! ^ state[(state[i]! + state[j]!) % state.length]!
  }
  return result
}

function strengthenKey(initial: Buffer): Buffer {
  let key = initial
  for (let round = 0; round < 50; round++) key = md5(key)
  return key
}

function rc4Rounds(key: Buffer, initial: Buffer): Buffer {
  let value = initial
  for (let round = 0; round < 20; round++) value = rc4(key.map(byte => byte ^ round), value)
  return value
}

function encryptedFixture(revision: 2 | 4) {
  const id = Buffer.from('bd97fe3f1677588d2ca1aa875976069b', 'hex')
  const ownerHash = md5(padded('fixture-owner'))
  const owner = revision === 4 ? rc4Rounds(strengthenKey(ownerHash), padded(password))
    : rc4(ownerHash.subarray(0, 5), padded(password))
  const permissions = Buffer.alloc(4)
  permissions.writeInt32LE(-4)
  const fileHash = md5(padded(password), owner, permissions, id)
  const fileKey = revision === 4 ? strengthenKey(fileHash) : fileHash.subarray(0, 5)
  const user = revision === 4 ? Buffer.concat([rc4Rounds(fileKey, md5(passwordPadding, id)), Buffer.alloc(16)])
    : rc4(fileKey, passwordPadding)
  const encryption = revision === 4
    ? '/V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF'
    : '/V 1 /R 2 /Length 40'

  function encryptedText(number: number, generation: number, value: string) {
    const identifier = Buffer.alloc(5)
    identifier.writeUIntLE(number, 0, 3)
    identifier.writeUInt16LE(generation, 3)
    if (revision === 2) {
      return hex(rc4(md5(fileKey, identifier).subarray(0, 10), Buffer.from(value, 'latin1')))
    }
    const iv = Buffer.alloc(16, number)
    const cipher = createCipheriv('aes-128-cbc', md5(fileKey, identifier, Buffer.from('sAlT')), iv)
    return hex(Buffer.concat([iv, cipher.update(value, 'latin1'), cipher.final()]))
  }

  return fixture([
    [11, '<< /Type /Catalog /Pages 2 7 R >>'],
    [7, '<< /Type /Pages /Kids [3 5 R] /Count 1 >>'],
    [5, '<< /Type /Page /Parent 2 7 R /MediaBox [0 0 200 300] /Annots [4 513 R] >>'],
    [513, `<< /Type /Annot /Subtype /Text /Rect [20 10 40 30] /Contents ${encryptedText(4, 513, 'Original note')} /F 4 >>`],
    [700, `<< /Filter /Standard ${encryption} /O ${hex(owner)} /U ${hex(user)} /P -4 >>`],
    [17, `<< /Title ${encryptedText(6, 17, 'Protected generations')} >>`],
  ], `/Root 1 11 R /Info 6 17 R /Encrypt 5 700 R /ID [${hex(id)} ${hex(id)}]`)
}

for (const revision of [2, 4] as const) {
  test(`native encrypted save preserves nonzero references and object-key generations for revision ${revision}`, { skip }, async t => {
    const worker = await nativeWorker(t)
    if (!worker) return
    const documentId = 'protected-generations'
    const open = { command: 'open', documentId, password } as const
    const annotations = { command: 'annotations', documentId, pageIndex: 0, offset: 0, limit: 64 } as const
    const security = { command: 'security', documentId } as const
    await worker.request(open, encryptedFixture(revision))
    const before = (await worker.request(security)).value
    assert.equal(before.securityRevision, revision)
    assert.equal((await worker.request(annotations)).value.annotations[0]?.contents, 'Original note')
    const contents = 'Changed protected note'
    await worker.request({ command: 'annotationEdit', documentId, pageIndex: 0, action: 'update',
      annotationIndex: 0, patch: { contents } })
    const saved = await readNativeSavedBytes(worker, documentId, new AbortController().signal)
    const pdf = assertSavedGenerations(saved, new Map([[1, 11], [2, 7], [3, 5], [4, 513], [5, 700], [6, 17]]))
    assert.match(pdf, /\/Encrypt\s+5\s+700\s+R/)
    assert.equal(pdf.includes(contents), false)

    await worker.request({ command: 'close', documentId })
    await assert.rejects(worker.request({ ...open, password: undefined }, saved), { code: 'pdf/password-required' })
    await worker.request(open, saved)
    assert.deepEqual((await worker.request(security)).value, before)
    assert.equal((await worker.request({ command: 'documentInfo', documentId })).value.title, 'Protected generations')
    assert.equal((await worker.request(annotations)).value.annotations[0]?.contents, contents)
  })
}
