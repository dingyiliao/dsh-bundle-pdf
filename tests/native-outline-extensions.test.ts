import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { NativeWorker } from '../src/engine/host/native-worker.js'
import { recoverableOutlineFixture } from './fixtures/recoverable-outline.js'
import { nativeTestSubprocess } from './native-test-subprocess.js'

const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
const skip = !existsSync(executable)

test('native outline extension exposes recovered hierarchy and stable destinations', { skip }, async t => {
  const worker = new NativeWorker(executable, nativeTestSubprocess)
  try {
    await worker.ready()
    if (!worker.documentExtensions) return t.skip('Native helper does not expose PDFium extensions')
    await worker.request({ command: 'open', documentId: 'native-outlines' }, await recoverableOutlineFixture())
    const { value } = await worker.request({ command: 'documentOutlines', documentId: 'native-outlines' })
    assert.ok('entries' in value)
    assert.deepEqual(value.entries.map(({ title, parentIndex, pageIndex }) => [title, parentIndex, pageIndex]), [
      ['Imported chapter', -1, 0], ['Imported section', 0, 1], ['Reference', -1, -1],
    ])
  } finally { await worker.dispose() }
})
