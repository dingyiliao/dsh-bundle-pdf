import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createLocalFiles, PdfFileError } from '../src/host/local-files.ts'
import type { PdfAgent } from '../src/host/transport.ts'

function fileContext(root: string, mapHostPath: (path: string) => string | undefined): Parameters<typeof createLocalFiles>[0] {
  return {
    fs: {
      async resolve(path, options) {
        const absolute = resolve(options?.cwd ?? root, path)
        return { targetKey: absolute, displayPath: absolute }
      },
      processPath: target => String(target.targetKey),
      processPathFromHostPath: mapHostPath,
      contains: (parent, child) => String(child.targetKey).startsWith(String(parent.targetKey)),
      async stat(target) {
        const info = await stat(String(target.targetKey))
        return { version: `size:${info.size}`, type: 'file', size: info.size }
      },
      async readBytes(target, _signal, maxBytes) {
        const bytes = await readFile(String(target.targetKey))
        assert.ok(bytes.byteLength <= maxBytes)
        return bytes
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) },
  }
}

test('host-shared filesystem capability permits local reads across package identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pdf-local-files-'))
  try {
    const path = join(root, 'example.pdf')
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])
    await writeFile(path, bytes)
    const files = createLocalFiles(fileContext(root, hostPath => resolve(hostPath)))
    const agent: PdfAgent = { session: { id: 'local-files-test', header: { cwd: root } } }
    const result = await files.read(agent, 'example.pdf')
    assert.equal(result.path, path)
    assert.deepEqual([...result.bytes], [...bytes])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('filesystem without a shared host path is rejected before reading a PDF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pdf-remote-files-'))
  try {
    const agent: PdfAgent = { session: { id: 'remote-files-test', header: { cwd: root } } }
    for (const map of [() => undefined, () => join(root, 'different.pdf')]) {
      const files = createLocalFiles(fileContext(root, map))
      await assert.rejects(files.read(agent, 'example.pdf'),
        (error: unknown) => error instanceof PdfFileError && error.code === 'PDF_PROVIDER_UNSUPPORTED')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
