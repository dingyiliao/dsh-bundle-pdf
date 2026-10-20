import assert from 'node:assert/strict'
import test from 'node:test'
import { evidenceNavigationRequestSchema, evidenceSha256,
  revalidateEvidenceNavigation } from '../../../src/modules/evidence/index.ts'
import type { AgentPageReadPort } from '../../../src/modules/evidence/index.ts'
import type { HostWorkspaceSnapshot, WorkingCopyReadPort } from '../../../src/modules/working-copy/index.ts'

const text = 'A useful sentence about the result.'
const startUtf16 = 2
const excerpt = 'useful sentence'
const sourcePath = '/papers/result.pdf'
const sessionId = 'reader-session'
const documentId = 'working-copy'
const signal = new AbortController().signal
const content = { items: [{ str: text, transform: [1, 0, 0, 1, 0, 0], width: 100,
  height: 10, dir: 'ltr', fontName: 'Helvetica', hasEOL: false }], styles: {}, lang: null }

function snapshot(bytes: number[], revision: number, path = sourcePath): HostWorkspaceSnapshot {
  return { id: documentId, path, bytes: new Uint8Array(bytes), revision,
    contentVersion: 'new-occurrence', sourceVersion: `source-${revision}`,
    document: { pageCount: 1 } } as HostWorkspaceSnapshot
}

const request = evidenceNavigationRequestSchema.parse({ action: 'revalidate', sessionId, documentId,
  sourcePathDigest: evidenceSha256(sourcePath), page: 1, pageTextDigest: evidenceSha256(text),
  startUtf16, endUtf16: startUtf16 + excerpt.length, excerpt,
  excerptSha256: evidenceSha256(excerpt) })

function harness(initial: HostWorkspaceSnapshot, pageText = content) {
  let current = initial
  let sourceBytes = initial.bytes
  const workspaces: WorkingCopyReadPort = { readSnapshot(caller, id) {
    if (caller !== sessionId || id !== documentId) throw new Error('Working copy belongs to another session')
    return current
  } }
  const pages: AgentPageReadPort = { async readPageText(caller, id) {
    workspaces.readSnapshot(caller, id)
    return { snapshot: current, content: pageText as never }
  } }
  const readSource = async (caller: string, observed: HostWorkspaceSnapshot, currentSignal: AbortSignal) => {
    currentSignal.throwIfAborted()
    assert.equal(caller, sessionId)
    return { path: observed.path, digest: evidenceSha256(sourceBytes) }
  }
  return { workspaces, pages, readSource,
    set(value: HostWorkspaceSnapshot) { current = value; sourceBytes = value.bytes },
    overwriteSource() { sourceBytes = new Uint8Array([1, 2, 3, 4]) },
  }
}

test('tool-card revalidation permits an annotation-only save after reopening the same text', async () => {
  const h = harness(snapshot([9, 8, 7], 4))
  const first = await revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal, h.readSource)
  assert.equal(first.status, 'valid')
  h.set(snapshot([9, 8, 7, 6], 5))
  const afterSave = await revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal, h.readSource)
  assert.equal(afterSave.status, 'valid')
  assert.notEqual(first.sourceDigest, afterSave.sourceDigest)
  assert.equal(afterSave.revision, 5)
})

test('revalidation rejects a changed path or page text even if the short excerpt survives', async () => {
  const h = harness(snapshot([9, 8, 7], 4))
  h.set(snapshot([9, 8, 7], 4, '/papers/other.pdf'))
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal, h.readSource),
    { code: 'pdf/stale-reader' })
  const changed = harness(snapshot([9, 8, 7], 4), { ...content,
    items: [{ ...content.items[0], str: `${text} Additional text.` }] })
  await assert.rejects(revalidateEvidenceNavigation(changed.workspaces, changed.pages, request, signal,
    changed.readSource),
    { code: 'pdf/stale-reader' })
})

test('revalidation is session-fenced and rejects a concurrent source change', async () => {
  const h = harness(snapshot([9, 8, 7], 4))
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages,
    { ...request, sessionId: 'another-session' }, signal, h.readSource), /another session/)
  const pages: AgentPageReadPort = { async readPageText() {
    const old = h.workspaces.readSnapshot(sessionId, documentId)
    h.set(snapshot([1, 2, 3], 5))
    return { snapshot: old, content: content as never }
  } }
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, pages, request, signal, h.readSource),
    { code: 'pdf/stale-reader' })
})

test('text navigation rejects an external overwrite without reopening the working copy', async () => {
  const h = harness(snapshot([9, 8, 7], 4))
  assert.equal((await revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal,
    h.readSource)).status, 'valid')
  h.overwriteSource()
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal,
    h.readSource), { code: 'pdf/stale-reader' })
  assert.equal(h.workspaces.readSnapshot(sessionId, documentId).revision, 4)
})

test('text navigation rejects a concurrent external overwrite and respects cancellation', async () => {
  const h = harness(snapshot([9, 8, 7], 4))
  let checks = 0
  const readSource: typeof h.readSource = async (...args) => {
    checks++
    if (checks === 2) h.overwriteSource()
    return h.readSource(...args)
  }
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request, signal,
    readSource), { code: 'pdf/stale-reader' })
  assert.equal(checks, 2)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request,
    cancelled.signal, h.readSource), /abort/i)
  const inFlight = new AbortController()
  await assert.rejects(revalidateEvidenceNavigation(h.workspaces, h.pages, request,
    inFlight.signal, async (...args) => {
      inFlight.abort()
      return h.readSource(...args)
    }), /abort/i)
})

test('navigation request bounds the excerpt and requires exact UTF-16 span', () => {
  assert.equal(evidenceNavigationRequestSchema.safeParse({ ...request, endUtf16: 900 }).success, false)
  assert.equal(evidenceNavigationRequestSchema.safeParse({ ...request, excerpt: 'x'.repeat(8001) }).success, false)
})
