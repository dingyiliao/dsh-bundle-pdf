import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { NativeWorker } from '../src/engine/host/native-worker.ts'
import { classicPdf } from './native-fixture.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'

const executable = process.env.DSH_PDF_NATIVE_HELPER
  ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const skip = !existsSync(executable)

function frame(json: string): Buffer {
  const bytes = Buffer.from(json)
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(bytes.length, 0)
  return Buffer.concat([prefix, bytes])
}

function runHelper(input: Buffer): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, [], { cwd: dirname(executable), stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolveRun({ code, stdout: Buffer.concat(stdout), stderr }))
    child.stdin.end(input)
  })
}

test('native worker rejects malformed frames and invalid request identities', { skip }, async () => {
  const invalidLength = Buffer.alloc(8)
  const malformed = await runHelper(invalidLength)
  assert.match(malformed.stderr, /Invalid native frame length/)

  const incomplete = Buffer.alloc(8)
  incomplete.writeUInt32LE(10, 0)
  const truncated = await runHelper(Buffer.concat([incomplete, Buffer.from('{')]))
  assert.equal(truncated.code, 0)

  const missingIdentity = await runHelper(frame('{}'))
  assert.equal(missingIdentity.code, 0)
  assert.match(missingIdentity.stdout.toString('utf8'), /Request identity is required/)

  const invalidJson = await runHelper(frame('{bad'))
  assert.equal(invalidJson.code, 0)
  assert.match(invalidJson.stdout.toString('utf8'), /Invalid native command/)
})

test('native links expose quadrilateral geometry and render handles all quarter turns', { skip }, async () => {
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [4 0 R] >>',
    '<< /Type /Annot /Subtype /Link /Rect [20 40 120 60] /QuadPoints [20 60 120 60 20 40 120 40] /A << /S /URI /URI (https://example.com) >> >>',
  ])
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'edge' }, pdf)
    const links = await worker.request({ command: 'links', documentId: 'edge', pageIndex: 0 })
    assert.equal((links.value as Array<{ quadPoints?: number[] }>)[0]?.quadPoints?.length, 8)
    for (const rotation of [180, 270]) {
      const rendered = await worker.request({ command: 'render', documentId: 'edge', pageIndex: 0,
        rotation, rasterWidth: 100, rasterHeight: 100, x: 0, y: 0, width: 100, height: 100 })
      assert.ok(rendered.bytes.byteLength > 0)
    }
  } finally { await worker.dispose() }
})
test('native worker reports an unappliable outline destination', { skip }, async () => {
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>',
  ])
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.request({ command: 'open', documentId: 'outline-error' }, pdf)
    await assert.rejects(worker.request({ command: 'applyOutlines', documentId: 'outline-error',
      entries: [{ id: 'bad', parentIndex: -1, title: 'Bad', pageIndex: 99999 }] }),
    /native-outline|outline|Invalid native command/)
  } finally { await worker.dispose() }
})

