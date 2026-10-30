import assert from 'node:assert/strict'
import test from 'node:test'
import { evidenceSha256, renderPageForAgent, type AgentImageServices,
  type AgentPageImagePort } from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../../../src/modules/working-copy/index.ts'

const signal = new AbortController().signal
const png = new Uint8Array([137, 80, 78, 71])
const snapshot = { id: 'doc-1', path: '/paper.pdf', sourceVersion: 'fs-1',
  contentVersion: 'content-1', revision: 1, bytes: new Uint8Array([1, 2, 3]),
  document: { pageCount: 2, annotations: [] } } as unknown as HostWorkspaceSnapshot
const workspaces: WorkingCopyReadPort = { readSnapshot() { return snapshot } }
const imageHandle = 'ocrimg_00000000-0000-4000-8000-000000000000'
function fixture(vision: boolean) {
  let renders = 0, saved = 0, staged = 0, recognized = 0
  const pages: AgentPageImagePort = { async renderPage() {
    renders++
    return { snapshot, png, width: 2, height: 2 }
  } }
  const services: AgentImageServices = {
    ocr: () => ({ selectedDescriptor: () => undefined,
      async availability() { throw new Error('Rendering must not probe the OCR backend') },
      async recognize() { recognized++; throw new Error('Rendering must not recognize') },
      async stageImage(request) { staged++; assert.deepEqual(request.image, png); return imageHandle },
    }),
    attachments: () => ({ imageLimits: { mediaTypes: ['image/png'] },
      async saveImage() { saved++; return { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png' as const,
        bytes: png.length, width: 2, height: 2 } } }),
    async requireVisualModel() {
      if (!vision) throw Object.assign(new Error('Text-only model'), { code: 'pdf/image-input-unsupported' })
    },
  }
  return { pages, services, counters: () => ({ renders, saved, staged, recognized }) }
}

test('pure page rendering gives a text-only model an image handle without claiming image delivery', async () => {
  const f = fixture(false)
  const result = await renderPageForAgent(workspaces, f.pages, f.services, 'session-1', snapshot.id, 1, 512, signal)
  assert.equal(result.deliverImage, false)
  assert.equal(result.imageHandle, imageHandle)
  assert.equal(result.evidenceSource.kind, 'direct-image')
  assert.match(result.evidenceSource.limitations.join(' '), /has not received its pixels/)
  assert.deepEqual(f.counters(), { renders: 1, saved: 1, staged: 1, recognized: 0 })
})

test('pure page rendering permits vision delivery and attests the stored image digest', async () => {
  const f = fixture(true)
  const result = await renderPageForAgent(workspaces, f.pages, f.services, 'session-1', snapshot.id, 1, undefined, signal)
  assert.equal(result.deliverImage, true)
  assert.equal(result.evidenceSource.renderedImageSha256, evidenceSha256(png))
  assert.equal(result.evidenceSource.storedImageSha256, `sha256:${'a'.repeat(64)}`)
  assert.deepEqual(f.counters(), { renders: 1, saved: 1, staged: 1, recognized: 0 })
})

test('unknown model routes produce a handle without swallowing unrelated capability errors', async () => {
  const f = fixture(true)
  f.services.requireVisualModel = async () => { throw Object.assign(new Error('Unknown route'), { code: 'pdf/image-route-unknown' }) }
  assert.equal((await renderPageForAgent(workspaces, f.pages, f.services, 's', snapshot.id, 1, 512, signal)).deliverImage, false)
  f.services.requireVisualModel = async () => { throw new Error('Service failed') }
  await assert.rejects(renderPageForAgent(workspaces, f.pages, f.services, 's', snapshot.id, 1, 512, signal), /Service failed/)
})

test('image production rejects missing PNG storage and normalized dimensions', async () => {
  const f = fixture(true)
  f.services.attachments = () => undefined
  await assert.rejects(renderPageForAgent(workspaces, f.pages, f.services, 's', snapshot.id, 1, 512, signal), { code: 'pdf/attachment-unavailable' })
  assert.equal(f.counters().renders, 0)
  f.services.attachments = () => ({ imageLimits: { mediaTypes: [] }, async saveImage() { throw new Error('unreachable') } })
  await assert.rejects(renderPageForAgent(workspaces, f.pages, f.services, 's', snapshot.id, 1, 512, signal), { code: 'pdf/image-type-unsupported' })
  f.services.attachments = () => ({ imageLimits: { mediaTypes: ['image/png'] }, async saveImage() {
    return { attachmentId: 'image', mediaType: 'image/png', bytes: 4, width: 1, height: 2 }
  } })
  await assert.rejects(renderPageForAgent(workspaces, f.pages, f.services, 's', snapshot.id, 1, 512, signal), { code: 'pdf/image-normalized' })
})

test('page changes while producing an image reject the stale result', async () => {
  const f = fixture(true)
  const changed = { ...snapshot, revision: 2 }
  const changing: WorkingCopyReadPort = { readSnapshot: () => changed }
  await assert.rejects(renderPageForAgent(changing, f.pages, f.services, 's', snapshot.id, 1, 512, signal), { code: 'pdf/stale-reader' })
  assert.equal(f.counters().saved, 0)
})

test('optional image staging failure preserves visual delivery with an explicit missing-handle warning', async () => {
  const f = fixture(true)
  f.services.ocr = () => ({ selectedDescriptor: () => undefined,
    async availability() { return { status: 'unavailable' } }, async recognize() { throw new Error('unreachable') },
    async stageImage() { throw new Error('Optional store failed') },
  })
  const result = await renderPageForAgent(workspaces, f.pages, f.services, 's', snapshot.id, 1, 512, signal)
  assert.equal(result.deliverImage, true)
  assert.equal(result.imageHandle, undefined)
  assert.match(result.imageHandleWarning ?? '', /no consumable image handle/)
  f.services.ocr = () => ({ selectedDescriptor: () => undefined,
    async availability() { return { status: 'available' } }, async recognize() { throw new Error('unreachable') },
    async stageImage() { throw Object.assign(new Error('Source changed'), { code: 'pdf/source-conflict' }) },
  })
  await assert.rejects(renderPageForAgent(workspaces, f.pages, f.services, 's', snapshot.id, 1, 512, signal), { code: 'pdf/source-conflict' })
})

test('page rendering remains available without the optional image-handle plugin and reports its missing consumers', async () => {
  for (const vision of [true, false]) {
    const f = fixture(vision)
    f.services.ocr = () => undefined
    const result = await renderPageForAgent(workspaces, f.pages, f.services, 's', snapshot.id, 1, 512, signal)
    assert.equal(result.deliverImage, vision)
    assert.equal(result.image.width, 2)
    assert.equal(result.image.height, 2)
    assert.equal(result.imageHandle, undefined)
    assert.match(result.imageHandleWarning ?? '', /image-handle service is not installed/)
    assert.match(result.imageHandleWarning ?? '', /OCR and auxiliary image tools cannot consume/)
    assert.deepEqual(f.counters(), { renders: 1, saved: 1, staged: 0, recognized: 0 })
  }
})
