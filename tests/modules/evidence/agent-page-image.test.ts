import assert from 'node:assert/strict'
import test from 'node:test'
import { evidenceSha256, ocrPageForAgent, renderPageForAgent, type AgentImageServices,
  type AgentPageImagePort } from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../../../src/modules/working-copy/index.ts'

const signal = new AbortController().signal
const png = new Uint8Array([137, 80, 78, 71])
const snapshot = { id: 'doc-1', path: '/paper.pdf', sourceVersion: 'fs-1',
  contentVersion: 'content-1', revision: 1, bytes: new Uint8Array([1, 2, 3]),
  document: { pageCount: 2, annotations: [] } } as unknown as HostWorkspaceSnapshot
const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }

test('configured derived-text page understanding stays text-only without attachment storage', async () => {
  let renders = 0, visualChecks = 0
  const pages: AgentPageImagePort = { async renderPage() {
    renders++
    return { snapshot, png, width: 2, height: 2 }
  } }
  const services: AgentImageServices = {
    imageUnderstanding: () => ({
      async availability() { return { status: 'available', kind: 'derived-text' } as const },
      async prepare() { return { kind: 'derived-text', text: 'A diagram',
        provenance: { backendId: 'vision', mode: 'image-description' } } as const },
    }),
    attachments: () => undefined, ocr: () => undefined,
    async requireVisualModel() { visualChecks++ },
  }
  const result = await renderPageForAgent(workspaces, pages, services, 'session-1', snapshot.id,
    1, 512, 'configured-backend', 'What is shown?', signal)
  assert.equal('kind' in result && result.kind, 'derived-text')
  assert.equal(result.evidenceSource.kind, 'auxiliary-vision')
  assert.equal(renders, 1)
  assert.equal(visualChecks, 0)
})

test('auxiliary image descriptions are bounded in UTF-16 and UTF-8 before model delivery', async () => {
  const description = '图😀'.repeat(4_000)
  const pages: AgentPageImagePort = { async renderPage() { return { snapshot, png, width: 2, height: 2 } } }
  const services: AgentImageServices = {
    imageUnderstanding: () => ({
      async availability() { return { status: 'available', kind: 'derived-text' } as const },
      async prepare() { return { kind: 'derived-text', text: description,
        provenance: { backendId: 'vision', mode: 'image-description' },
        limitations: 'L'.repeat(10_000) } as const },
    }),
    attachments: () => undefined, ocr: () => undefined,
    async requireVisualModel() { throw new Error('Text-only models use derived text') },
  }
  const result = await renderPageForAgent(workspaces, pages, services, 'session-1', snapshot.id,
    1, 512, 'configured-backend', undefined, signal)
  if (!('kind' in result)) throw new Error('Expected a derived-text result')
  assert.equal(result.kind, 'derived-text')
  assert.equal(result.totalChars, description.length)
  assert.equal(result.truncated, true)
  assert.ok(result.text.length <= 8_000)
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 16_000)
  assert.doesNotMatch(result.text, /[\uD800-\uDBFF]$/u)
  assert.equal(result.evidenceSource.snapshotSha256, evidenceSha256(result.text),
    'provenance must bind the exact text delivered to the model')
  assert.ok((result.limitations?.length ?? 0) < 650)
  assert.match(result.limitations ?? '', /truncated/i)
})

test('direct-image page delivery gates vision and PNG attachments before rendering', async () => {
  let renders = 0, saved = 0, visionAllowed = false
  const pages: AgentPageImagePort = { async renderPage() {
    renders++
    return { snapshot, png, width: 2, height: 2 }
  } }
  const services: AgentImageServices = {
    imageUnderstanding: () => undefined, ocr: () => undefined,
    attachments: () => ({ imageLimits: { mediaTypes: ['image/png'] },
      async saveImage() { saved++; return { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png' as const,
        bytes: png.length, width: 2, height: 2 } } }),
    async requireVisualModel() {
      if (!visionAllowed) throw Object.assign(new Error('Text-only model'), { code: 'pdf/image-input-unsupported' })
    },
  }
  await assert.rejects(renderPageForAgent(workspaces, pages, services, 'session-1', snapshot.id,
    1, undefined, undefined, undefined, signal), { code: 'pdf/image-input-unsupported' })
  assert.equal(renders, 0)
  visionAllowed = true
  const result = await renderPageForAgent(workspaces, pages, services, 'session-1', snapshot.id,
    1, undefined, undefined, undefined, signal)
  assert.equal(result.evidenceSource.kind, 'direct-image')
  assert.equal(result.evidenceSource.renderedImageSha256, evidenceSha256(png))
  assert.equal(result.evidenceSource.storedImageSha256, `sha256:${'a'.repeat(64)}`,
    'attachment storage may normalize bytes; model-visible digest must follow its returned ID')
  assert.equal(renders, 1)
  assert.equal(saved, 1)
})

test('OCR page use case explicitly reports an absent backend before rendering', async () => {
  const pages: AgentPageImagePort = { async renderPage() { throw new Error('Unreachable render') } }
  await assert.rejects(ocrPageForAgent(workspaces, pages, undefined, 'session-1', snapshot.id,
    1, undefined, undefined, signal), { code: 'pdf/ocr-unavailable' })
})
