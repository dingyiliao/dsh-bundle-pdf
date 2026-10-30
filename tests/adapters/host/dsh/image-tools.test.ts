import assert from 'node:assert/strict'
import test from 'node:test'
import { registerPdfPageRenderTool } from '../../../../src/adapters/host/dsh/image-tools.ts'
import { HostOcrService } from '../../../../src/modules/ocr/index.ts'
import { evidenceSha256 } from '../../../../src/modules/evidence/provenance.ts'
import type { HostWorkspaceSnapshot } from '../../../../src/modules/working-copy/index.ts'

const signal = new AbortController().signal
interface Tool {
  name: string
  execute(raw: unknown, exec: unknown): Promise<Record<string, unknown>>
  output: { render(raw: unknown, result: unknown): Array<{ type: string }> }
}
function fixture() {
  const png = new Uint8Array([137, 80, 78, 71])
  let snapshot = { id: 'doc', path: '/paper.pdf', bytes: new Uint8Array([1, 2, 3]), sourceVersion: 'fs-1',
    contentVersion: 'content-1', revision: 1, document: { pageCount: 2, annotations: [] } } as unknown as HostWorkspaceSnapshot
  let diskDigest = evidenceSha256(snapshot.bytes), pins = 0, recognitions = 0, vision = false, dimensionsCorrect = true
  const captures: Array<Record<string, unknown>> = []
  const ocr = new HostOcrService(() => 'local')
  ocr.register({ descriptor: { id: 'local', name: 'Local', version: '1', execution: 'local', geometry: [], confidence: false },
    async availability() { return { status: 'available' } },
    async recognize() {
      assert.equal(pins, 1, 'the producer document must stay pinned for the full OCR operation')
      recognitions++
      return { text: 'Recognized text', status: 'complete', blocks: [], lines: [], words: [], confidence: null, coverage: [], warnings: [] }
    },
  })
  let tool: Tool | undefined
  registerPdfPageRenderTool({
    ctx: { get(name: string) { return name === 'ocr' ? ocr : name === 'attachments' ? {
      imageLimits: { mediaTypes: ['image/png'] },
      async saveImage() { return { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: png.length,
        width: dimensionsCorrect ? 2 : 1, height: 2 } },
    } : undefined }, tools: { register(definition: Tool) { tool = definition; return () => {} } } } as never,
    workspaces: { readSnapshot(sessionId: string) {
      if (sessionId !== 'session') throw Object.assign(new Error('Foreign PDF'), { code: 'pdf/session-mismatch' })
      return snapshot
    }, async acquire(sessionId: string) {
      assert.equal(sessionId, 'session'); pins++
      return () => { pins-- }
    } } as never,
    pages: { async renderPage() { return { snapshot, png, width: 2, height: 2 } } },
    imageEvidence: { async mint(_session: string, capture: Record<string, unknown>) {
      captures.push(capture); return { ...capture, refId: `pdfref-${captures.length}` }
    } } as never,
    sourceFiles: { async read() { return { path: snapshot.path, version: diskDigest } } } as never,
    touch() {}, async requireVisualModel() {
      if (!vision) throw Object.assign(new Error('Text model'), { code: 'pdf/image-input-unsupported' })
    },
  })
  return { get tool() { return tool! }, ocr, captures,
    execution: { agent: { session: { id: 'session' } }, signal },
    state() { return { pins, recognitions } },
    setVision(value: boolean) { vision = value }, setDimensions(value: boolean) { dimensionsCorrect = value },
    changeDraft() { snapshot = { ...snapshot, revision: snapshot.revision + 1 } },
    changeDisk() { diskDigest = `sha256:${'b'.repeat(64)}` },
  }
}

test('page-render tool is pure and text-model handles compose with the shared OCR service', async () => {
  const f = fixture()
  try {
    assert.equal(f.tool.name, 'pdf_page_render')
    const value = await f.tool.execute({ documentId: 'doc', page: 1 }, f.execution)
    assert.equal(value.deliverImage, false)
    assert.match(String(value.imageHandle), /^ocrimg_/)
    assert.deepEqual(f.tool.output.render({}, value).map(block => block.type), ['text'])
    assert.equal(f.state().recognitions, 0)
    const recognized = await f.ocr.recognizeStaged(String(value.imageHandle), 'session', signal)
    assert.equal(recognized.text, 'Recognized text')
    assert.deepEqual(recognized.evidence, { refId: 'pdfref-2', documentId: 'doc', page: 1, snapshotChars: 15, truncated: false })
    assert.equal(f.captures[1]!.source, 'ocr-text')
    assert.equal(f.state().pins, 0)
    await assert.rejects(f.ocr.recognizeStaged(String(value.imageHandle), 'other', signal), /another session/)
    await assert.rejects(f.tool.execute({ documentId: 'doc', page: 1, question: 'Infer this' }, f.execution), /unrecognized|Unrecognized/)
  } finally { f.ocr.dispose() }
})

test('vision models receive the exact stored image and image metadata failures reject delivery', async () => {
  const f = fixture()
  try {
    f.setVision(true)
    const value = await f.tool.execute({ documentId: 'doc', page: 1 }, f.execution)
    assert.deepEqual(f.tool.output.render({}, value).map(block => block.type), ['text', 'image'])
    f.setDimensions(false)
    await assert.rejects(f.tool.execute({ documentId: 'doc', page: 1 }, f.execution), { code: 'pdf/image-normalized' })
  } finally { f.ocr.dispose() }
})

test('staged PDF images reject changed drafts and disk sources before OCR work', async () => {
  const draft = fixture()
  try {
    const value = await draft.tool.execute({ documentId: 'doc', page: 1 }, draft.execution)
    draft.changeDraft()
    await assert.rejects(draft.ocr.recognizeStaged(String(value.imageHandle), 'session', signal), { code: 'pdf/stale-reader' })
    assert.equal(draft.state().recognitions, 0)
    assert.equal(draft.state().pins, 0)
  } finally { draft.ocr.dispose() }
  const disk = fixture()
  try {
    const value = await disk.tool.execute({ documentId: 'doc', page: 1 }, disk.execution)
    disk.changeDisk()
    await assert.rejects(disk.ocr.recognizeStaged(String(value.imageHandle), 'session', signal), { code: 'pdf/source-conflict' })
    await assert.rejects(disk.tool.execute({ documentId: 'doc', page: 1 }, disk.execution), { code: 'pdf/source-conflict' })
    assert.equal(disk.state().recognitions, 0)
    assert.equal(disk.state().pins, 0)
  } finally { disk.ocr.dispose() }
})
